/**
 * Following a piece's source origin.
 *
 * {@link SourceReconciler.reconcile} runs when a piece is opened: it reads the
 * origin the piece records, resolves it, and adopts the source it names when
 * that source has moved. Nothing reconciles a piece nobody opened, and no kind
 * of piece — a space root included — has a path of its own. A piece it follows
 * is reconciled again when its source can have moved since: a fabric origin
 * when the entity it names changes, and a `system:` origin when its space's
 * memory session is replaced, as a host restart replaces every session.
 *
 * A user opening a piece is what opens most of them. The runtime also opens the
 * surfaces it instantiates for itself, and {@link SourceReconciler.open} is how:
 * it supplies the origin such a piece is made from, so that piece records where
 * its code came from and is followed from then on like any other.
 *
 * Whether a candidate has to prove itself first turns on one question: did
 * anything gate the release that produced it? A `system:` origin names source
 * this deployment serves, released through golden replays that load
 * representative state written by the previous version and check the new one
 * still reads it (`docs/specs/pattern-update-testing.md`). That check is
 * better than any the runtime could make, and repeating a weaker version of it
 * would only refuse releases the replays already cleared. Every other origin is
 * somebody else's, and nobody promised anything, so a candidate from one has to
 * prove itself — today by not moving the piece's contract at all, which
 * {@link SourceReconciler.reconcile}'s refusal check explains.
 *
 * A `system:` candidate is still not adopted when it is an earlier release than
 * the one the piece runs. Two hosts serving one space can offer different
 * releases at once — a deployment partway through restarting its instances,
 * two deployments reaching the same memory — and a piece that took whatever
 * differed would move between them on every open. The release time the host
 * sends beside its identity orders the two (`pattern-release-time.ts`).
 *
 * `docs/specs/piece-source-lifecycle.md` is the design of record.
 * `piece-origin-kind.ts` enumerates the origins this dispatches on.
 *
 * What each reconciliation concluded is recorded on the piece it ran for, so
 * that a reader who opens it later can tell one that is following its origin
 * from one that could not reach it and one that refused what it offered. See
 * "Saying when a piece has stopped following its origin" in the lifecycle spec.
 */

import { debugStr } from "@commonfabric/data-model";
import { isDID } from "@commonfabric/identity/did";
import { HttpProgramResolver } from "@commonfabric/js-compiler/program";
import { LRUCache } from "@commonfabric/utils/cache";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { getLogger } from "@commonfabric/utils/logger";
import { stringTupleKey } from "@commonfabric/utils/string-tuple-key";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { Pattern } from "./builder/types.ts";
import type { Cancel } from "./cancel.ts";
import type { Cell } from "./cell.ts";
import { readStoredCfcSchemaHash } from "./cfc/metadata.ts";
import { prepareSourceClosureVerification } from "./compilation-cache/cell-cache.ts";
import type { RuntimeProgram } from "./harness/types.ts";
import type { PreparedSourceUpdate } from "./pattern-manager.ts";
import {
  parseReleaseTime,
  RELEASED_AT_HEADER,
} from "./pattern-release-time.ts";
import {
  classifyPieceOriginString,
  type PieceOriginKind,
} from "./piece-origin-kind.ts";
import {
  applyPieceSourceTransition,
  getPatternIdentityRef,
  getPatternSource,
  getPieceReconciliation,
  getPieceSourceSnapshot,
  keepLaterConfirmation,
  knownPieceReleasedAt,
  type PieceReconciliation,
  type PieceReconciliationOutcome,
  type PieceReconciliationReason,
  pieceSourceMovedPast,
  type PieceSourceSnapshot,
  type PieceSourceTransition,
  preparePieceSourceTransitionBaseline,
  samePieceReconciliation,
  samePieceSourceSnapshot,
  setPieceReconciliation,
} from "./runner.ts";
import type { Runtime } from "./runtime.ts";
import { schemaRegistryEpoch } from "./schema-registry.ts";
import { fabricAuthorityMatchesSpaceHost } from "./space-host.ts";
import type { MemorySpace } from "./storage/interface.ts";
import {
  isEnvelopeStabilityRefusal,
  isOversizedRejection,
} from "./storage/rejection.ts";

/**
 * What went wrong, as a reason a record can carry: a thrown error, or the
 * rejection a commit returns, which has an error's name and message without
 * being one. Falls back through the error's name to a fixed phrase, because an
 * empty one is dropped when the record is read and would make an unchanging
 * failure rewrite itself forever.
 */
function reconciliationDetail(error: unknown): string {
  if (error instanceof Error || isObjectNotArray(error)) {
    const { message, name } = error;
    if (typeof message === "string" && message.length > 0) return message;
    if (typeof name === "string" && name.length > 0) return name;
  } else {
    const described = String(error);
    if (described.length > 0) return described;
  }
  return "the origin could not be reached";
}

const logger = getLogger("runner.source-reconcile", {
  enabled: true,
  level: "warn",
});

/**
 * What one reconciliation did, or why it did nothing. Every recorded origin
 * lands on exactly one of these.
 *
 * - `detached`: nothing supplies code for this piece — it records no origin,
 *   or it runs no pattern for an origin to replace.
 * - `unusable`: it records a string no resolver can follow.
 * - `current`: the origin resolved to the source already running.
 * - `migrated`: the origin was rewritten into its canonical spelling; the
 *   pattern is unchanged.
 * - `updated`: the piece adopted new source.
 * - `ahead`: the origin offered a `system:` release earlier than the one the
 *   piece runs, which the piece keeps. Against a running release that records
 *   a release time, an offer stating none is the earlier one. A piece whose
 *   running pattern cannot load takes the earlier release as a rescue, since
 *   it has nothing to start, unless its history records its move from that
 *   release to the one it runs: then this runtime is behind the running
 *   release, and the piece keeps it.
 * - `incompatible`: the origin offered source that cannot replace what the
 *   piece runs, and its owner has not said to take it anyway.
 * - `rejected`: the write that adopts the origin's source was refused for
 *   good — by the store as too large, or by a stored envelope whose claim the
 *   candidate's schema changes or weakens — which neither a retry nor a grant
 *   gets past. This runtime does not propose that source again until the
 *   candidate or the piece's source state changes, the envelopes a stored
 *   envelope's refusal was reached over change, or the space's memory session
 *   is replaced.
 * - `unavailable`: the origin's current source could not be adopted this
 *   time — it could not be reached, the write that adopts it did not commit,
 *   or the piece changed underneath the attempt and the write it was going to
 *   make no longer describes it.
 */
export type ReconcileOutcome =
  | "detached"
  | "unusable"
  | "current"
  | "migrated"
  | "updated"
  | "ahead"
  | "incompatible"
  | "rejected"
  | "unavailable";

/**
 * What each reconciliation result becomes on the piece, and which leave
 * nothing behind.
 *
 * The results that end with the piece running what its origin holds, or a
 * later release of it, are one state to a reader: how it got there is the
 * revision log's business, not this record's. `detached` and `unusable` are
 * read off the recorded origin itself, so a record would only restate what the
 * piece already says.
 */
const RECORDED_OUTCOME: Record<
  ReconcileOutcome,
  | { outcome: PieceReconciliationOutcome; reason?: PieceReconciliationReason }
  | undefined
> = {
  current: { outcome: "followed" },
  migrated: { outcome: "followed" },
  updated: { outcome: "followed" },
  ahead: { outcome: "followed" },
  unavailable: { outcome: "unreachable" },
  // The reason travels with the result rather than being inferred from the
  // outcome, so a second kind of refusal has to say which one it is instead
  // of inheriting this one.
  incompatible: { outcome: "refused", reason: "incompatible-schema" },
  rejected: { outcome: "refused", reason: "apply-failed" },
  detached: undefined,
  unusable: undefined,
};

/** What a reconciliation's result leaves on the piece it ran for. */
function reconciliationFor(
  state: FollowedPieceState,
  outcome: ReconcileOutcome,
): PieceReconciliation | undefined {
  const recorded = RECORDED_OUTCOME[outcome];
  if (recorded === undefined) return undefined;
  return {
    outcome: recorded.outcome,
    at: Date.now(),
    origin: state.storedSource,
    ...(state.offered === undefined ? {} : { offered: state.offered }),
    ...(recorded.reason === undefined ? {} : { reason: recorded.reason }),
    ...(state.detail === undefined ? {} : { detail: state.detail }),
    ...(state.confirmed === undefined ? {} : { confirmed: state.confirmed }),
  };
}

