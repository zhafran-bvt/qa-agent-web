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
