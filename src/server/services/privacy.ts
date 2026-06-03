import {
  getAccessibleResources,
  getCurrentUserProfile,
  refreshAccessToken,
  reportPersonalData,
  type AccessibleResource,
} from './atlassian';
import type { Logger } from './logger';
import type {
  Persistence,
  PrivacyReportingAccount,
  SessionRecord,
} from './persistence';

const DEFAULT_CYCLE_DAYS = 7;
const MAX_REPORT_BATCH = 90;

export async function runPrivacyReportingCycle({
  persistence,
  atlassianConfig,
  logger,
}: {
  persistence: Persistence;
  atlassianConfig: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: string;
  };
  logger: Logger;
}): Promise<void> {
  const now = Date.now();
  const status = await persistence.getPrivacyReportingStatus(DEFAULT_CYCLE_DAYS, now);
  const dueAccounts = await persistence.listPrivacyReportingAccountsDue(now, status.lastCyclePeriodDays || DEFAULT_CYCLE_DAYS, MAX_REPORT_BATCH);
  if (!dueAccounts.length) {
    logger.debug('privacy.reporting.no_due_accounts');
    return;
  }

  const ownerSession = await persistence.getPrivacyReportingSession();
  if (!ownerSession) {
    const message = 'No reportable Atlassian session with accountId and refresh token is available.';
    await persistence.recordPrivacyReportingRunError(message, now);
    logger.warn('privacy.reporting.skipped_no_session', { dueAccountCount: dueAccounts.length });
    return;
  }

  const refreshedOwner = await refreshSessionRecord(ownerSession.session, atlassianConfig);
  await persistence.setSession(ownerSession.sid, refreshedOwner);

  const requestAccounts = dueAccounts.map((account) => ({
    accountId: account.accountId,
    updatedAt: new Date(account.retrievedAt).toISOString(),
  }));
  const report = await reportPersonalData(refreshedOwner.accessToken, requestAccounts);
  const cyclePeriodDays = report.cyclePeriodDays || DEFAULT_CYCLE_DAYS;

  const results = report.accounts.map((result) => {
    const account = dueAccounts.find((candidate) => candidate.accountId === result.accountId);
    const ageSeconds = Math.max(0, Math.floor((now - (account?.retrievedAt || now)) / 1000));
    return {
      accountId: result.accountId,
      ageSeconds,
      status: result.status,
    } as const;
  });
  await persistence.recordPrivacyReportingRun({
    reportedAt: now,
    cyclePeriodDays,
    results,
  });

  for (const result of results) {
    if (result.status === 'closed') {
      const erased = await persistence.erasePersonalDataForAccount(result.accountId);
      logger.info('privacy.reporting.erased_account', {
        accountId: result.accountId,
        sessionsDeleted: erased.sessionsDeleted,
      });
      continue;
    }
    if (result.status === 'updated') {
      const refreshed = await refreshPersonalDataForAccount(result.accountId, persistence, atlassianConfig);
      logger.info('privacy.reporting.refreshed_account', {
        accountId: result.accountId,
        sessionsUpdated: refreshed,
      });
    }
  }

  logger.info('privacy.reporting.complete', {
    dueAccountCount: dueAccounts.length,
    reportedAccountCount: results.length,
    cyclePeriodDays,
    closedCount: results.filter((result) => result.status === 'closed').length,
    updatedCount: results.filter((result) => result.status === 'updated').length,
  });
}

export function startPrivacyReportingLoop({
  persistence,
  atlassianConfig,
  logger,
  enabled = true,
  intervalMs = 6 * 60 * 60 * 1000,
}: {
  persistence: Persistence;
  atlassianConfig: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: string;
  };
  logger: Logger;
  enabled?: boolean;
  intervalMs?: number;
}): { stop(): void } {
  if (!enabled) {
    logger.info('privacy.reporting.disabled');
    return { stop() {} };
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runPrivacyReportingCycle({ persistence, atlassianConfig, logger });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await persistence.recordPrivacyReportingRunError(message, Date.now());
      logger.error('privacy.reporting.failed', { errorMessage: message });
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, Math.max(60_000, intervalMs));
  handle.unref?.();
  void tick();

  return {
    stop() {
      clearInterval(handle);
    },
  };
}

async function refreshPersonalDataForAccount(
  accountId: string,
  persistence: Persistence,
  atlassianConfig: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: string;
  }
): Promise<number> {
  const sessionEnvelope = await persistence.getPrivacyReportingSessionForAccount(accountId);
  if (!sessionEnvelope) {
    const erased = await persistence.erasePersonalDataForAccount(accountId);
    return erased.sessionsDeleted;
  }

  const refreshedSession = await refreshSessionRecord(sessionEnvelope.session, atlassianConfig);
  const profile = await getCurrentUserProfile(refreshedSession.accessToken).catch(() => null);
  refreshedSession.accountId = profile?.accountId || refreshedSession.accountId || accountId;
  refreshedSession.displayName = profile?.displayName || refreshedSession.displayName || refreshedSession.user;
  refreshedSession.user = profile?.displayName || refreshedSession.user;
  refreshedSession.personalDataRetrievedAt = Date.now();
  await persistence.setSession(sessionEnvelope.sid, refreshedSession);
  const updated = await persistence.refreshPersonalDataForAccount(accountId, {
    displayName: profile?.displayName || refreshedSession.displayName || refreshedSession.user,
    retrievedAt: refreshedSession.personalDataRetrievedAt,
  });
  return updated.sessionsUpdated;
}

async function refreshSessionRecord(
  session: SessionRecord,
  atlassianConfig: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: string;
  }
): Promise<SessionRecord> {
  if (!session.refreshToken) return session;
  const refreshedToken = await refreshAccessToken(atlassianConfig, session.refreshToken);
  const resources = await getAccessibleResources(refreshedToken.access_token);
  const selectedResource = chooseMatchingResource(resources, session.selectedResource, session.cloudId);
  const refreshed: SessionRecord = {
    ...session,
    accessToken: refreshedToken.access_token,
    refreshToken: refreshedToken.refresh_token || session.refreshToken,
    resources,
    selectedResource,
    cloudId: selectedResource?.id || session.cloudId,
    expiresAt: refreshedToken.expires_in ? Date.now() + refreshedToken.expires_in * 1000 : session.expiresAt || null,
  };
  return refreshed;
}

function chooseMatchingResource(
  resources: AccessibleResource[],
  selectedResource: AccessibleResource | null | undefined,
  cloudId: string
): AccessibleResource | null {
  if (selectedResource?.id) {
    const matched = resources.find((resource) => resource.id === selectedResource.id);
    if (matched) return matched;
  }
  const byCloudId = resources.find((resource) => resource.id === cloudId);
  return byCloudId || resources[0] || null;
}