/**
 * Whether an offer released at `offered` is an earlier release than the one a
 * piece runs, whose latest known release time is `running`
 * (`knownPieceReleasedAt()`). Release times are compared only where the
 * running source has one: a piece adopted from a host stating none has nothing
 * to order an offer against until a release offering that same source
 * confirms it at a stated time, and until then takes any offer as before. An
 * offer stating none is earlier than any running release that has one, so a
 * host that states no release time cannot move a piece another host has placed
 * on a stated one. An offer stating the same time as the running release is
 * not earlier.
 */
export function isEarlierRelease(
  offered: number | undefined,
  running: number | undefined,
): boolean {
  if (running === undefined) return false;
  return offered === undefined || offered < running;
}

/**
 * Whether a piece keeps the source it runs, `running`, against an earlier
 * release offering `offered`. It does when this runtime can load `running`
 * (`loadable`), or when the piece's history records its move from `offered`
 * to `running` (`pieceSourceMovedPast()`): then a runtime loaded `running`,
 * and this one is behind that release rather than holding a dead one. Taking
 * the earlier release there would undo the move, and every runtime that can
 * load the later release would make it again. Otherwise the piece has nothing
 * it can start, and the earlier release is a rescue.
 */
function keepsRunningSource(
  resultCell: Cell<unknown>,
  running: { identity: string; symbol: string },
  offered: { identity: string; symbol: string },
  loadable: boolean,
): boolean {
  return loadable || pieceSourceMovedPast(resultCell, offered, running);
}

async function abortable<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation(), aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

type PendingReconcile = {
  abort: AbortController;
  reschedule: boolean;
  promise: Promise<ReconcileOutcome>;
};

type FabricFollower = {
  sourceKey: string;
  cancel: () => void;
};

/**
 * The state one reconciliation reads once and guards every write against.
 *
 * `storedSource` is absent only while a piece the runtime instantiates for
 * itself claims the origin it has been running from; every other pass reads a
 * piece that already records one.
 */
type PieceState = {
  space: MemorySpace;
  running: { identity: string; symbol: string };
  storedSource: string | undefined;
  snapshot: PieceSourceSnapshot;

  /**
   * What the origin turned out to be offering, once something has resolved it.
   * Filled in as a reconciliation learns it, and read only by the record it
   * leaves behind: the outcome alone says whether the piece moved, and this
   * says what it moved to, or what it declined.
   */
  offered?: { identity: string; symbol: string };

  /** Why this reconciliation ended as it did, where it can say. */
  detail?: string;

  /**
   * The release time of the source the piece runs once this reconciliation
   * is over, which the record it leaves behind carries
   * (`PieceReconciliation.confirmed`). Set only by a `system:` origin.
   */
  confirmed?: { identity: string; releasedAt: number };
};

/**
 * What a `system:` origin's host advertises: the identity it serves, and when
 * it released it, if it says.
 */
type AdvertisedSource = {
  identity: string;

  /** Milliseconds since the epoch (`pattern-release-time.ts`). */
  releasedAt?: number;
};

/** A piece that records an origin, which is every piece following one. */
type FollowedPieceState = PieceState & { storedSource: string };

/**
 * The origin an adoption gives a piece that followed none, and the operation
 * its revision records for doing so.
 */
type OriginClaim = {
  operation: PieceSourceTransition["operation"];
  origin: string;
};

/** One network pass, so teardown can abort it and wait for it to settle. */
type SourcePass = {
  abort: AbortController;
  done: Promise<unknown>;
};

/**
 * How a write was refused for good: by the store as too large
 * (`isOversizedRejection`), or by a stored envelope its schema changes or
 * weakens (`isEnvelopeStabilityRefusal`). The same write receives either again
 * however often it is sent, from one pass to the next, and no grant lifts it.
 * Other terminal rejections are not this: a CFC or row-label refusal can be
 * lifted by a grant, which the next pass has to pick up.
 */
type LastingRefusal = "too-large" | "stored-envelope";

/** Why a reconciliation's write did not commit. */
type CommitFailure = {
  /** The reason, as a record can carry it. */
  detail: string;

  /** How the write was refused for good, or `undefined` where it was not. */
  lasting: LastingRefusal | undefined;
};

/**
 * An adoption whose write was refused for good, and what that refusal answered
 * for. A pass that finds all of it unchanged builds nothing, since the write it
 * would build is refused the same way.
 *
 * Every refusal answers for the candidate and the piece's source state. One by
 * a stored envelope answers also for the envelopes the piece's argument and
 * result documents store: a write under the schema the piece runs leaves them
 * as they are, and a migration that rewrites them can change the answer. One
 * the store refused as too large answers for nothing more, since the write
 * grows with what the piece holds and a change to its data rarely makes it
 * fit.
 *
 * That is narrower than everything the refusing merge reads. An envelope on
 * another document the write merges, and the values a release's merge reads to
 * relax a claim beneath a link, are outside it. What the store admits can
 * change when the space's memory session is replaced, as a host restart
 * replaces it, so a replacement forgets the space's refusals. A runtime that
 * starts again, which is when its own code can change, starts with none.
 */
type RefusedAdoption = {
  /** The space of the refused piece. */
  space: MemorySpace;

  /** The candidate the refused write would have adopted. */
  offered: { identity: string; symbol: string };

  /**
   * The piece's source state the refused write was guarded against, which
   * names the origin it followed.
   */
  snapshot: PieceSourceSnapshot;

  /**
   * The envelopes the piece's argument and result documents stored when a
   * stored envelope refused the write (`#storedEnvelopes`); absent for a write
   * the store refused as too large.
   */
  envelopes?: string;

  /** What the record of the refusal says. */
  detail: string;
};

/**
 * Resolved source for one supplied origin in one destination space, and the
 * pattern it compiled to there once an open has verified it.
 */
type SuppliedSource = {
  /** The resolved program, which each compile gets its own containers of. */
  readonly program: RuntimeProgram;

  /**
   * The pattern `program` compiled to in the destination space, with the
   * advertised identity verified and the source closure persisted there, and
   * the schema registry epoch it was compiled in. Usable only in that epoch:
   * its serialized graph carries `cid:` references minted from the registry.
   */
  compiled?: { pattern: Pattern; epoch: number };
};

/** Maximum retained source text and key size, measured in UTF-16 code units. */
const SUPPLIED_SOURCE_MAX_WEIGHT = 4 * 1024 * 1024;

/**
 * The string weight of one resolved program and its lookup key. A compiled
 * pattern kept beside it is not weighed: this budget bounds retained source
 * text, and the entry count bounds how many patterns are kept.
 */
function suppliedSourceWeight(key: string, source: SuppliedSource): number {
  const { program } = source;
  let weight = key.length + program.main.length +
    (program.mainExport?.length ?? 0);
  for (const file of program.files) {
    weight += file.name.length + file.contents.length;
  }
  for (const name of program.dataFiles ?? []) weight += name.length;
  for (const name of program.sourceRoots ?? []) weight += name.length;
  return weight;
}

/** Give a compiler its own source containers while sharing immutable strings. */
function copySourceProgram(program: RuntimeProgram): RuntimeProgram {
  return {
    ...program,
    files: program.files.map((file) => ({ ...file })),
    ...(program.dataFiles === undefined
      ? {}
      : { dataFiles: [...program.dataFiles] }),
    ...(program.sourceRoots === undefined
      ? {}
      : { sourceRoots: [...program.sourceRoots] }),
  };
}

export class SourceReconciler {
  readonly #runtime: Runtime;
  readonly #pending = new Map<string, PendingReconcile>();
  readonly #fabricFollowers = new Map<string, FabricFollower>();
  readonly #stoppedFabricFollowers = new Set<string>();

  /**
   * The pieces following a system origin, by follower key. A host serves one
   * source for the life of its process, and a restart replaces every memory
   * session it held, so each is reconciled again when its space's session is
   * replaced.
   */
  readonly #systemFollowers = new Map<string, Cell<unknown>>();

  /**
   * The adoptions this runtime saw refused for good, by follower key. Kept in
   * the runtime rather than on the piece: such a refusal is the verdict of
   * the runtime that built the write and the store it sent it to, and another
   * runtime — a later build, a client under different enforcement — may build
   * a write that is admitted. What the piece records is the refusal itself,
   * which every runtime reports the same way. A refusal outlives the piece
   * stopping: a host that keeps a piece running stops and starts it,
   * reconciling on each start, and would otherwise build and send the refused
   * write on every cycle.
   */
  readonly #refusedAdoptions = new Map<string, RefusedAdoption>();

