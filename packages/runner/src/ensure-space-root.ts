// The space-root ensure core (OW45 arm-B server-ensure STAGE 1; design:
// docs/history/plans/server-execution-v2/optimize/
// ow45-armb-server-ensure-design.md, PR #6209, owner-green-lit 2026-08-23).
//
// Why this lives in the runner: the SpaceServer's activation owes the space
// a root ensure (existence + freshness), but `packages/piece` depends on
// `packages/runner`, so the executor cannot import `PiecesController`. The
// design's §1 implementation note picks the extraction over an injected
// hook precisely so the OFF arm stays ONE code path: the controller's
// creation arm delegates to `createSpaceRootIfAbsent` below (behavior
// preserved byte-for-byte — same phase labels, same causes, same
// transaction body), and the serving seat calls `ensureSpaceRootPattern`,
// which adds only what the server needs (ACL-derived home predicate,
// bookkeeping stamp + owner trust snapshot, the freshness reconcile).
//
// What deliberately does NOT live here:
// - the START of the root and its runnability repair pair (the cold-start
//   setup repair and `healDefaultRootByRollForward`) — client-side today,
//   stage 2's gate: the ON client's creation retirement must not ship
//   until the repair pair moves (design §2; this stage's report records
//   the gate);
// - FRESHNESS. Following a root's origin is the ordinary piece
//   reconciliation, and that runs when a USER opens the piece
//   (`SourceReconciler.reconcile`, called from `PiecesController`). A
//   serving tenure opens nothing, so it owes the space existence and
//   nothing more;
// - the custom `defaultAppUrl` read — the opening user's home-config read
//   is client identity through and through, and the server-side
//   owner-scoped fetch is an UNRULED fork (design §3, open question 3):
//   the server ensure takes the sanctioned interim, system default only,
//   logged on the creation path;
// - `deriveSystemPatternSource` (packages/piece/src/system-pattern-url.ts)
//   — its home predicate is `space === runtime.userIdentityDID`, which is
//   CLIENT semantics: a serving runtime's `userIdentityDID` is the SERVICE
//   DID (see `Runtime.homeSpacePrincipalFor`), so the serving seat derives
//   home-ness from the ACL (self-owned = home) and passes it in.

import { HttpProgramResolver } from "@commonfabric/js-compiler/program";
import type { GenesisRoot } from "@commonfabric/memory/v2";
import { getLogger } from "@commonfabric/utils/logger";

import type { Cell } from "./cell.ts";
import {
  resolveSystemPatternSource,
  systemPatternSource,
} from "./pattern-source-scheme.ts";
import { getPatternIdentityRef, setPatternSource } from "./runner.ts";
import type { Runtime, RuntimeFetch, SpaceCellContents } from "./runtime.ts";
import { type NameSchema, nameSchema } from "./schemas.ts";
import type {
  CommitError,
  IExtendedStorageTransaction,
  MemorySpace,
} from "./storage/interface.ts";

const logger = getLogger("runner.space-root-ensure", {
  enabled: true,
  level: "warn",
});

// The system space-root pattern refs, served as raw TSX by the toolshed
// patterns route and addressed by `system:` ref (pattern-source-scheme.ts
// has why the scheme, rather than the route path it expands to, is what a
// piece stores). Moved here from packages/piece/src/system-pattern-url.ts
// (which re-exports them) so the ensure core and the controller share one
// definition.
export const HOME_PATTERN_SOURCE = systemPatternSource("system/home.tsx");
export const DEFAULT_APP_PATTERN_SOURCE = systemPatternSource(
  "system/default-app.tsx",
);

/**
 * Resolve a stored pattern source to the URL to fetch it from, against
 * `base`. A `system:` ref expands to its patterns route; anything else (a
 * custom `defaultAppUrl`) is resolved as the URL it already is. The caller
 * chooses the base, because which host serves a space is its decision to
 * make. (Moved here from packages/piece/src/system-pattern-url.ts, which
 * re-exports it.)
 */
export function patternSourceUrl(source: string, base: string | URL): URL {
  return new URL(resolveSystemPatternSource(source) ?? source, base);
}

/**
 * The source ref and creation cause for a space's root, by space type.
 * The CAUSE is identity-bearing: it derives the piece cell's entity id,
 * so every creator (client controller, server ensure) MUST mint the same
 * cause for the OCC creation race to converge on one root by address —
 * these are the controller's historical literals, shared so they cannot
 * drift.
 */
export function spaceRootPatternConfig(
  isHomeSpace: boolean,
  customSource?: string,
): { source: string; cause: string } {
  return isHomeSpace
    ? { source: HOME_PATTERN_SOURCE, cause: "home-pattern" }
    : {
      source: customSource || DEFAULT_APP_PATTERN_SOURCE,
      cause: "space-root",
    };
}

