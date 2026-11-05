import type {
  CfcConfClause,
  CfcEnforcementMode,
  CfcReadOnExceed,
} from "@commonfabric/runner/cfc";
import { createSession, type Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";

/**
 * An isolated runtime for the render gate's probe, and the reason it exists.
 *
 * The gate renders a second instance of a pattern to see what its `$UI` does.
 * Running that instance in the session's own space is not acceptable, and the
 * reason is stronger than it first appears: `runPersistent` allocates a
 * space-scoped entity and persists the probe's inputs, its piece metadata and
 * its whole result graph, and `runner.stop()` cancels execution and
 * subscriptions without deleting anything. Staying out of the piece registry
 * does not help either — Memory v2 enumerates live entities by id and the
 * FUSE projection hydrates them, so the orphan is reachable from inside the
 * sandbox. A pattern that reads the space through `wish()` would leave that
 * content there, which is exactly the case a synthetic-input argument does not
 * cover.
 *
 * Deleting what the probe creates was the alternative, and it was rejected for
 * a reason worth recording: a root-path retract does remove a document, but
 * the probe's settle produces derived documents beyond its piece and its
 * argument, and nothing here can enumerate them to establish that they are all
 * gone. That fix would have been "delete the ones we know about" presented as
 * "the leak is closed" — a narrower claim in a complete one's clothes, which
 * is the failure this gate exists to remove.
 *
 * So the boundary is structural. `StorageManager.emulate` holds everything in
 * memory, is never mounted anywhere, and is discarded on close: there is no
 * store for the probe to leak into rather than a cleanup that has to be got
 * exhaustively right.
 */
export interface ProbeRuntime {
  readonly pieces: PiecesController;

  /** Discards the runtime and, with it, everything the probe wrote. */
  close(): Promise<void>;
}

/**
 * Stands up a throwaway runtime and space for one probe.
 *
 * Returns `undefined` when the session carries no identity to act as — a
 * session built inline without one gets no isolated runtime, and the gate
 * abstains rather than falling back to probing in the live space. An honest
 * "not checked" beats a silent downgrade to the thing this module exists to
 * prevent.
 */
export const openProbeRuntime = async (
  identity: Identity | undefined,
  apiUrl: URL,
  cfcEnforcementMode: CfcEnforcementMode,
  /**
   * The read ceiling the session's runtime is bounded by, which the probe's
   * runtime is bounded by too: a probe reads the same space the session
   * does, so it reads under the same posture.
   */
  readCeiling: {
    cfcReadMaxConfidentiality?: readonly CfcConfClause[];
    cfcReadOnExceed?: CfcReadOnExceed;
  } = {},
): Promise<ProbeRuntime | undefined> => {
  if (identity === undefined) return undefined;
  // Imported here rather than at module scope on purpose. `cache.deno` reaches
  // SQLite through FFI, and a static import puts that in the module graph of
  // everything that transitively imports `run_pattern` — including the
  // interactive-chat entrypoint, which is spawned as a subprocess with no FFI
  // and fails at LOAD rather than at use. A probe is the only thing that needs
  // storage, so the cost is paid when one runs and not before.
  // deno-lint-ignore cf-imports/no-inline-module-import -- costs at import time: this module reaches SQLite through FFI, and a static import puts that in the graph of every entrypoint that transitively imports run_pattern, including one spawned without FFI.
  const { StorageManager } = await import(
    "@commonfabric/runner/storage/cache.deno"
  );
  const storageManager = StorageManager.emulate({ as: identity });
  // Everything after the storage manager is inside the guard, so a throw from
  // any of it closes what has been allocated so far. Constructing the runtime
  // outside it leaked the manager whenever the constructor threw.
  let runtime: Runtime | undefined;
  try {
    // The probe runs under the run's own CFC mode, and that is not cosmetic:
    // the content-addressed source cache a `cf:pattern:` import resolves from
    // is only written under an enforcing mode, so a probe in a default-mode
    // runtime cannot resolve a composed import at all and every composed
    // pattern would quietly come back with no verdict.
    runtime = new Runtime({
      apiUrl,
      storageManager,
      cfcEnforcementMode,
      ...(readCeiling.cfcReadMaxConfidentiality !== undefined
        ? { cfcReadMaxConfidentiality: readCeiling.cfcReadMaxConfidentiality }
        : {}),
      ...(readCeiling.cfcReadOnExceed !== undefined
        ? { cfcReadOnExceed: readCeiling.cfcReadOnExceed }
        : {}),
    });
    const pieces = new PiecesController(
      createSession({ identity, spaceDid: await runtime.createSpace() }),
      runtime,
    );
    await pieces.synced();
    const opened = runtime;
    return {
      pieces,
      async close() {
        // The storage manager closes whether or not disposal does: a rejected
        // dispose used to skip it and leave the manager live, which is the
        // one resource this whole module exists to be sure of.
        try {
          await opened.dispose();
        } finally {
          await storageManager.close();
        }
      },
    };
  } catch (error) {
    await runtime?.dispose().catch(() => {});
    await storageManager.close().catch(() => {});
    throw error;
  }
};