  /**
   * How many times each space's memory session has been replaced, so that a
   * refusal received across a replacement of its own space's session is not
   * remembered: it answered for a store that may no longer be the one serving
   * the space.
   */
  readonly #sessionReplacements = new Map<MemorySpace, number>();

  readonly #passes = new Set<SourcePass>();
  readonly #suppliedSources = new LRUCache<string, SuppliedSource>({
    capacity: 32,
    maxWeight: SUPPLIED_SOURCE_MAX_WEIGHT,
    weigh: suppliedSourceWeight,
  });
  readonly #suppliedSourceFlights = new Map<string, Promise<SuppliedSource>>();

  /**
   * The compiles of supplied source in flight, by the key their source is
   * retained under, each with the schema registry epoch it started in. Kept
   * apart from retention, so an open still finds a compile whose source has
   * since been retired.
   */
  readonly #suppliedCompileFlights = new Map<
    string,
    { promise: Promise<Pattern | undefined>; epoch: number }
  >();
  readonly #cancelSessionReplaced: Cancel | undefined;
  #disposed = false;

  constructor(runtime: Runtime) {
    this.#runtime = runtime;
    this.#cancelSessionReplaced = runtime.storageManager
      .subscribeSpaceSessionReplaced?.((space) =>
        this.#followSystemSources(space)
      );
  }

  /** The retained supplied sources, which a test reads to see what is kept. */
  get accessForTestingOnly(): {
    readonly suppliedSources: LRUCache<string, SuppliedSource>;
  } {
    return { suppliedSources: this.#suppliedSources };
  }

  /**
   * Resolve the piece's origin and adopt its current source when it has moved.
   *
   * Awaited: a piece being opened reconciles before it starts, so it never runs
   * source that its own origin has already replaced. Failures never throw — a
   * piece whose origin cannot be reached keeps running what it has.
   */
  reconcile(resultCell: Cell<unknown>): Promise<ReconcileOutcome> {
    if (this.#disposed) return Promise.resolve("detached");
    this.#stoppedFabricFollowers.delete(this.#followerKey(resultCell));
    return this.#singleFlight(resultCell);
  }

  /**
   * Open a piece this runtime instantiates for itself, and answer with the
   * pattern that piece should now run.
   *
   * `suppliedOrigin` names where the runtime takes such a piece's code from.
   * The wish builtin's profile and suggestion surfaces are the pieces this
   * exists for: the runtime fetches their source, so nobody else is there to
   * say what supplies them, and a surface that recorded nothing would be code
   * the source lifecycle could not see — no origin to show, no revision to
   * revert to, and nothing to follow when the deployment ships a new version.
   *
   * A piece that does not exist yet is answered with the source the origin
   * currently names, and the caller's run records that origin with the piece's
   * creation revision. A piece that exists follows the origin it records,
   * exactly as {@link reconcile} makes it. The supplied origin is claimed only
   * by a piece carrying none, because the runtime instantiating a piece from
   * one place every time is a durable choice, while a piece whose owner has
   * since repointed it records a choice of their own that this must not undo.
   *
   * Only a `system:` origin can be supplied: it names source this deployment
   * serves, which is the one kind of code the runtime has of its own.
   */
  async open(
    resultCell: Cell<unknown>,
    suppliedOrigin: string,
  ): Promise<Pattern | undefined> {
    if (this.#disposed) return undefined;
    try {
      // Detached from the caller's transaction: what this reads decides whether
      // the piece exists at all, and a caller's snapshot predates the run that
      // created it.
      let piece = await resultCell.withTx().sync();
      if (this.#disposed) return undefined;
      // The supplied origin is settled once, before either path uses it, so
      // that resolving one and recording one cannot disagree about what the
      // runtime is allowed to supply.
      const origin = classifyPieceOriginString(
        suppliedOrigin,
        this.#runtime.hostForSpace(piece.space).href,
      );
      if (origin.kind !== "system") {
        logger.warn("unsupported-supplied-origin", () => [
          "a piece was instantiated from an origin the runtime cannot supply",
          piece.space,
          suppliedOrigin,
        ]);
        return undefined;
      }
      const running = getPatternIdentityRef(piece);
      if (running === undefined) {
        return await this.#resolveSupplied(piece.space, origin);
      }
      if (getPatternSource(piece) === undefined) {
        // A piece that records no origin claims the supplied one by retaining
        // what it runs, which is the source closure THIS space holds for it.
        // A pattern live in the runtime's index says nothing about that: the
        // index is keyed by identity alone, so it answers for a pattern
        // compiled into any space. A piece whose space holds no closure has
        // nothing to retain, and nothing else ever moves it: it takes the
        // origin's current source in the same transition that records the
        // origin, and records the identity it displaced.
        const retained = await this.#runtime.patternManager
          .getPatternSourceProgramByIdentity(running.identity, piece.space);
        const rescued = retained === undefined &&
          await this.#rescueSupplied(piece, origin);
        // Recording where a piece's code comes from is worth doing and worth
        // saying when it fails, but it is not what the caller asked for: a
        // surface whose provenance could not be written still runs.
        try {
          if (!rescued) await this.#claimSuppliedOrigin(piece, origin.ref);
          piece = await piece.withTx().sync();
        } catch (error) {
          logger.warn("claim-origin-failed", () => [
            "a piece the runtime supplies could not record its origin",
            piece.space,
            origin.ref,
            error,
          ]);
        }
      }
      await this.reconcile(piece);
      // Re-read: a transition commits through a transaction view of its own, so
      // the pattern to run is the one the piece names after it, not before.
      const current = getPatternIdentityRef(await piece.withTx().sync());
      return current && await this.#loadPattern(current, piece.space);
    } catch (error) {
      logger.warn("open-failed", () => [
        "opening a piece the runtime supplies failed",
        resultCell.space,
        suppliedOrigin,
        error,
      ]);
      return undefined;
    }
  }

  /** Resolve when the passes currently in flight have settled. */
  async idle(): Promise<void> {
    await Promise.allSettled([
      ...[...this.#pending.values()].map(({ promise }) => promise),
      ...[...this.#passes].map(({ done }) => done),
    ]);
  }

  /** Abort network work and keep it away from storage teardown. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#suppliedSources.clear();
    this.#suppliedSourceFlights.clear();
    this.#suppliedCompileFlights.clear();
    for (const { abort } of this.#pending.values()) abort.abort();
    for (const { abort } of this.#passes) abort.abort();
    for (const { cancel } of this.#fabricFollowers.values()) cancel();
    this.#fabricFollowers.clear();
    this.#cancelSessionReplaced?.();
    this.#systemFollowers.clear();
    this.#refusedAdoptions.clear();
    await this.idle();
  }

  /** Stop following a source when its piece stops. */
  unwatch(resultCell: Cell<unknown>): void {
    const key = this.#followerKey(resultCell);
    const pending = this.#pending.get(key);
    if (pending !== undefined) {
      this.#stoppedFabricFollowers.add(key);
      pending.abort.abort("fabric follower stopped");
    } else {
      this.#stoppedFabricFollowers.delete(key);
    }
    this.#unwatchSource(resultCell);
  }

  #singleFlight(resultCell: Cell<unknown>): Promise<ReconcileOutcome> {
    const key = this.#followerKey(resultCell);
    const existing = this.#pending.get(key);
    if (existing !== undefined) {
      if (existing.abort.signal.aborted) existing.reschedule = true;
      return existing.promise;
    }

    const abort = new AbortController();
    const pending = {} as PendingReconcile;
    pending.abort = abort;
    pending.reschedule = false;
    pending.promise = this.#reconcile(resultCell, abort.signal)
      .catch((error) => {
        logger.warn("reconcile-failed", () => [
          "source reconciliation failed",
          resultCell.space,
          error,
        ]);
        return "unavailable" as ReconcileOutcome;
      })
      .finally(() => {
        if (this.#pending.get(key) === pending) this.#pending.delete(key);
        if (this.#stoppedFabricFollowers.delete(key)) return;
        if (pending.reschedule && !this.#disposed) {
          void this.#singleFlight(resultCell);
        }
      });
    this.#pending.set(key, pending);
    return pending.promise;
  }

  /**
   * Forgets the refusals received for pieces in `space`, whose memory session
   * was replaced, and reconciles each piece following a system origin there
   * again.
   */
  #followSystemSources(space: MemorySpace): void {
    this.#sessionReplacements.set(space, this.#replacementsOf(space) + 1);
    for (const [key, refused] of [...this.#refusedAdoptions]) {
      if (refused.space === space) this.#refusedAdoptions.delete(key);
    }
    for (const follower of [...this.#systemFollowers.values()]) {
      if (follower.space === space) this.#reconcileFromSourceEvent(follower);
    }
  }

  /** Re-enter after the current pass, for a followed source that moved. */
  #reconcileFromSourceEvent(resultCell: Cell<unknown>): void {
    const key = this.#followerKey(resultCell);
    if (this.#disposed || this.#stoppedFabricFollowers.has(key)) return;
    const pending = this.#pending.get(key);
    if (pending !== undefined) {
      pending.reschedule = true;
      return;
    }
    void this.#singleFlight(resultCell);
  }

  #followerKey(follower: Cell<unknown>): string {
    const link = follower.getAsNormalizedFullLink();
    return `${link.space}\0${link.scope ?? "space"}\0${link.id}`;
  }

  async #reconcile(
    resultCell: Cell<unknown>,
    signal: AbortSignal,
  ): Promise<ReconcileOutcome> {
    const running = getPatternIdentityRef(resultCell);
    const storedSource = getPatternSource(resultCell);
    if (running === undefined || storedSource === undefined) {
      this.#unwatchSource(resultCell);
      // Nothing supplies code for this piece, which the panel reads off the
      // absent origin. An outcome would describe a relationship it does not
      // have.
      return "detached";
    }
    const state: FollowedPieceState = {
      space: resultCell.space,
      running,
      storedSource,
      snapshot: getPieceSourceSnapshot(resultCell)!,
    };
    // A dispatch that throws is the commonest way an origin turns out to be
    // out of reach: a refused connection, a resolver that gave up. Its caller
    // turns that into `unavailable`, so without catching it here the one
    // failure a reader most needs recorded is the one that records nothing.
    // A cancelled reconciliation is not an outcome at all, and keeps whatever
    // the piece already said.
    let outcome: ReconcileOutcome;
    try {
      outcome = await this.#dispatch(resultCell, state, signal);
    } catch (error) {
      if (signal.aborted || this.#disposed) throw error;
      // A reason has to be non-empty to survive being read back, and an error
      // can carry an empty message. One that decoded to nothing would be
      // dropped on the next read and rewritten on every later attempt, so the
      // same failure would never settle.
      state.detail = reconciliationDetail(error);
      await this.#record(resultCell, state, "unavailable", signal);
      throw error;
    }
    await this.#record(resultCell, state, outcome, signal);
    return outcome;
  }

  /**
   * Record what this reconciliation concluded, so that it outlives the
   * reconciliation.
   *
   * A piece that refused its origin's source, or could not reach it, is
   * running source its origin has already replaced, and looks from the outside
   * exactly like one that is current. The record is what tells them apart. It
   * is not a revision: a refused candidate was never accepted, and the
   * revision log holds only what the piece adopted.
   *
   * Reaching the same conclusion again writes nothing, so opening a piece that
   * is up to date stays a read, apart from the first open after its origin
   * offers the same source as a later release. An accepted transition has
   * already cleared whatever the last one concluded, so an update records its
   * fresh outcome over an empty field rather than over a stale one.
   *
   * Losing the record is not losing the reconciliation: the outcome describes
   * what happened, and the piece runs what it runs either way.
   */
  async #record(
    resultCell: Cell<unknown>,
    state: FollowedPieceState,
    outcome: ReconcileOutcome,
    signal: AbortSignal,
  ): Promise<void> {
    const recorded = reconciliationFor(state, outcome);
    if (recorded === undefined || signal.aborted || this.#disposed) return;
    // Another runtime may have confirmed the running source at a later
    // release while this one reconciled, so the record written keeps the later
    // time, read again inside the commit.
    const stored = getPieceReconciliation(resultCell);
    if (
      samePieceReconciliation(
        stored,
        keepLaterConfirmation(
          stored,
          recorded,
          getPatternIdentityRef(resultCell)?.identity,
        ),
      )
    ) return;
    await this.#commit(resultCell, state, signal, (tx) => {
      const view = resultCell.withTx(tx);
      setPieceReconciliation(
        resultCell,
        tx,
        keepLaterConfirmation(
          getPieceReconciliation(view),
          recorded,
          getPatternIdentityRef(view)?.identity,
        ),
      );
      return true;
    });
  }

  /** Follow the origin the piece records, whichever kind it turns out to be. */
  async #dispatch(
    resultCell: Cell<unknown>,
    state: FollowedPieceState,
    signal: AbortSignal,
  ): Promise<ReconcileOutcome> {
    const host = this.#runtime.hostForSpace(state.space).href;
    let origin = classifyPieceOriginString(state.storedSource, host);

    if (origin.kind === "legacy-path") {
      // A rooted path predates the `system:` scheme. Rewrite it to the ref
      // naming the same file, which is host-relative and therefore survives the
      // space moving hosts, then follow that ref. A path that addresses nothing
      // under the patterns route names no file this deployment serves: it would
      // resolve against the host and fetch whatever the site answers for an
      // unrouted path, so nothing follows it.
      if (origin.ref === undefined) {
        this.#unwatchSource(resultCell);
        return "unusable";
      }
      const migrated = await this.#recordOrigin(
        resultCell,
        state,
        origin.ref,
        "origin-update",
      );
      if (migrated !== "migrated") return migrated;
      state.storedSource = origin.ref;
      state.snapshot = getPieceSourceSnapshot(resultCell)!;
      origin = classifyPieceOriginString(origin.ref, host);
      const followed = await this.#follow(
        resultCell,
        state,
        origin,
        signal,
      );
      return followed === "current" ? "migrated" : followed;
    }

    return await this.#follow(resultCell, state, origin, signal);
  }

  #follow(
    resultCell: Cell<unknown>,
    state: FollowedPieceState,
    origin: PieceOriginKind,
    signal: AbortSignal,
  ): Promise<ReconcileOutcome> {
    const key = this.#followerKey(resultCell);
    this.#systemFollowers.delete(key);
    switch (origin.kind) {
      case "unusable":
        logger.warn("unusable-origin", () => [
          "a piece records an origin nothing can follow",
          state.space,
          origin.reason,
        ]);
        this.#unwatchSource(resultCell);
        return Promise.resolve("unusable");
      case "fabric-pattern":
      case "fabric-entity":
        return this.#followFabric(resultCell, state, origin, signal);
      case "system":
        this.#unwatchSource(resultCell);
        // A pass that a stop aborted while a legacy origin migrated must not
        // follow the piece the stop released.
        if (!signal.aborted && !this.#disposed) {
          this.#systemFollowers.set(key, resultCell);
        }
        return this.#followSystem(
          resultCell,
          state,
          origin,
          signal,
        );
      case "legacy-path":
        // Rewritten before dispatch.
        return Promise.resolve("unusable");
    }
  }

  /**
   * Follows a pattern this deployment's toolshed serves. An entry-only identity
   * match needs no stored-source read; a mismatch loads the retained source
   * roots and checks their combined identity before downloading an update.
   */
  async #followSystem(
    resultCell: Cell<unknown>,
    state: PieceState,
    origin: Extract<PieceOriginKind, { kind: "system" }>,
    signal: AbortSignal,
    claim?: OriginClaim,
  ): Promise<ReconcileOutcome> {
    // Read before anything can end the pass, so that an attempt that fails
    // leaves the record confirming what the last one did.
    const runningRelease = knownPieceReleasedAt(resultCell, state.running);
    if (runningRelease !== undefined) {
      state.confirmed = {
        identity: state.running.identity,
        releasedAt: runningRelease,
      };
    }
    const fetch = this.#revalidatingFetch(signal);
    const target = this.#systemSourceUrl(origin.route, state.space);
    let answer = await this.#advertisedIdentity(target, fetch, signal);
    if ("detail" in answer) {
      state.detail = answer.detail;
      return "unavailable";
    }
    let sourceRoots: readonly string[] = [];
    // Attached roots participate in the stored identity. An entry-only match
    // therefore needs no stored-source verification or compiler-stack load.
    if (answer.identity !== state.running.identity) {
      const stored = await this.#runtime.patternManager
        .getPatternSourceProgramByIdentity(
          state.running.identity,
          state.space,
        );
      signal.throwIfAborted();
      // Missing stored source permits rebuilding the entry and recording the
      // displaced identity. Roots can only be retained from a verified program.
      sourceRoots = stored?.sourceRoots ?? [];
      if (sourceRoots.length > 0) {
        answer = await this.#advertisedIdentity(
          target,
          fetch,
          signal,
          sourceRoots,
        );
        if ("detail" in answer) {
          state.detail = answer.detail;
          return "unavailable";
        }
      }
    }
    const advertised = answer.identity;
    const offered = { identity: advertised, symbol: state.running.symbol };
    state.offered = offered;
    // A later release of the source the piece already runs moves its release
    // time forward, so that an earlier release than that one, still served
    // elsewhere, cannot take its place.
    if (
      advertised === state.running.identity &&
      answer.releasedAt !== undefined &&
      (runningRelease === undefined || answer.releasedAt > runningRelease)
    ) {
      state.confirmed = {
        identity: advertised,
        releasedAt: answer.releasedAt,
      };
    }
    // The identity route settles whether the source moved. It says nothing
    // about whether this space still holds the compiled artifact for it, and a
    // piece whose artifact is gone cannot start however current its identity
    // is — so an unchanged identity whose artifact will not load falls through
    // to compile the source again, which puts the artifact back.
    if (
      advertised === state.running.identity &&
      await this.#loadPattern(state.running, state.space) !== undefined
    ) return "current";
    if (
      advertised !== state.running.identity &&
      isEarlierRelease(answer.releasedAt, runningRelease) &&
      keepsRunningSource(
        resultCell,
        state.running,
        offered,
        await this.#loadPattern(state.running, state.space) !== undefined,
      )
    ) {
      logger.debug("reconcile-earlier-release", () => [
        "not adopting an earlier release than the one this piece runs",
        state.space,
        resultCell.sourceURI,
        offered,
      ]);
      // The record names the source the piece runs, which the later release
      // offered, rather than the earlier offer, which the line above names.
      // Two hosts offering the two in turn then leave one record, where
      // naming each offer would rewrite it on every open.
      state.offered = { ...state.running };
      return "ahead";
    }
    if (this.#refusedBefore(resultCell, state, offered)) return "rejected";

    const resolved = await this.#runtime.harness.resolve(
      new HttpProgramResolver(target.href, fetch),
      { sourceRoots },
    );
    return await this.#adopt(
      resultCell,
      state,
      { ...resolved, mainExport: state.running.symbol },
      origin,
      signal,
      answer,
      claim,
    );
  }

  /** Where the host serving `space` answers for a `system:` origin's route. */
  #systemSourceUrl(route: string, space: MemorySpace): URL {
    return new URL(route, this.#runtime.hostForSpace(space));
  }

  /**
   * The identity the source at `target` currently compiles to, per the host
   * serving it, with the time the host released it when it states one, or why
   * that host did not say — which a caller with a piece to report on records
   * as the reason it is not following its origin. A release time that is not
   * one is such a reason: the host has said something about which release it
   * serves, and nothing can tell what.
   *
   * A request that throws rather than answering is the commonest way an origin
   * is out of reach, and it answers here like any other refusal rather than
   * escaping: a runtime built with no patterns route behind its API address —
   * a pattern test's, a tool's — reaches this on every open, where the origin
   * being unavailable is the ordinary state rather than a fault worth
   * reporting. What the throw said is kept as the reason. An abort still
   * propagates, because teardown asking the pass to stop is not the origin
   * failing to answer.
   */
  async #advertisedIdentity(
    target: URL,
    fetch: typeof globalThis.fetch,
    signal: AbortSignal,
    sourceRoots: readonly string[] = [],
  ): Promise<AdvertisedSource | { detail: string }> {
    const identityUrl = new URL(target);
    identityUrl.searchParams.set("identity", "");
    for (const root of sourceRoots) {
      identityUrl.searchParams.append("sourceRoot", root);
    }
    let response: Response;
    try {
      response = await fetch(identityUrl);
    } catch (error) {
      signal.throwIfAborted();
      return { detail: reconciliationDetail(error) };
    }
    if (!response.ok) {
      return { detail: `the origin answered ${response.status}` };
    }
    const advertised = (await abortable(() => response.text(), signal)).trim();
    if (advertised.length === 0) {
      return { detail: "the origin did not say which version it is offering" };
    }
    const releaseHeader = response.headers.get(RELEASED_AT_HEADER);
    if (releaseHeader === null) return { identity: advertised };
    const releasedAt = parseReleaseTime(releaseHeader.trim());
    if (releasedAt === undefined) {
      return {
        detail:
          debugStr`the origin's release time is not a time: $quote${releaseHeader}`,
      };
    }
    return { identity: advertised, releasedAt };
  }

  /** Whether this space can still load a pattern, without throwing to say no. */
  async #loadPattern(
    ref: { identity: string; symbol: string },
    space: MemorySpace,
  ): Promise<Pattern | undefined> {
    try {
      return await this.#runtime.patternManager.loadPatternByIdentity(
        ref.identity,
        ref.symbol,
        space,
      );
    } catch {
      return undefined;
    }
  }

  /**
   * The pattern a supplied origin currently names, for a piece that does not
   * exist yet.
   *
   * Each open revalidates the advertised identity. Opens for the same
   * destination, target and advertised identity share resolved source, and
   * the first to compile it into that destination verifies that it compiles
   * to the advertised identity, including the source-closure persistence of a
   * compiler cache hit. Opens arriving while that compile runs share it, and
   * later opens in the same schema registry epoch answer with the verified
   * pattern, whose closure the destination already holds.
   */
  async #resolveSupplied(
    space: MemorySpace,
    origin: Extract<PieceOriginKind, { kind: "system" }>,
  ): Promise<Pattern | undefined> {
    return await this.#track(async (signal) => {
      const fetch = this.#revalidatingFetch(signal);
      const target = this.#systemSourceUrl(origin.route, space);
      const answer = await this.#advertisedIdentity(target, fetch, signal);
      // Nothing here has a piece to report the reason on: the surface this is
      // resolving for does not exist yet.
      if ("detail" in answer) return undefined;
      const advertised = answer.identity;
      const key = stringTupleKey([space, target.href, advertised]);
      const resolved = await this.#resolveSuppliedSource(
        key,
        target,
        fetch,
        signal,
      );
      // A stopped pass answers with nothing, kept pattern or not.
      signal.throwIfAborted();
      const epoch = schemaRegistryEpoch();
      if (resolved.compiled?.epoch === epoch) return resolved.compiled.pattern;
      let flight = this.#suppliedCompileFlights.get(key);
      if (flight?.epoch !== epoch) {
        const started = {
          promise: this.#compileSupplied(
            key,
            resolved,
            space,
            advertised,
            signal,
            epoch,
          ),
          epoch,
        };
        flight = started;
        this.#suppliedCompileFlights.set(key, started);
        void started.promise.catch(() => {}).finally(() => {
          if (this.#suppliedCompileFlights.get(key) === started) {
            this.#suppliedCompileFlights.delete(key);
          }
        });
      }
      const compiled = await flight.promise;
      // The compile answers for the pass that started it, and this pass may
      // have been stopped since.
      signal.throwIfAborted();
      return compiled;
    });
  }

  /**
   * Helper for `#resolveSupplied()`, which compiles `resolved` into the
   * destination `space`, verifies that it compiles to `advertised`, and keeps
   * the pattern when the schema registry is still in the `epoch` it started
   * in.
   */
  async #compileSupplied(
    key: string,
    resolved: SuppliedSource,
    space: MemorySpace,
    advertised: string,
    signal: AbortSignal,
    epoch: number,
  ): Promise<Pattern | undefined> {
    try {
      // The destination must hold the closure behind its creation revision.
      // A compiler hit still performs the destination's persistence work.
      await prepareSourceClosureVerification();
      // Compiling writes to storage; a stopped pass must leave it alone.
      signal.throwIfAborted();
      const compiled = await this.#runtime.patternManager.compilePattern(
        copySourceProgram(resolved.program),
        { space },
      );
      signal.throwIfAborted();
      const ref = this.#runtime.patternManager.getArtifactEntryRef(compiled);
      if (ref?.identity !== advertised) {
        this.#forgetSuppliedSource(key, resolved);
        logger.warn("advertised-identity-mismatch", () => [
          "resolved source did not compile to the identity its origin advertises",
          space,
          advertised,
          ref,
        ]);
        return undefined;
      }
      // A pattern compiled across a registry clear carries references the
      // clear retired, so it is answered but not kept.
      if (schemaRegistryEpoch() === epoch) {
        resolved.compiled = { pattern: compiled, epoch };
      }
      return compiled;
    } catch (error) {
      this.#forgetSuppliedSource(key, resolved);
      throw error;
    }
  }

  /** Share supplied-source downloads, whose callers share disposal ownership. */
  async #resolveSuppliedSource(
    key: string,
    target: URL,
    fetch: typeof globalThis.fetch,
    signal: AbortSignal,
  ): Promise<SuppliedSource> {
    signal.throwIfAborted();
    const cached = this.#suppliedSources.get(key);
    if (cached !== undefined) return cached;
    const pending = this.#suppliedSourceFlights.get(key);
    if (pending !== undefined) return await pending;
    const flight = this.#runtime.harness.resolve(
      new HttpProgramResolver(target.href, fetch),
    ).then((program) => {
      signal.throwIfAborted();
      const retained: SuppliedSource = { program: copySourceProgram(program) };
      // LRUCache retains a single oversized entry; source retention has a hard
      // string budget, so such a program serves only the callers in flight.
      if (suppliedSourceWeight(key, retained) <= SUPPLIED_SOURCE_MAX_WEIGHT) {
        this.#suppliedSources.put(key, retained);
      }
      return retained;
    }).finally(() => {
      if (this.#suppliedSourceFlights.get(key) === flight) {
        this.#suppliedSourceFlights.delete(key);
      }
    });
    this.#suppliedSourceFlights.set(key, flight);
    return await flight;
  }

  /** A late failure may retire only the source used by its own attempt. */
  #forgetSuppliedSource(key: string, source: SuppliedSource): void {
    if (this.#suppliedSources.get(key) === source) {
      this.#suppliedSources.delete(key);
    }
  }

  /**
   * Record the origin the runtime has been instantiating a piece from, for one
   * that carries none.
   *
   * The piece runs this source already, so nothing about what it runs changes;
   * what changes is that the piece now says where that source came from, which
   * is what puts it inside the lifecycle instead of beside it.
   *
   * Only reached for a piece that runs a pattern, which is what gives it a
   * snapshot to guard the write against.
   */
  async #claimSuppliedOrigin(
    resultCell: Cell<unknown>,
    suppliedOrigin: string,
  ): Promise<void> {
    const state: PieceState = {
      space: resultCell.space,
      running: getPatternIdentityRef(resultCell)!,
      storedSource: undefined,
      snapshot: getPieceSourceSnapshot(resultCell)!,
    };
    await this.#recordOrigin(resultCell, state, suppliedOrigin, "follow");
  }

  /**
   * Give a piece that records no origin, and runs a pattern this space cannot
   * load, the supplied origin and the source it currently names — in one
   * transition, so that the piece is never left recording an origin over a
   * pattern nothing can start.
   *
   * Claiming an origin retains what the piece runs, and a pattern that will
   * not load has nothing to retain. The history this transition begins starts
   * at the adopted source, and the identity it displaced is recorded beside
   * it. Answers whether the piece now records the origin and runs its
   * source.
   */
  async #rescueSupplied(
    piece: Cell<unknown>,
    origin: Extract<PieceOriginKind, { kind: "system" }>,
  ): Promise<boolean> {
    const state: PieceState = {
      space: piece.space,
      running: getPatternIdentityRef(piece)!,
      storedSource: undefined,
      snapshot: getPieceSourceSnapshot(piece)!,
    };
    const outcome = await this.#track((signal) =>
      this.#followSystem(piece, state, origin, signal, {
        operation: "follow",
        origin: origin.ref,
      })
    );
    return outcome === "updated";
  }

  /** Run one aborting network pass, so teardown can stop and wait for it. */
  #track<T>(
    pass: (signal: AbortSignal) => Promise<T | undefined>,
  ): Promise<T | undefined> {
    if (this.#disposed) return Promise.resolve(undefined);
    const abort = new AbortController();
    // Register the pass before invoking caller-supplied fetch code, which can
    // initiate disposal synchronously.
    const done: Promise<T | undefined> = Promise.resolve()
      .then(() => {
        abort.signal.throwIfAborted();
        return pass(abort.signal);
      })
      .catch((error) => {
        logger.warn("source-pass-failed", () => [
          "resolving supplied source failed",
          error,
        ]);
        return undefined;
      })
      .finally(() => {
        this.#passes.delete(entry);
      });
    const entry: SourcePass = { abort, done };
    this.#passes.add(entry);
    return done;
  }

  /**
   * Source inside the fabric.
   *
   * An unpinned URL names another piece, or another mutable entity carrying a
   * pattern identity: the follower adopts whatever pattern that entity
   * currently runs, and subscribes so a later change reaches it while it is
   * running. A pinned or content-addressed URL names exact source instead. It
   * is resolved and adopted the same way, but it can never name anything else,
   * so there is nothing to subscribe to and, once adopted, nothing left for it
   * to report.
   *
   * TODO(hixie): store the export symbol a pinned origin selected. A pin fixes
   * the pattern identity, not the export, and the origin string carries only
   * the identity — so the symbol the piece already runs is reused, and a pinned
   * origin can never move a piece to a different export of the same source.
   */
  async #followFabric(
    resultCell: Cell<unknown>,
    state: FollowedPieceState,
    origin: Extract<
      PieceOriginKind,
      { kind: "fabric-entity" | "fabric-pattern" }
    >,
    signal: AbortSignal,
  ): Promise<ReconcileOutcome> {
    const runtime = this.#runtime;
    const destinationSpace = state.space;
    const ref = origin.ref;
    if (ref.subpath !== undefined || ref.ref.kind !== "uri") {
      this.#unwatchSource(resultCell);
      return "unusable";
    }
    const named = ref.space ?? destinationSpace;
    if (!isDID(named)) {
      this.#unwatchSource(resultCell);
      return "unusable";
    }
    const sourceSpace = named;
    if (
      ref.host !== undefined &&
      !fabricAuthorityMatchesSpaceHost(
        ref.host,
        runtime.hostForSpace(sourceSpace),
      )
    ) {
      this.#unwatchSource(resultCell);
      return "unavailable";
    }

    let target: { identity: string; symbol: string } | undefined;
    if (origin.kind === "fabric-pattern") {
      this.#unwatchSource(resultCell);
      target = { identity: origin.identity, symbol: state.running.symbol };
    } else {
      const sourceCell = runtime.getCellFromEntityId(
        sourceSpace,
        `${ref.ref.scheme}:fid1:${ref.ref.hash}`,
      );
      target = await abortable(async () => {
        await sourceCell.sync();
        if (
          this.#disposed || signal.aborted ||
          this.#stoppedFabricFollowers.has(this.#followerKey(resultCell))
        ) return undefined;
        const current = getPatternIdentityRef(sourceCell);
        if (current !== undefined) {
          this.#watchFabricSource(
            resultCell,
            sourceCell,
            state.storedSource,
            current,
          );
        }
        return current;
      }, signal);
    }
    if (target === undefined) return "unavailable";
    // What the origin turned out to name, whichever way this arrives at it,
    // so that the record identifies the source this evaluated even when
    // nothing moved and even when adopting it fails.
    state.offered = target;
    if (
      target.identity === state.running.identity &&
      target.symbol === state.running.symbol
    ) return "current";
    if (this.#refusedBefore(resultCell, state, target)) return "rejected";

    // Awaited directly rather than through the abort signal. The lookup
    // synchronizes a source closure against storage, and abandoning the await
    // would let disposal close storage while that read is still running. The
    // wait is what keeps teardown behind it.
    const program = await runtime.patternManager
      .getPatternSourceProgramByIdentity(
        target.identity,
        sourceSpace,
        destinationSpace,
      );
    if (program === undefined) return "unavailable";
    return await this.#adopt(
      resultCell,
      state,
      { ...program, mainExport: target.symbol },
      origin,
      signal,
      { identity: target.identity },
    );
  }

  /**
   * Compile a resolved candidate, check it may replace what is running, and
   * commit the transition and the swap together.
   *
   * `advertised`, where the origin supplied one, names the identity the
   * candidate must compile to: a source that does not produce the identity its
   * own origin advertises is not the source that origin names. The release
   * time beside it, where there is one, is recorded on the revision that
   * adopts the candidate.
   *
   * The transition records the origin the piece already follows, as an
   * update to it. A `claim` records a different one instead: the origin a
   * piece that followed none is being given, with the adoption as the
   * revision that gives it.
   */
  async #adopt(
    resultCell: Cell<unknown>,
    state: PieceState,
    program: Parameters<Runtime["patternManager"]["compilePattern"]>[0],
    origin: PieceOriginKind,
    signal: AbortSignal,
    advertised?: AdvertisedSource,
    claim?: OriginClaim,
  ): Promise<ReconcileOutcome> {
    const runtime = this.#runtime;
    if (signal.aborted) return "unavailable";
    const replacements = this.#replacementsOf(state.space);
    const candidate = await runtime.patternManager.compilePattern(program, {
      space: state.space,
    });
    const candidateRef = runtime.patternManager.getArtifactEntryRef(candidate);
    if (candidateRef === undefined) {
      logger.warn("candidate-without-identity", () => [
        "resolved source produced no pattern identity",
        state.space,
        state.storedSource,
      ]);
      return "unavailable";
    }
    if (
      advertised !== undefined &&
      candidateRef.identity !== advertised.identity
    ) {
      logger.warn("advertised-identity-mismatch", () => [
        "resolved source did not compile to the identity its origin advertises",
        state.space,
        advertised.identity,
        candidateRef,
      ]);
      state.detail =
        "the source did not match the version its origin advertised";
      return "unavailable";
    }
    state.offered = candidateRef;
    if (
      candidateRef.identity === state.running.identity &&
      candidateRef.symbol === state.running.symbol
    ) return "current";

    const refusal = origin.kind === "system"
      ? undefined
      : await this.#refusal(state, candidate);
    if (refusal !== undefined) {
      logger.warn("incompatible-source-update", () => [
        "the origin's current source cannot replace what this piece runs",
        state.space,
        state.running,
        candidateRef,
        refusal,
      ]);
      state.detail = refusal;
      return "incompatible";
    }

    const baseline = await preparePieceSourceTransitionBaseline(
      runtime,
      resultCell,
      state.snapshot,
      { allowUnavailable: true },
    );
    // A release re-mints every handler identity in the file, so a field the
    // running pattern's handler protects would refuse the successor's write
    // and the update could not commit. For a `system:` origin — a release the
    // deployment gated — the successor inherits the predecessor's authority
    // the way an explicit `setsrc` grants it (SC-22). Every other origin
    // stays as it is: nobody promised anything about what it ships.
    const sourceUpdate = origin.kind === "system" && baseline.kind === "retain"
      ? await runtime.patternManager.prepareSourceUpdate(
        state.space,
        state.running.identity,
        candidateRef.identity,
      )
      : undefined;
    const transition: PieceSourceTransition = {
      revisionId: crypto.randomUUID(),
      baseline,
      timestamp: Date.now(),
      operation: claim?.operation ?? "origin-update",
      origin: claim?.origin ?? state.storedSource ?? null,
      expected: state.snapshot,
      ...(advertised?.releasedAt === undefined
        ? {}
        : { releasedAt: advertised.releasedAt }),
    };
    // Setting up the candidate restages the piece's stored argument against
    // its schema, so that document has to be local before the transaction
    // opens, and still what it was when the transaction commits. A concurrent
    // argument change means the setup would stage a value nobody asked for.
    // The guard's snapshot is taken first: an argument that changes while
    // the family below loads is what the guard refuses at commit, so no
    // candidate is set up over reads that were named for another argument.
    const argumentUnchanged = await runtime.syncStoredSetupArgument(resultCell);
    // The setup also writes over the cells the stored piece owns — each one's
    // backlink at least — and a write to a document this replica has not
    // loaded replaces the document the store holds, so they are named too,
    // with what the candidate's nodes read, each under its reader's schema.
    await runtime.runner.syncStoredPieceCells(resultCell, candidate);
    // A `system:` candidate is ordered against the release the piece runs
    // when the commit lands, not only when this pass began: another runtime
    // can confirm the running source at a later release while this one
    // prepares. The order is read again inside the commit, so a confirmation
    // that lands first makes this commit stale and its retry decline. Whether
    // the piece keeps its running source against an earlier candidate is
    // decided there too, by the history the commit reads.
    const ordered = origin.kind === "system";
    const loadable = ordered &&
      await this.#loadPattern(state.running, state.space) !== undefined;
    let overtaken = false;
    const failure = await this.#commit(resultCell, state, signal, (tx) => {
      overtaken = false;
      if (!argumentUnchanged(resultCell.withTx(tx))) return false;
      if (
        ordered &&
        isEarlierRelease(
          advertised?.releasedAt,
          knownPieceReleasedAt(resultCell.withTx(tx), state.running),
        ) &&
        keepsRunningSource(
          resultCell.withTx(tx),
          state.running,
          candidateRef,
          loadable,
        )
      ) {
        overtaken = true;
        return false;
      }
      if (sourceUpdate !== undefined) {
        runtime.patternManager.stageSourceUpdate(
          sourceUpdate,
          state.space,
          state.running.identity,
          candidateRef.identity,
          tx,
        );
      }
      applyPieceSourceTransition(
        runtime,
        resultCell,
        tx,
        candidateRef,
        transition,
      );
      // Staging the candidate belongs to this transaction whether or not the
      // piece is running, so a refusal costs nothing either way: setup that
      // cannot take the piece's data fails the transaction and the piece keeps
      // what it has. A running piece is then re-instantiated by the pattern
      // watcher, which sees its own completion marker and does not stage it a
      // second time.
      void runtime.setup(tx, candidate, undefined, resultCell.withTx(tx), {
        prepareForResume: true,
      });
      return true;
    }, sourceUpdate);
    if (overtaken) {
      // The piece keeps what it runs, as an earlier offer leaves it, and the
      // record confirms that source at the release time that overtook this
      // candidate.
      const confirmedAt = knownPieceReleasedAt(resultCell, state.running);
      state.offered = { ...state.running };
      if (confirmedAt !== undefined) {
        state.confirmed = {
          identity: state.running.identity,
          releasedAt: confirmedAt,
        };
      }
      return "ahead";
    }
    if (failure === undefined) {
      // The adopting revision records the release time; a record confirming
      // the source just displaced would describe a piece no longer running it.
      state.confirmed = advertised?.releasedAt === undefined ? undefined : {
        identity: candidateRef.identity,
        releasedAt: advertised.releasedAt,
      };
      return "updated";
    }
    state.detail = failure.detail;
    if (failure.lasting === undefined) return "unavailable";
    if (replacements !== this.#replacementsOf(state.space)) return "rejected";
    // The refused commit wrote nothing, so the envelopes stored now are the
    // ones the refusing merge read.
    let envelopes: string | undefined;
    if (failure.lasting === "stored-envelope") {
      envelopes = this.#storedEnvelopes(resultCell);
      if (envelopes === undefined) return "rejected";
    }
    this.#refusedAdoptions.set(this.#followerKey(resultCell), {
      space: state.space,
      offered: candidateRef,
      snapshot: state.snapshot,
      ...(envelopes === undefined ? {} : { envelopes }),
      detail: failure.detail,
    });
    return "rejected";
  }

  /** How many times `space`'s memory session has been replaced. */
  #replacementsOf(space: MemorySpace): number {
    return this.#sessionReplacements.get(space) ?? 0;
  }

  /**
   * The envelopes the argument and result documents of the piece over
   * `resultCell` store, as one key: each one's schema hash, or `none` where it
   * stores none. `undefined` where either could not be read, which leaves
   * nothing to remember a refusal by. Only each envelope's own record is read,
   * never the schema it names, which grows with the piece's releases.
   */
  #storedEnvelopes(resultCell: Cell<unknown>): string | undefined {
    const tx = this.#runtime.edit();
    try {
      return [resultCell.getArgumentCell(), resultCell].map((cell) => {
        if (cell === undefined) return "none";
        const { space, id, scope } = cell.getAsNormalizedFullLink();
        return readStoredCfcSchemaHash(tx, { space, id, scope }) ?? "none";
      }).join("\0");
    } catch {
      return undefined;
    } finally {
      tx.abort();
    }
  }

  /**
   * Whether this runtime saw the adoption of `offered` refused for good, and
   * nothing that refusal answered for has changed since. When it did, the
   * pass ends here with what the refusal recorded, which is the conclusion
   * building and sending the same write would reach again. A remembered
   * refusal something has moved under is forgotten.
   */
  #refusedBefore(
    resultCell: Cell<unknown>,
    state: PieceState,
    offered: { identity: string; symbol: string },
  ): boolean {
    const key = this.#followerKey(resultCell);
    const refused = this.#refusedAdoptions.get(key);
    if (refused === undefined) return false;
    if (
      refused.offered.identity !== offered.identity ||
      refused.offered.symbol !== offered.symbol ||
      !samePieceSourceSnapshot(refused.snapshot, state.snapshot) ||
      (refused.envelopes !== undefined &&
        this.#storedEnvelopes(resultCell) !== refused.envelopes)
    ) {
      this.#refusedAdoptions.delete(key);
      return false;
    }
    state.offered = refused.offered;
    state.detail = refused.detail;
    logger.debug("reconcile-refusal-remembered", () => [
      "not proposing source whose adoption was refused for good",
      state.space,
      resultCell.sourceURI,
      refused.offered,
    ]);
    return true;
  }

  /**
   * Why a candidate may not replace what is running, or undefined when it may.
   *
   * An unattended update to an origin this deployment does not gate the
   * releases of requires the piece's contract not to move at all. That is
   * conservative to the point of refusing changes a piece could take, and
   * the lifecycle spec asks instead for the relation a replacement made by
   * hand has to satisfy — which is the ungated-origin rule, specified and not
   * built.
   *
   * A piece whose current pattern cannot be loaded has nothing left to protect:
   * it cannot run at all, so its origin's source is a rescue rather than a
   * risk, and it is adopted without a comparison there is no way to make.
   */
  async #refusal(
    state: PieceState,
    candidate: Pattern,
  ): Promise<string | undefined> {
    let previous: Pattern | undefined;
    try {
      previous = await this.#runtime.patternManager.loadPatternByIdentity(
        state.running.identity,
        state.running.symbol,
        state.space,
      );
    } catch {
      return undefined;
    }
    if (previous === undefined) return undefined;
    if (!deepEqual(previous.argumentSchema, candidate.argumentSchema)) {
      return "the candidate's argument schema differs from the accepted one";
    }
    if (!deepEqual(previous.resultSchema, candidate.resultSchema)) {
      return "the candidate's result schema differs from the accepted one";
    }
    return undefined;
  }

  /**
   * Change which origin a piece records, leaving the source it runs alone.
   *
   * `origin-update` rewrites a recorded origin into its canonical spelling.
   * `follow` gives an origin to a piece that had none.
   */
  async #recordOrigin(
    resultCell: Cell<unknown>,
    state: PieceState,
    ref: string,
    operation: "origin-update" | "follow",
  ): Promise<ReconcileOutcome> {
    const runtime = this.#runtime;
    const baseline = await preparePieceSourceTransitionBaseline(
      runtime,
      resultCell,
      state.snapshot,
      { allowUnavailable: true },
    );
    const transition: PieceSourceTransition = {
      revisionId: crypto.randomUUID(),
      baseline,
      timestamp: Date.now(),
      operation,
      origin: ref,
      expected: state.snapshot,
    };
    const failure = await this.#commit(
      resultCell,
      state,
      undefined,
      (tx) => {
        applyPieceSourceTransition(
          runtime,
          resultCell,
          tx,
          state.running,
          transition,
        );
        return true;
      },
    );
    if (failure === undefined) return "migrated";
    state.detail = failure.detail;
    return "unavailable";
  }

  /**
   * Apply a write under the state this reconciliation read. Every attempt
   * re-checks that state, so a concurrent edit, detach, or repoint is never
   * overwritten by a decision taken before it.
   *
   * Returns `undefined` once the write commits, and otherwise why it did not:
   * the error that stopped the commit, or the piece having changed under the
   * write. A failure is logged as a summary of the error, since the error
   * carries the whole transaction the store refused; the error itself is
   * logged at debug level.
   */
  async #commit(
    resultCell: Cell<unknown>,
    state: PieceState,
    signal: AbortSignal | undefined,
    write: (tx: Parameters<typeof applyPieceSourceTransition>[2]) => boolean,
    sourceUpdate?: PreparedSourceUpdate,
  ): Promise<CommitFailure | undefined> {
    const runtime = this.#runtime;
    const result = await runtime.editWithRetry(
      (tx) => {
        // editWithRetry re-runs this callback after a retryable rejection, and a
        // stop can abort between attempts, so every attempt re-enters the gate.
        // Throwing ends the retry loop; aborting the transaction would be
        // classified as retryable and consume the remaining attempts.
        signal?.throwIfAborted();
        const candidate = resultCell.withTx(tx);
        const currentRef = getPatternIdentityRef(candidate);
        // The piece must still run what the candidate was compared against, and
        // still record the origin that was resolved. Nothing else decides this
        // transition, so nothing else is guarded: the setup marker in
        // particular is written by setup, which this transition triggers.
        if (
          currentRef?.identity !== state.running.identity ||
          currentRef.symbol !== state.running.symbol ||
          getPatternSource(candidate) !== state.storedSource
        ) return false;
        // The reconciler runs from a raw promise, with no scheduler run to stamp
        // it — bookkeeping per serving-loop.md §3d, RULED 2026-08-05.
        // An update carrying writer inheritance registers its grant from the
        // store's verdict, so a serving loop commits it directly rather than
        // inside a wave it could withdraw.
        runtime.stampServerRun(tx, {
          actionId: `source-reconcile/${resultCell.sourceURI}`,
          kind: "bookkeeping",
          ...(sourceUpdate === undefined ? {} : { directCommit: true }),
        });
        return write(tx);
      },
      undefined,
      { sourceUpdate },
    );
    if (signal?.aborted) {
      return { detail: "the reconciliation was stopped", lasting: undefined };
    }
    if (result.error) {
      const { name, message } = result.error;
      const lasting: LastingRefusal | undefined =
        isOversizedRejection(result.error)
          ? "too-large"
          : isEnvelopeStabilityRefusal(result.error)
          ? "stored-envelope"
          : undefined;
      logger.warn("reconcile-commit-failed", () => [
        lasting !== undefined
          ? "the store refused a source reconciliation's write for good"
          : "source reconciliation could not commit",
        state.space,
        resultCell.sourceURI,
        state.offered,
        debugStr`${name}: $long${message}`,
      ]);
      logger.debug("reconcile-commit-failed-detail", () => [
        "the failure the line above summarizes, whole",
        state.space,
        resultCell.sourceURI,
        result.error,
      ]);
      return { detail: reconciliationDetail(result.error), lasting };
    }
    return result.ok === true ? undefined : {
      detail: "the piece changed while its write was being prepared",
      lasting: undefined,
    };
  }

  /**
   * Every request revalidates its checksum ETag. Unchanged bytes may be reused
   * after a 304, but never without asking the source host whether they are
   * still current.
   */
  #revalidatingFetch(signal: AbortSignal): typeof globalThis.fetch {
    return (input, init) =>
      abortable(
        () =>
          this.#runtime.fetch(input, {
            ...init,
            cache: "no-cache",
            signal,
          }),
        signal,
      );
  }

  #watchFabricSource(
    follower: Cell<unknown>,
    source: Cell<unknown>,
    origin: string,
    targetRef: { identity: string; symbol: string },
  ): void {
    const followerKey = this.#followerKey(follower);
    const sourceLink = source.getAsNormalizedFullLink();
    const sourceKey = `${origin}\0${sourceLink.space}\0${
      sourceLink.scope ?? "space"
    }\0${sourceLink.id}`;
    const existing = this.#fabricFollowers.get(followerKey);
    if (existing?.sourceKey === sourceKey) return;
    existing?.cancel();
    let sourcePrimed = false;
    const cancelSource = source.sinkMeta("patternIdentity", (value) => {
      if (!sourcePrimed) {
        sourcePrimed = true;
        const candidate = value as Record<string, unknown>;
        if (
          isObjectNotArray(value) &&
          candidate.identity === targetRef.identity &&
          candidate.symbol === targetRef.symbol
        ) return;
      }
      this.#reconcileFromSourceEvent(follower);
    });
    let followerPrimed = false;
    const cancelFollower = follower.sinkMeta("patternSource", (value) => {
      if (!followerPrimed) {
        followerPrimed = true;
        if (value === origin) return;
      }
      this.#reconcileFromSourceEvent(follower);
    });
    this.#fabricFollowers.set(followerKey, {
      sourceKey,
      cancel: () => {
        cancelSource();
        cancelFollower();
      },
    });
  }

  /** Stops following the source of `follower`, whichever kind it is. */
  #unwatchSource(follower: Cell<unknown>): void {
    const key = this.#followerKey(follower);
    this.#fabricFollowers.get(key)?.cancel();
    this.#fabricFollowers.delete(key);
    this.#systemFollowers.delete(key);
  }
}
