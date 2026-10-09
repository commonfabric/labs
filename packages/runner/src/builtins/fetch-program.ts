import { internSchema } from "@commonfabric/data-model-schema";
import { HttpProgramResolver } from "@commonfabric/js-compiler/program";
import {
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";

import type { CellScope } from "../builder/types.ts";
import { type Cell } from "../cell.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import { createFrozenRequestSnapshot } from "../cfc/request-snapshot.ts";
import { enqueueSinkRequestPostCommitEffect } from "../cfc/sink-request.ts";
import { settleAbandonedRequest } from "./abandoned-request.ts";
import {
  effectTargetKey,
  markEffectCompletion,
} from "../executor/effect-completion.ts";
import {
  requireWaveAcceptance,
  waveRunContextOf,
  waveSettlementOf,
} from "../executor/wave.ts";
import { ensureCompilerStack } from "../harness/deferred-compiler-stack.ts";
import { setResultCell } from "../result-utils.ts";
import type { Runtime } from "../runtime.ts";
import { type Action } from "../scheduler.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { computeInputHashFromValue } from "./fetch-utils.ts";
import { ownedCell } from "./runtime-owned-store.ts";

/**
 * How long a `fetching` cache entry left by another replica is believed before
 * this one takes the resolution over.
 *
 * This is not a bound on resolving a program. A resolution running here ends
 * when its promise settles, and the entry it owns is never judged by elapsed
 * time — `inFlight` below answers "am I already resolving this?" from local
 * state. The bound applies only to an entry this replica did not claim, where
 * the question is whether the replica that claimed it is still there. Nothing
 * in the runner reports another replica's presence, so that question has no
 * event to wait on.
 *
 * The value is left where it was. Once an early takeover no longer costs a
 * result, the size is a trade with a cost on both sides: too low duplicates a
 * resolution whenever another replica looks in while one is running, too high
 * leaves a replica that arrives before the bound elapses looking at a claim it
 * will not take over and has no reason to re-examine, so the piece keeps
 * showing a spinner. A duplicated resolution is wasted work; a spinner that
 * never resolves is a dead end, so the trade goes to the lower value.
 *
 * `docs/features/fetch-request-deadlines.md` records why this bound stays
 * and what an early takeover costs.
 */
const PROGRAM_CLAIM_STALE_AFTER = 1000 * 10;

export interface ProgramResult {
  files: Array<{ name: string; contents: string }>;
  main: string;
}

// State machine for fetch lifecycle
type FetchState =
  | { type: "idle" }
  | { type: "fetching"; requestId: string; startTime: number }
  | { type: "success"; data: ProgramResult }
  | { type: "error"; message: string };

// Single source of truth for fetch status
interface FetchCacheEntry {
  inputHash: string;
  state: FetchState;
}

/** The node's symbolic state cells, shared by instances of one scope. */
interface ProgramCells {
  pending: Cell<boolean>;
  result: Cell<ProgramResult | undefined>;
  error: Cell<unknown>;
  cache: Cell<Record<string, FetchCacheEntry>>;
}

/** One accepted resolution, including work waiting for outbox dispatch. */
interface ProgramResolution {
  cache: Cell<Record<string, FetchCacheEntry>>;
  inputHash: string;
  requestId: string;
  acceptedPublications: Set<ProgramPublication>;
  identity?: ScopeKeyIdentity;
  controller?: AbortController;
}

/** A pending announcement for one physical output binding. */
interface ProgramPublication {
  bindingKey: string;
  target: string;
  sequence: number;
  selection: {
    acceptedSequence: number;
  };
  accepted?: boolean;
  finished?: boolean;
  effectKey?: string;
  resolution?: ProgramResolution;
}

const fetchProgramInputSchema = internSchema(
  {
    type: "object",
    properties: {
      url: { type: "string" },
    },
  },
);

function snapshotFetchProgramInputs(
  cell: Cell<{ url?: string; result?: ProgramResult }>,
): { url?: string } {
  const snapshot = cell.asSchema(fetchProgramInputSchema).get() ??
    ({} as { url?: string });
  return createFrozenRequestSnapshot({ url: snapshot.url });
}

// Full schema for cache structure to ensure proper validation when reading back
// from storage. Without this, nested arrays may have undefined elements due to
// incomplete schema-based transformation.
const cacheSchema = internSchema(
  {
    type: "object",
    default: {},
    additionalProperties: {
      type: "object",
      properties: {
        inputHash: { type: "string" },
        state: {
          anyOf: [
            { type: "object", properties: { type: { const: "idle" } } },
            {
              type: "object",
              properties: {
                type: { const: "fetching" },
                requestId: { type: "string" },
                startTime: { type: "number" },
              },
            },
            {
              type: "object",
              properties: {
                type: { const: "success" },
                data: {
                  type: "object",
                  properties: {
                    files: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          contents: { type: "string" },
                        },
                        required: ["name", "contents"],
                      },
                    },
                    main: { type: "string" },
                  },
                  required: ["files", "main"],
                },
              },
            },
            {
              type: "object",
              properties: {
                type: { const: "error" },
                message: { type: "string" },
              },
            },
          ],
        },
      },
    },
  },
);