/** Identity phase-timer: the controller passes its `timePiecePhase`; the
 * serving seat times nothing. */
const runPhase = <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();

export type SpaceRootCreationHooks = {
  /**
   * Called FIRST inside every creation-transaction attempt (editWithRetry
   * re-runs its callback per retry, so per-attempt is the only correct
   * seat): the serving seat stamps `bookkeeping` and attaches the
   * owner-resolved CFC trust snapshot here (design §4(b)); the client
   * passes nothing and the transaction is byte-identical to before the
   * extraction.
   */
  stampCreationTx?: (tx: IExtendedStorageTransaction) => void;

  /** Phase timing (the controller's `timePiecePhase`); defaults to a
   * pass-through so the serving seat pays nothing. */
  timePhase?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;

  /** The fetch the program resolve uses. The client passes nothing (the
   * platform fetch, its historical behavior); the serving seat passes
   * `runtime.fetch` so tests can serve pattern sources in-process. */
  fetch?: RuntimeFetch;

  /** The space-cell handle the creation transaction's re-check reads
   * through. The controller passes its OWN synced instance (its
   * historical read source — and the piece suite's creation-race test
   * stubs exactly that seam); absent, a fresh handle over the same
   * address (`runtime.getSpaceCell(space)`), which is what the serving
   * seat uses. */
  spaceCell?: Cell<SpaceCellContents>;
};

/**
 * The creation half of the space-root ensure, shared verbatim between the
 * client controller's `ensureDefaultPattern` and the server's
 * {@link ensureSpaceRootPattern}: resolve + compile the root pattern
 * (into the target space's content-addressed compile cache, CT-1623),
 * then the creation `editWithRetry` — re-check `defaultPattern` inside
 * the transaction (the OCC invariant that makes concurrent creators
 * converge), create the piece cell, run setup, stamp source provenance,
 * link `defaultPattern`.
 *
 * Returns whether THIS call's transaction created the root. A commit
 * error is returned, not thrown — the client's historical behavior is to
 * proceed to resolution (whoever won the race supplies the root) and
 * fail only if nothing resolves; the serving seat counts the error.
 */
export async function createSpaceRootIfAbsent(
  runtime: Runtime,
  space: MemorySpace,
  config: GenesisRoot,
  hooks: SpaceRootCreationHooks = {},
): Promise<{ createdByThisCall: boolean; error?: CommitError }> {
  const timePhase = hooks.timePhase ?? runPhase;
  const patternUrl = patternSourceUrl(config.source, runtime.apiUrl);

  // Load and compile the pattern (async work outside the transaction).
  const program = await timePhase(
    "ensureDefaultPattern.resolveProgram",
    () =>
      runtime.harness.resolve(
        hooks.fetch === undefined
          ? new HttpProgramResolver(patternUrl.href)
          : new HttpProgramResolver(patternUrl.href, hooks.fetch),
        {
          sourceRoots: config.sourceRoots?.map((source) =>
            patternSourceUrl(source, runtime.apiUrl).pathname
          ),
        },
      ),
  );
  const pattern = await timePhase(
    "ensureDefaultPattern.compilePattern",
    () =>
      runtime.patternManager.compilePattern(
        program,
        // Route the space-root compile through the content-addressed cell
        // cache so a later load (fresh worker, other clients) reuses the
        // compiled module set instead of cold-compiling (CT-1623).
        { space },
      ),
  );

  // Atomic creation with automatic retry on conflicts: reading
  // `defaultPattern` inside the transaction creates the invariant; if
  // another creator commits first, this commit fails, retries, sees the
  // existing root, and returns early.
  const creationResult = await timePhase(
    "ensureDefaultPattern.editWithRetry",
    () =>
      runtime.editWithRetry((tx) => {
        // Per-attempt, before the first read (a trust snapshot must be
        // set before the reads it governs; editWithRetry re-runs this
        // callback on a fresh transaction per retry).
        hooks.stampCreationTx?.(tx);
        // Double-check the pattern doesn't exist (the read establishes
        // the OCC invariant).
        const spaceCellWithTx = (hooks.spaceCell ?? runtime.getSpaceCell(space))
          .withTx(tx);
        const defaultPatternCell = spaceCellWithTx.key("defaultPattern");
        const existingDefault = defaultPatternCell.get();
        if (existingDefault?.get()) {
          // Another creator won; the editWithRetry completes successfully
          // and the caller resolves the existing root.
          return false;
        }
        const pieceCell = runtime.getCell<NameSchema>(
          space,
          config.cause,
          nameSchema,
          tx,
        );
        // Run pattern setup within the same transaction.
        runtime.run(tx, pattern, config.argument ?? {}, pieceCell);
        // Stamp the provenance the piece tracks for updates (the source it
        // was born from) — same transaction, one extra meta write.
        setPatternSource(pieceCell, tx, config.source);
        // Link as the default pattern within the same transaction.
        defaultPatternCell.set(pieceCell.withTx(tx));
        return true;
      }),
  );
  return {
    createdByThisCall: creationResult.ok === true,
    ...(creationResult.error !== undefined
      ? { error: creationResult.error }
      : {}),
  };
}

