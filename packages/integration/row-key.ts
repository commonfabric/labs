/**
 * One string for a row's key fields, built the same way by a test that waits
 * for a list to reach a state and by the wait that reads the list: the JSON
 * array of the fields' string forms. Distinct tuples of string forms have
 * distinct keys; a number and its string representation share a key.
 * A field is a value the row holds at a path, so a row keyed by who wrote it
 * names a field of theirs, such as a display name, rather than the link,
 * which crosses a worker boundary as the value it reaches.
 */
export function rowKeyOf(fields: readonly unknown[]): string {
  return JSON.stringify(fields.map(String));
}
