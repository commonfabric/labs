/**
 * The version of what applying a patch produces: the document `applyPatch()`
 * (`v2/patch.ts`) returns for a given base and list of operations, including
 * which operations it refuses and how it decides equality for `add-unique`
 * and `remove-by-value` (`valueEqual()` in `@commonfabric/data-model`).
 *
 * A server advertises it as `MemoryProtocolFlags.patchReplayVersion`, and a
 * client names a `replayBaseSeq` on a patch only to a server advertising the
 * version it was built with. That is what lets the server leave the result
 * out of the writer's sync frame: the writer replays the same operations over
 * the same document and gets the same result. A client and a server are
 * deployed separately, so a change to what any operation produces, for any
 * input, takes a new version number; otherwise a client built before the
 * change replays to a document the server does not hold, and nothing sends it
 * the server's.
 *
 * `test/v2-patch-semantics.test.ts` records what this version produces over a
 * corpus of operations, and fails when an output changes; the version changes
 * with it.
 */
export const PATCH_SEMANTICS_VERSION = 1;
