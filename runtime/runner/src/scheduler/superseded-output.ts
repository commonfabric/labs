import { getLogger } from "@commonfabric/logger";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import type { SupersededOutput } from "../executor/wave.ts";
import type { Runtime } from "../runtime.ts";
import type { URI } from "../storage/interface.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

/**
 * Returns whether a derivation whose writes a wave dropped as superseded still
 * owes them, which is when a commit that superseded one left the document
 * holding no value (serving-loop.md §3d). A client's piece start is such a
 * commit: it stores a computed document's structure and leaves its value to the
 * serving runtime. An authored value is what readers reconverge from, so it
 * holds until the derivation's inputs next change.
 *
 * That is decided on what the commit wrote, so this resolves once the replica
 * has taken every commit that superseded a write. A run started sooner could
 * read past an authored value that arrives after this returns, and overwrite
 * it.
 */
export async function supersededOutputsOwed(
  runtime: Runtime,
  outputs: readonly SupersededOutput[],
): Promise<boolean> {
  const owed = await Promise.all(
    outputs.map((output) => holdsNoValueOnceTaken(runtime, output)),
  );
  return owed.includes(true);
}

/**
 * Helper for {@link supersededOutputsOwed}, which waits for the replica to take
 * the commit that superseded `output`, and returns whether the document then
 * exists with no value.
 */
async function holdsNoValueOnceTaken(
  runtime: Runtime,
  output: SupersededOutput,
): Promise<boolean> {
  const { space, seq, scope, scopeKeyIdentity } = output;
  const id = output.id as URI;
  const manager = runtime.storageManager;
  const { replica } = manager.open(space);
  const taken = () =>
    replica.confirmedDocumentSeq(id, scope, scopeKeyIdentity) >= seq;
  if (!taken()) {
    // A commit reaches the replica by re-reading what it holds under the store
    // read-through, and otherwise by the frame the document's watch delivers,
    // so a document it holds without a watch has to be named here. A frame
    // still on its way wakes the wait below.
    manager.integrateStoreWrites?.(space, [{
      id,
      scopeKey: resolveScopeKey(
        scope,
        scopeKeyIdentity ?? runtime.scopeKeyIdentity,
      ),
    }]);
    if (!taken()) {
      try {
        await manager.syncCell(
          runtime.getCellFromLink({
            space,
            id: id as never,
            scope: (scope ?? "space") as never,
            path: [],
          }),
          scopeKeyIdentity === undefined ? undefined : { scopeKeyIdentity },
        );
      } catch (error) {
        logger.warn("superseded-output-load-failed", () => [
          `Could not load ${id} to take the commit that superseded a ` +
          "derivation's write to it; the derivation waits for its frame",
          error,
        ]);
      }
    }
    if (!taken()) {
      await new Promise<void>((resolve) => {
        manager.subscribe({
          next: () => {
            if (!taken()) return { done: false };
            resolve();
            return { done: true };
          },
        });
      });
    }
  }
  const document = replica.getDocument(id, scope, scopeKeyIdentity);
  return document !== undefined && !("value" in document);
}
