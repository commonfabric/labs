/**
 * Builder-side replayability registry for `type: "ref"` builtin modules.
 *
 * At pattern-build time a builtin appears only as a string `implementation`
 * name — the runtime's module registrations (`builtins/index.ts`,
 * `registerBuiltins`) are invisible to the builder — so the computed-cell
 * classifier (`pattern.ts`, `assignComputedCellKinds`) decides replayability
 * by NAME, against this registry. Names fail STRICT: any name not listed in
 * `REPLAYABLE_BUILTIN_REFS` is treated as non-replayable and disqualifies
 * both the cells the node writes and the cell roots bound into its inputs
 * (non-replayable builtins may write through their inputs — e.g. `llmDialog`
 * pushes onto `inputs.key("messages")`).
 *
 * This is deliberately NOT derived from `isEffect`, which carries scheduler
 * semantics — a demand root — rather than anything about replay.
 *
 * Reciprocal note lives at `builtins/index.ts` (`registerBuiltins`): when a
 * builtin is added there, record it here — either as replayable or in the
 * documented non-replayable list below.
 */

/**
 * Builtin refs whose execution is a pure, replayable derivation of their
 * inputs: re-running the node deterministically reproduces every write it
 * makes, so a dropped write to one of its output cells loses nothing. Only
 * these names may write computed-kind cells.
 *
 * Known NON-replayable builtins (async and/or externally effectful — must
 * never be added here): `fetchBinary`, `fetchText`, `fetchJson`,
 * `fetchJsonUnchecked`, `fetchProgram`, `streamData`, `llm`, `llmDialog`,
 * `compileAndRun`, `generateObject`, `generateText`, `agent` (stages a sink
 * request and creates a run record after commit), `navigateTo`, `wish`,
 * `sqliteQuery` (server round-trip, like `llm`),
 * `inspectConfLabel` (reads stored label metadata — ambient CFC state that
 * changes independently of the node's inputs), `cellFromUrl` (resolves a
 * space name against the runtime's cache, which is ambient in the same sense,
 * and is on its way to probing hosts over the network).
 */
export const REPLAYABLE_BUILTIN_REFS: ReadonlySet<string> = new Set([
  "aggregate",
  "aggregateNode",
  "collectionIndex",
  "collectionIndexKeys",
  "collectionIndexMember",
  "map",
  "filter",
  "flatMap",
  "ifElse",
  "when",
  "unless",
  "sqliteDatabase",
  "str",
]);

/**
 * Replayable builtins that take an op sub-pattern as an argument. Their
 * OUTPUTS qualify as computed writes (the mapping itself replays
 * deterministically), but every cell root bound into their INPUTS
 * disqualifies: the op sub-pattern may contain handlers that write the
 * source elements, and those handlers are invisible at this classification
 * layer.
 */
export const SUBPATTERN_ARGUMENT_BUILTIN_REFS: ReadonlySet<string> = new Set([
  "map",
  "filter",
  "flatMap",
]);
