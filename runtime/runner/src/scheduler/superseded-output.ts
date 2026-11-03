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
 * owes them, which is when every commit that superseded one left its document
 * holding no value (serving-loop.md §3d). A client's piece start is such a
 * commit: it stores a computed document's structure and leaves its value to the
 * serving runtime. An authored value is what readers reconverge from, so it
 * holds until the derivation's inputs next change. A run writes all its outputs
 * again, so one document holding a value keeps the whole run from being owed.
 *
 * That is decided on what the commits wrote, so the answer waits until the
 * replica has taken them, and is a promise only when it has not. A run started
 * sooner could read past an authored value that had not arrived, and overwrite
 * it.
 */
export function supersededOutputsOwed(
  runtime: Runtime,
  outputs: readonly SupersededOutput[],
): boolean | Promise<boolean> {
  const lagging = outputs.filter((output) => !taken(runtime, output));
  const owed = () => outputs.every((output) => holdsNoValue(runtime, output));
  return lagging.length === 0 ? owed() : Promise.all(
    lagging.map((output) => takeSupersedingCommit(runtime, output)),
  ).then(owed);
}

/**
 * Helper for {@link supersededOutputsOwed}, which returns whether the replica
 * has taken the commit that superseded `output`.
 */
function taken(runtime: Runtime, output: SupersededOutput): boolean {
  const { space, id, scope, seq, scopeKeyIdentity } = output;
  return runtime.storageManager.open(space).replica.confirmedDocumentSeq(
    id as URI,
    scope,
    scopeKeyIdentity,
  ) >= seq;
}

/**
 * Helper for {@link supersededOutputsOwed}, which returns whether the document
 * exists with no value.
 */
function holdsNoValue(runtime: Runtime, output: SupersededOutput): boolean {
  const { space, id, scope, scopeKeyIdentity } = output;
  const document = runtime.storageManager.open(space).replica.getDocument(
    id as URI,
    scope,
    scopeKeyIdentity,
  );
  return document !== undefined && !("value" in document);
}

/**
 * Helper for {@link supersededOutputsOwed}, which resolves once the replica has
 * taken the commit that superseded `output`.
 */
async function takeSupersedingCommit(
  runtime: Runtime,
  output: SupersededOutput,
): Promise<void> {
  const { space, id, scope, scopeKeyIdentity } = output;
  const manager = runtime.storageManager;
  // A commit reaches the replica by re-reading what it holds under the store
  // read-through, and otherwise by the frame the document's watch delivers, so
  // a document it holds without a watch has to be named here. A frame still on
  // its way wakes the wait below.
  manager.integrateStoreWrites?.(space, [{
    id,
    scopeKey: resolveScopeKey(
      scope,
      scopeKeyIdentity ?? runtime.scopeKeyIdentity,
    ),
  }]);
  if (taken(runtime, output)) return;
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
  if (taken(runtime, output)) return;
  await new Promise<void>((resolve) => {
    manager.subscribe({
      next: () => {
        if (!taken(runtime, output)) return { done: false };
        resolve();
        return { done: true };
      },
    });
  });
}
