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
  const owed = () => outputs.every((output) => holdsNoValue(runtime, output));
  const taking = supersedingCommitsTaken(runtime, outputs);
  return taking === undefined ? owed() : taking.then(owed);
}

/**
 * Returns `undefined` when the replica has taken every commit that superseded
 * one of `outputs`, and otherwise a promise that resolves once it has. Once
 * `signal` aborts, the wait stops listening for the commits, and the promise
 * does not resolve.
 */
export function supersedingCommitsTaken(
  runtime: Runtime,
  outputs: readonly SupersededOutput[],
  signal?: AbortSignal,
): Promise<void> | undefined {
  const lagging = outputs.filter((output) => !taken(runtime, output));
  return lagging.length === 0 ? undefined : Promise.all(
    lagging.map((output) => takeSupersedingCommit(runtime, output, signal)),
  ).then(() => {});
}

/**
 * Helper for {@link supersedingCommitsTaken}, which returns whether the
 * replica has taken the commit that superseded `output`.
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
 * Helper for {@link supersedingCommitsTaken}, which resolves once the replica
 * has taken the commit that superseded `output`.
 */
async function takeSupersedingCommit(
  runtime: Runtime,
  output: SupersededOutput,
  signal: AbortSignal | undefined,
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
      `Could not load ${id} to take the commit that superseded a write ` +
      "to it; the wait for that commit goes on until its frame arrives",
      error,
    ]);
  }
  if (taken(runtime, output)) return;
  await new Promise<void>((resolve) => {
    if (signal?.aborted === true) return;
    const subscriber = {
      next: () => {
        if (!taken(runtime, output)) return { done: false };
        signal?.removeEventListener("abort", stop);
        resolve();
        return { done: true };
      },
    };
    const stop = () => manager.unsubscribe?.(subscriber);
    manager.subscribe(subscriber);
    signal?.addEventListener("abort", stop, { once: true });
  });
}