/**
 * Resolve the space's linked default root WITHOUT starting it — the
 * serving seat's resolution (the controller keeps its own
 * `getDefaultPattern`, whose load-failure heal choke point is a client
 * concern). Absent, unlinked, or linked-but-empty (neither raw contents
 * nor a pattern identity) all resolve to `undefined`.
 */
export async function resolveSpaceRootPattern(
  runtime: Runtime,
  space: MemorySpace,
): Promise<Cell<NameSchema> | undefined> {
  const slot = runtime.getSpaceCell(space).key("defaultPattern");
  await slot.sync();
  const defaultPattern = slot.get();
  if (!defaultPattern) return undefined;
  await defaultPattern.sync();
  if (
    defaultPattern.getRaw() === undefined &&
    getPatternIdentityRef(defaultPattern) === undefined
  ) {
    return undefined;
  }
  return defaultPattern.resolveAsCell().asSchema<NameSchema>(nameSchema);
}

export type EnsureSpaceRootResult = {
  /** How existence was satisfied: the fast path resolved a persisted
   * root; this call created it; or this call's creation lost the OCC
   * race and resolved the winner's root. */
  outcome: "resolved-existing" | "created" | "raced-existing";
};

/**
 * The server-side space-root ensure: existence, no start. The SpaceServer
 * runs this once per tenure as a lease-guarded owed step — under the lease
 * there is no second server-side materializer, and the creation
 * transaction's OCC invariant converges the remaining client-vs-server
 * race whichever side wins.
 *
 * A persisted root is resolved and left alone when its address matches any
 * supplied genesis reservation; a different address is a conflict. The memory
 * session separately authenticates the complete immutable creation intent.
 * Following its origin is the
 * ordinary piece reconciliation, which belongs to the user who opens the
 * piece, not to a tenure that opens nothing.
 *
 * `isHomeSpace` is the ACL-derived predicate (self-owned = home),
 * resolved by the caller through the memory server's
 * `resolveSpaceOwner` — NEVER `space === runtime.userIdentityDID`, which
 * on a serving runtime compares against the SERVICE DID.
 *
 * Throws when the root can neither be resolved nor created; the seat
 * counts and warns, and the next tenure retries.
 */
export async function ensureSpaceRootPattern(
  runtime: Runtime,
  space: MemorySpace,
  options: {
    isHomeSpace: boolean;
    genesisRoot?: GenesisRoot;
    stampCreationTx?: (tx: IExtendedStorageTransaction) => void;
  },
): Promise<EnsureSpaceRootResult> {
  const existing = await resolveSpaceRootPattern(runtime, space);
  if (existing !== undefined) {
    if (
      options.genesisRoot &&
      !existing.equals(
        runtime.getCell(space, options.genesisRoot.cause, nameSchema),
      )
    ) {
      throw new Error(
        "Default pattern conflicts with the genesis root reservation",
      );
    }
    return { outcome: "resolved-existing" };
  }

  if (!options.isHomeSpace && options.genesisRoot === undefined) {
    // The custom `defaultAppUrl` interim (design §3, open question 3 —
    // UNRULED): a configured custom root source lives in the OWNER's
    // home space, and reading it server-side is the unruled owner-scoped
    // fork itself, so the server ensure does not consult it: fresh
    // non-home roots are created from the system default-app source
    // until the fetch-trust posture is ruled. Logged unconditionally on
    // this arm because detection without the read is impossible.
    logger.info?.("custom-default-app-url-not-consulted", () => [
      `space ${space}: server ensure creates the root from the system ` +
      "default-app source; a configured defaultAppUrl is not consulted " +
      "server-side (unruled fork — design #6209 §3, open question 3)",
    ]);
  }

  const created = await createSpaceRootIfAbsent(
    runtime,
    space,
    options.genesisRoot ?? spaceRootPatternConfig(options.isHomeSpace),
    {
      ...(options.stampCreationTx !== undefined
        ? { stampCreationTx: options.stampCreationTx }
        : {}),
      fetch: runtime.fetch,
    },
  );
  const root = await resolveSpaceRootPattern(runtime, space);
  if (root === undefined) {
    throw new Error(
      `space-root ensure for ${space} failed to create or find the ` +
        `default pattern` +
        (created.error !== undefined
          ? ` (creation commit: ${created.error.name}: ${created.error.message})`
          : ""),
      created.error !== undefined ? { cause: created.error } : undefined,
    );
  }
  return {
    outcome: created.createdByThisCall ? "created" : "raced-existing",
  };
}