/**
 * Fetch and resolve a program from a URL.
 *
 * Returns the resolved program as `result` with structure { files, main }.
 * `pending` is true while resolution is in progress.
 *
 * @param url - A cell containing the URL to fetch the program from.
 * @returns { pending: boolean, result: ProgramResult, error: any } - As individual cells.
 */
export function fetchProgram(
  inputsCell: Cell<{ url: string; result?: ProgramResult }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
  _outputBinding?: NormalizedFullLink,
  _awaitSync?: boolean,
  publicationBinding?: NormalizedFullLink,
): Action {
  const bindings = new Map<CellScope, ProgramCells>();
  const inFlight = new Map<string, ProgramResolution>();
  const publications = new Set<ProgramPublication>();
  let publicationSequence = 0;
  let stopped = false;

  /** Releases only the claim owned by this resolution's replica. */
  function releaseClaim(
    { cache, inputHash, requestId, identity }: ProgramResolution,
  ): void {
    let tx: IExtendedStorageTransaction | undefined;
    try {
      tx = runtime.edit();
      runtime.stampServerRun(tx, {
        actionId: `fetchProgram/teardown/${parentCell.sourceURI}`,
        kind: "bookkeeping",
        ...(identity !== undefined ? { scopeKeyIdentity: identity } : {}),
      });
      if (identity !== undefined) tx.tx.scopeKeyIdentity = identity;
      const entry = cache.withTx(tx).get()?.[inputHash];
      if (
        entry?.state.type === "fetching" &&
        entry.state.requestId === requestId
      ) {
        cache.withTx(tx).update({
          [inputHash]: { inputHash, state: { type: "idle" } },
        });
      }
      runtime.prepareTxForCommit(tx);
      tx.commit();
    } catch {
      tx?.abort();
    }
  }

  addCancel(() => {
    stopped = true;
    const resolutions = [...inFlight.values()];
    inFlight.clear();
    bindings.clear();
    publications.clear();
    for (const resolution of resolutions) {
      resolution.controller?.abort("Pattern stopped");
    }
    for (const resolution of resolutions) releaseClaim(resolution);
  });

  /** Retires deduplicated staging records with the work they share. */
  function finish(publication: ProgramPublication): void {
    publication.finished = true;
    const resolution = inFlight.get(publication.effectKey!);
    inFlight.delete(publication.effectKey!);
    for (const accepted of resolution?.acceptedPublications ?? []) {
      accepted.finished = true;
      publications.delete(accepted);
    }
    resolution?.acceptedPublications.clear();
    for (const other of publications) {
      if (other.effectKey !== publication.effectKey) continue;
      other.finished = true;
      if (other.accepted || other === publication) publications.delete(other);
    }
  }

  /** A durable announcement owns its binding even when the link is unchanged. */
  function observePublication(
    tx: IExtendedStorageTransaction,
    publication: ProgramPublication,
    ownership: "binding" | "request" = "request",
  ): void {
    requireWaveAcceptance(tx);
    const accept = () => {
      // Replacing an output binding does not relinquish its accepted request.
      publication.accepted = true;
      publication.selection.acceptedSequence = Math.max(
        publication.selection.acceptedSequence,
        publication.sequence,
      );
      for (const other of publications) {
        if (
          other.bindingKey === publication.bindingKey &&
          other.sequence < publication.sequence
        ) {
          other.selection.acceptedSequence = Math.max(
            other.selection.acceptedSequence,
            publication.sequence,
          );
          publications.delete(other);
        }
      }
      if (ownership === "binding") return;
      const resolution = publication.resolution;
      const effectKey = publication.effectKey;
      if (resolution === undefined || effectKey === undefined) return;
      if (stopped) {
        releaseClaim(resolution);
        return;
      }
      if (publication.finished) {
        publications.delete(publication);
        return;
      }
      // A deduplicated contribution can be accepted after its shared work
      // completed. Its durable cache entry retires that late attachment.
      const read = runtime.readTx();
      if (resolution.identity) read.tx.scopeKeyIdentity = resolution.identity;
      const state = resolution.cache.withTx(read).get()?.[
        resolution.inputHash
      ]?.state;
      if (state?.type !== "fetching") {
        publications.delete(publication);
        return;
      }
      const owner = inFlight.get(effectKey) ?? resolution;
      owner.acceptedPublications.add(publication);
      inFlight.set(effectKey, owner);
    };
    tx.addCommitCallback((committedTx, outcome) => {
      if (outcome.error) return;
      const settlement = waveSettlementOf(committedTx) ?? waveSettlementOf(tx);
      if (settlement) {
        settlement.then((verdict) => {
          if (!verdict.error) accept();
        });
      } else accept();
    });
  }

  /** Reuses symbolic cells while request records retain their issuing identity. */
  function cellsFor(
    tx: IExtendedStorageTransaction,
    scope: CellScope,
  ): ProgramCells {
    let cells = bindings.get(scope);
    if (cells !== undefined) return cells;
    const pending = ownedCell<boolean>(
      runtime,
      tx,
      parentCell,
      { fetchProgram: { pending: cause } },
      undefined,
      scope,
    );
    const result = ownedCell<ProgramResult | undefined>(
      runtime,
      tx,
      parentCell,
      { fetchProgram: { result: cause } },
      undefined,
      scope,
    );
    const error = ownedCell<unknown>(
      runtime,
      tx,
      parentCell,
      { fetchProgram: { error: cause } },
      undefined,
      scope,
    );
    const cache = ownedCell<Record<string, FetchCacheEntry>>(
      runtime,
      tx,
      parentCell,
      { fetchProgram: { cache: cause } },
      cacheSchema,
      scope,
    );
    for (const cell of [pending, result, error, cache]) {
      setResultCell(cell, parentCell);
      cell.sync();
    }
    cells = { pending, result, error, cache };
    bindings.set(scope, cells);
    return cells;
  }

  return (tx: IExtendedStorageTransaction) => {
    if (stopped) return;
    tx.resetNarrowestReadScope();
    const requestSnapshot = snapshotFetchProgramInputs(inputsCell.withTx(tx));
    const outputScope = tx.getNarrowestReadScope();
    const runIdentity = waveRunContextOf(tx)?.scopeKeyIdentity;
    const identity = runIdentity === undefined ? undefined : { ...runIdentity };
    const cells = cellsFor(tx, outputScope);
    const { pending, result, error, cache } = cells;
    const { url } = requestSnapshot;
    const inputHash = computeInputHashFromValue(requestSnapshot);
    const effectKey = effectTargetKey(
      `fetchProgram:${inputHash}`,
      cache,
      identity,
    );
    const publication: ProgramPublication = {
      bindingKey: identity === undefined || publicationBinding === undefined
        ? "local"
        : resolveScopeKey(publicationBinding.scope ?? "space", identity),
      target: effectTargetKey("publication", result),
      sequence: ++publicationSequence,
      selection: { acceptedSequence: 0 },
    };
    for (const other of publications) {
      if (other.bindingKey === publication.bindingKey) {
        publication.selection = other.selection;
        break;
      }
    }
    observePublication(tx, publication);

    if (!url) {
      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);
      error.withTx(tx).set(undefined);
      sendResult(tx, { pending, result, error });
      return;
    }

    const state = cache.withTx(tx).get()?.[inputHash]?.state ??
      { type: "idle" };
    const resolvingHere = inFlight.has(effectKey);
    const claimAbandoned = state.type === "fetching" && !resolvingHere &&
      Date.now() - state.startTime > PROGRAM_CLAIM_STALE_AFTER;

    if (!resolvingHere && (state.type === "idle" || claimAbandoned)) {
      const requestId = `${runtime.id}:${inputHash}`;
      const stagedResolution: ProgramResolution = {
        cache,
        inputHash,
        requestId,
        acceptedPublications: new Set(),
        identity,
      };
      publication.effectKey = effectKey;
      publication.resolution = stagedResolution;
      for (const other of publications) {
        if (
          other.bindingKey === publication.bindingKey &&
          other.target === publication.target
        ) {
          // Only accepted publication supersedes an earlier refusal. Retain
          // one staging record per binding/target; old callbacks share the
          // acceptance sequence without retaining a chain of retry attempts.
          publications.delete(other);
        }
      }
      publications.add(publication);
      cache.withTx(tx).update({
        [inputHash]: {
          inputHash,
          state: { type: "fetching", requestId, startTime: Date.now() },
        },
      });
      enqueueSinkRequestPostCommitEffect(
        tx,
        "fetchProgram",
        `fetchProgram:${inputHash}`,
        requestSnapshot,
        "fetchProgram-start",
        () => {
          if (stopped) {
            releaseClaim(stagedResolution);
            return;
          }
          const resolution = inFlight.get(effectKey) ?? stagedResolution;
          if (resolution.controller !== undefined) return;
          resolution.controller = new AbortController();
          inFlight.set(effectKey, resolution);
          runtime.trackAsyncWork(
            startFetch(
              runtime,
              cache,
              inputHash,
              url,
              resolution.controller.signal,
              effectKey,
              identity,
            ).finally(() => finish(publication)),
            parentCell,
          );
        },
        {
          idempotencyKey: effectKey,
          onReleaseRejected: () => {
            // Another accepted attachment owns its claim even before dispatch.
            const owner = inFlight.get(effectKey);
            owner?.acceptedPublications.delete(publication);
            if (
              owner === undefined ||
              (owner.controller === undefined &&
                owner.acceptedPublications.size === 0)
            ) {
              releaseClaim(owner ?? stagedResolution);
              finish(publication);
            } else {
              publication.finished = true;
              publications.delete(publication);
            }
          },
          onRejected: (rejection) => {
            if (stopped) return;
            runtime.trackAsyncWork(
              settleAbandonedRequest(
                runtime,
                "fetchProgram",
                effectKey,
                (settleTx) => {
                  if (identity !== undefined) {
                    settleTx.tx.scopeKeyIdentity = identity;
                  }
                  const entry = cache.withTx(settleTx).get()?.[inputHash];
                  const ownsFields = entry === undefined ||
                    entry.state.type === "idle";
                  if (ownsFields) {
                    cache.withTx(settleTx).update({
                      [inputHash]: {
                        inputHash,
                        state: { type: "error", message: rejection.message },
                      },
                    });
                  }
                  // A refusal may publish only while its inputs still select this
                  // cache. Other requests retain their own result and binding.
                  settleTx.resetNarrowestReadScope();
                  const current = snapshotFetchProgramInputs(
                    inputsCell.withTx(settleTx),
                  );
                  if (
                    settleTx.getNarrowestReadScope() !== outputScope ||
                    computeInputHashFromValue(current) !== inputHash
                  ) return;
                  if (
                    publication.sequence >=
                      publication.selection.acceptedSequence
                  ) {
                    sendResult(settleTx, { pending, result, error });
                    observePublication(settleTx, publication, "binding");
                  }
                  if (!ownsFields) return;
                  pending.withTx(settleTx).set(false);
                  result.withTx(settleTx).set(undefined);
                  error.withTx(settleTx).set(rejection.message);
                },
              ).finally(() => {
                // A failed refusal leaves one record through which an older
                // callback can observe the next accepted binding publication.
                if (
                  publication.selection.acceptedSequence >=
                    publication.sequence
                ) publications.delete(publication);
              }),
              parentCell,
            );
          },
        },
      );
    }

    const current = cache.withTx(tx).get()?.[inputHash]?.state ??
      { type: "idle" };
    pending.withTx(tx).set(current.type === "fetching");
    result.withTx(tx).set(
      current.type === "success" ? current.data : undefined,
    );
    error.withTx(tx).set(
      current.type === "error" ? current.message : undefined,
    );
    sendResult(tx, { pending, result, error });
  };
}

