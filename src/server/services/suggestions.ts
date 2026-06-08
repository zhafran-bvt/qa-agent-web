export function buildTicketSuggestionsJql(qaAssigneeField: string): string {
  return [
    `${qaAssigneeField} = currentUser()`,
    'AND type = Task',
    'AND statusCategory != Done',
    'AND labels = frontend',
    'AND sprint in openSprints()',
    'ORDER BY updated DESC, created DESC',
  ].join(' ');
}

export function buildSprintBurndownJql(): string {
  return ['issuetype IN (Bug, Task)', 'AND sprint IN openSprints()', 'AND project = ORB', 'AND type IN (Task, Bug)', 'ORDER BY updated DESC, created DESC'].join(' ');
}
