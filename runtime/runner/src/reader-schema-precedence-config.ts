/**
 * Ambient switch for reader-precedence link-schema combination
 * (`combineSchemaForLink` in traverse.ts): ON by default; an explicit
 * `false` restores the strict pseudo-intersection at link crossings.
 *
 * Plain last-write-wins module state: each Runtime construction sets it
 * from its resolved option. Dispose deliberately does NOT reset it — a
 * server runs one serving runtime per space and disposes idle ones while
 * the rest live, so a teardown reset would lift a rollback out from under
 * them. A test process gets differing flag states by constructing (every
 * construction sets, an unset option setting the default), and the
 * explicit reset below serves unit tests of this module.
 */

let readerSchemaPrecedenceEnabled = true;

export function setReaderSchemaPrecedenceConfig(value?: boolean): void {
  readerSchemaPrecedenceEnabled = value ?? true;
}

export function getReaderSchemaPrecedenceConfig(): boolean {
  return readerSchemaPrecedenceEnabled;
}

export function resetReaderSchemaPrecedenceConfig(): void {
  readerSchemaPrecedenceEnabled = true;
}
