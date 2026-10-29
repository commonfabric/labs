// Verb listing marks, producer 2 (verb contract WS-F): `@deprecated` JSDoc on
// a STREAM-valued property lowers to standard JSON Schema `deprecated: true`,
// which `cf piece verbs` hides by default while the verb stays callable. The
// mark is stream-scoped: a deprecated DATA property is compat surface, not a
// verb, and stays unmarked.
interface SchemaRoot {
  /** @deprecated Compatibility mutation for callers of the previous board. */
  setLegacyName: Stream<string>;

  /** Current verb beside it, unmarked. */
  rename: Stream<string>;

  /** @deprecated Compatibility shadow, mirrored for old consumers — but data,
   * so no mark. */
  legacyName: string;
}