/**
 * Start fetching a program. The writeback lands only on an entry still marked
 * `fetching`, so a resolution whose entry has since reached `success` or
 * `error`, or been released, writes nothing. It deliberately does not require
 * the entry to carry *this* replica's claim id: after a takeover two
 * resolutions for the same input hash are running, they resolve the same URL,
 * and whichever finishes first should be the one that counts.
 *
 * The abort signal does not reach the network. `HttpProgramResolver` issues its
 * requests without one, so this checks the signal between steps: it suppresses
 * a writeback from a resolution nobody is waiting for, and does not end the
 * resolution.
 */
async function startFetch(
  runtime: Runtime,
  cache: Cell<Record<string, FetchCacheEntry>>,
  inputHash: string,
  url: string,
  abortSignal: AbortSignal,
  effectKey: string,
  identity?: ScopeKeyIdentity,
) {
  try {
    // The runtime's fetch, as the other source loads use, so a host that
    // redirects requests to its own origin (toolshed's API_INTERNAL_URL)
    // covers this one too.
    const resolver = new HttpProgramResolver(url, runtime.fetch);

    // Program resolution parses; load the deferred compiler stack first.
    const { resolveProgram, ts } = await ensureCompilerStack();

    // Resolve the program with all dependencies
    const program = await resolveProgram(resolver, {
      unresolvedModules: { type: "allow-all" },
      resolveUnresolvedModuleTypes: true,
      target: ts.ScriptTarget.ES2023,
    });

    // Check if aborted during resolution
    if (abortSignal.aborted) return;

    await runtime.idle();

    // Only write into an entry that is still marked `fetching`.
    await runtime.editWithRetry((tx) => {
      if (abortSignal.aborted) return;
      if (identity !== undefined) tx.tx.scopeKeyIdentity = identity;
      const allEntries = cache.withTx(tx).get();
      const entry = allEntries[inputHash];
      if (entry?.state.type === "fetching") {
        // Marked on the arm that writes (round-2 thread 12): a
        // suppressed writeback (the entry already resolved by a
        // competing resolution) must not commit as a spurious no-op
        // effect-completion for an already-completed key.
        markEffectCompletion(tx, effectKey);
        cache.withTx(tx).update({
          [inputHash]: {
            inputHash,
            state: {
              type: "success",
              data: { files: program.files, main: program.main },
            },
          },
        });
      }
    });
  } catch (err) {
    // Don't write errors if request was aborted
    if (abortSignal.aborted) return;

    await runtime.idle();

    // Only write into an entry that is still marked `fetching`.
    await runtime.editWithRetry((tx) => {
      if (abortSignal.aborted) return;
      if (identity !== undefined) tx.tx.scopeKeyIdentity = identity;
      const allEntries = cache.withTx(tx).get();
      const entry = allEntries[inputHash];
      if (entry?.state.type === "fetching") {
        // Marked on the arm that writes — see the success path above
        // (round-2 thread 12).
        markEffectCompletion(tx, effectKey);
        cache.withTx(tx).update({
          [inputHash]: {
            inputHash,
            state: {
              type: "error",
              message: err instanceof Error ? err.message : String(err),
            },
          },
        });
      }
    });
  }
}
