import type {
  FetchBinaryResult,
  JSONSchema,
  JSONSchemaObj,
} from "@commonfabric/api";
import { type FabricValue, valueEqual } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { internSchema } from "@commonfabric/data-model-schema";
import { mapSubschemas } from "@commonfabric/data-model-schema/schema-walk";
import {
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { getPatternEnvironment } from "../builder/env.ts";
import type { CellScope, Schema } from "../builder/types.ts";
import { type Cell } from "../cell.ts";
import { useCancelGroup } from "../cancel.ts";
import { createFrozenRequestSnapshot } from "../cfc/request-snapshot.ts";
import { validateAgainstSchema } from "../cfc/schema-sanitization.ts";
import { enqueueSinkRequestPostCommitEffect } from "../cfc/sink-request.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import type { Runtime } from "../runtime.ts";
import { type Action } from "../scheduler.ts";
import {
  requireWaveAcceptance,
  waveRunContextOf,
  waveSettlementOf,
} from "../executor/wave.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  ignoreReadForScheduling,
  writeDestinationRead,
} from "../storage/reactivity-log.ts";
import {
  isProtectedToolshedFirstPartyRoute,
  isToolshedApiOrigin,
  signFirstPartyHttpRequest,
} from "../toolshed-http-auth.ts";
import {
  computeInputHashFromValue,
  internalSchema,
  tryClaimMutex,
  tryWriteResult,
} from "./fetch-utils.ts";
import { ownedCell } from "./runtime-owned-store.ts";
import { settleAbandonedRequest } from "./abandoned-request.ts";
import {
  effectTargetKey,
  markEffectCompletion,
} from "../executor/effect-completion.ts";

/**
 * Metadata for a fetch builtin reading its own output cells to tell whether
 * anything was committed to them: a read of a write destination, and no
 * dependency of the request.
 */
const storedCellsRead = {
  ...writeDestinationRead,
  ...ignoreReadForScheduling,
};

/**
 * A fetch builtin's four output cells as stored, read through `readTx` as
 * write destinations: the reads are no dependency of the request.
 */
function storedFetchCells(
  readTx: IExtendedStorageTransaction,
  cells: {
    pending: Cell<unknown>;
    result: Cell<unknown>;
    error: Cell<unknown>;
    internal: Cell<unknown>;
  },
): Record<"pending" | "result" | "error" | "internal", FabricValue> {
  const read = { meta: storedCellsRead };
  return {
    pending: cells.pending.withTx(readTx).getRawUntyped(read),
    result: cells.result.withTx(readTx).getRawUntyped(read),
    error: cells.error.withTx(readTx).getRawUntyped(read),
    internal: cells.internal.withTx(readTx).getRawUntyped(read),
  };
}

type FetchRequestOptions = {
  body?: any;
  method?: string;
  headers?: Record<string, string>;
  cache?: RequestCache;
  redirect?: RequestRedirect;

  /**
   * How long (ms) a claimed request mutex stays valid before another tab may
   * take it over. Not part of the request itself: stripped before the request
   * snapshot is built so it never affects the fetch or the memoization hash.
   */
  mutexTimeoutMs?: number;
};

/** The shape of the fetch builtins' input cells (union across all kinds). */
type FetchInputs = {
  url?: string;

  /** fetchJson only. */
  schema?: JSONSchema;

  options?: FetchRequestOptions;
};

/** Publication and refusal ownership of one staged request. */
type FetchStaging = {
  /** Resolved physical output-binding instance, or the shared raw callback. */
  bindingKey: string;

  /** Symbolic result link, shared by actors selecting the same scoped target. */
  target: string;

  /** Invocation order within this builtin closure. */
  sequence: number;

  /** Input snapshot hash when this publication stages a request. */
  inputHash?: string;

  /** Whether the request's staging contribution was durably accepted. */
  accepted?: boolean;

  /** Whether the shared outbox work has completed or skipped dispatch. */
  finished?: boolean;
};

/**
 * Per-builtin descriptor. `name` keys the cause namespace for the builtin's
 * internal cells, the CFC sink name, and the post-commit effect id, so each
 * builtin has its own cell identities and sink identity. `buildRequest`
 * produces the request snapshot that is hashed for memoization and recorded
 * as the CFC sink request. `process` turns a successful response into the
 * result value (or throws).
 */
type FetchKind = {
  name:
    | "fetchBinary"
    | "fetchText"
    | "fetchJson"
    | "fetchJsonUnchecked";
  inputSchema: JSONSchema;
  buildRequest: (
    snapshot: FetchInputs,
    options: FetchRequestOptions | undefined,
  ) => FetchInputs;
  process: (response: Response, inputs: FetchInputs) => Promise<unknown>;
};

const fetchOptionsSchemaProperties = {
  body: {},
  method: { type: "string" },
  headers: {
    type: "object",
    additionalProperties: { type: "string" },
  },
  cache: { type: "string" },
  redirect: { type: "string" },
  mutexTimeoutMs: { type: "number" },
} as const;

const fetchBinaryInputSchema = internSchema(
  {
    type: "object",
    properties: {
      url: { type: "string" },
      options: { type: "object", properties: fetchOptionsSchemaProperties },
    },
  },
);

const fetchTextInputSchema = internSchema(
  {
    type: "object",
    properties: {
      url: { type: "string" },
      options: { type: "object", properties: fetchOptionsSchemaProperties },
    },
  },
);

const fetchJsonInputSchema = internSchema(
  {
    type: "object",
    properties: {
      url: { type: "string" },
      schema: {
        anyOf: [{ type: "object", additionalProperties: true }, {
          type: "boolean",
        }],
      },
      options: { type: "object", properties: fetchOptionsSchemaProperties },
    },
  },
);

const fetchJsonUncheckedInputSchema = internSchema(
  {
    type: "object",
    properties: {
      url: { type: "string" },
      options: { type: "object", properties: fetchOptionsSchemaProperties },
    },
  },
);

async function processTextResponse(response: Response): Promise<string> {
  return await response.text();
}

async function processJsonResponse(
  response: Response,
  schema?: JSONSchema,
): Promise<unknown> {
  const data = await response.json();
  if (schema !== undefined) {
    const failure = validateAgainstSchema(schemaWithOpenObjects(schema), data);
    if (failure !== undefined) {
      throw new Error(`fetchJson result failed schema validation: ${failure}`);
    }
  }
  return data;
}

async function processBinaryResponse(
  response: Response,
): Promise<FetchBinaryResult> {
  // The `true` below cedes the buffer to the `FabricBytes` rather than having
  // it copied. `arrayBuffer()` yields a buffer nobody else holds, so there is
  // nothing left to protect. A response body is unbounded, which is what makes
  // the copy worth avoiding.
  const bytes = new FabricBytes(await response.arrayBuffer(), true);
  const contentType = response.headers.get("content-type");
  const mediaType = contentType?.split(";")[0].trim().toLowerCase() ||
    "application/octet-stream";
  return { bytes, mediaType };
}

const asTypeArray = (type: unknown): string[] =>
  typeof type === "string" ? [type] : Array.isArray(type) ? type : [];

/**
 * Returns a copy of `schema` with `additionalProperties: true` on every
 * object-shaped subschema that doesn't declare it. validateAgainstSchema
 * treats such schemas as closed (a CFC-sanitization rule); fetch
 * verification follows standard JSON Schema semantics, where unknown object
 * properties are allowed unless the schema names `additionalProperties`.
 *
 * Exported for unit testing only — not part of the fetch builtin surface.
 */
export function schemaWithOpenObjects(schema: JSONSchema): JSONSchema {
  if (!isObjectOrArray(schema)) return schema;
  // Default-tier walk plus `$defs`. The never-emitted keywords (`contains`,
  // `if`/`then`/`else`, ...) are deliberately NOT rewritten — opening objects
  // under them would make those paths look supported; if one becomes emitted,
  // it moves to the used tier in schema-walk and this walk picks it up.
  const mapped = mapSubschemas(
    schema as JSONSchemaObj,
    (child) =>
      // Draft-07 array-form `items`; the 2020-12 tuple form is `prefixItems`,
      // which mapSubschemas already walks element-wise.
      Array.isArray(child)
        ? child.map(schemaWithOpenObjects) as unknown as JSONSchema
        : schemaWithOpenObjects(child),
    { includeDefs: true },
  );

  const declaresObjectShape = asTypeArray(mapped.type).includes("object") ||
    mapped.properties !== undefined ||
    mapped.required !== undefined;
  if (declaresObjectShape && mapped.additionalProperties === undefined) {
    return { ...mapped, additionalProperties: true } as JSONSchema;
  }
  return mapped;
}

const fetchBinaryKind: FetchKind = {
  name: "fetchBinary",
  inputSchema: fetchBinaryInputSchema,
  buildRequest: (snapshot, options) => ({ url: snapshot.url, options }),
  process: (response) => processBinaryResponse(response),
};

const fetchTextKind: FetchKind = {
  name: "fetchText",
  inputSchema: fetchTextInputSchema,
  buildRequest: (snapshot, options) => ({ url: snapshot.url, options }),
  process: (response) => processTextResponse(response),
};

const fetchJsonKind: FetchKind = {
  name: "fetchJson",
  inputSchema: fetchJsonInputSchema,
  buildRequest: (snapshot, options) => ({
    url: snapshot.url,
    schema: snapshot.schema,
    options,
  }),
  process: (response, inputs) => processJsonResponse(response, inputs.schema),
};

const fetchJsonUncheckedKind: FetchKind = {
  name: "fetchJsonUnchecked",
  inputSchema: fetchJsonUncheckedInputSchema,
  buildRequest: (snapshot, options) => ({ url: snapshot.url, options }),
  // No schema input ever, so the body is parsed but never verified.
  process: (response) => processJsonResponse(response),
};

function snapshotInputsFor(
  kind: FetchKind,
): (cell: Cell<FetchInputs>) => FetchInputs {
  return (cell) => {
    const snapshot = cell.asSchema(kind.inputSchema).get() ??
      ({} as FetchInputs);
    // mutexTimeoutMs tunes the mutex, not the request: drop it before
    // building the snapshot so it never reaches fetch() or the input hash.
    const { mutexTimeoutMs: _mutexTimeoutMs, ...rawOptions } =
      snapshot.options ?? {};
    const body = rawOptions.body;
    // TODO(danfuzz): the `body` schema is open (`{}`), and `JSON.stringify`
    // renders a `FabricSpecialObject` body — a `FabricBytes`, say, the very
    // type this file mints for binary responses — as `"{}"`, both on the
    // wire and in the request hash, so two distinct bodies collapse to one
    // request identity.
    const options = snapshot.options && Object.keys(rawOptions).length > 0
      ? {
        ...rawOptions,
        body: body !== undefined && typeof body !== "string"
          ? JSON.stringify(body)
          : body,
      }
      : undefined;
    return createFrozenRequestSnapshot(kind.buildRequest(snapshot, options));
  };
}

/**
 * Reads the mutex timeout (ms) from an input cell, if a positive finite value
 * is present. Returned separately from the request snapshot so it can tune the
 * cross-tab mutex without participating in request memoization.
 */
function mutexTimeoutForCell(
  kind: FetchKind,
  cell: Cell<FetchInputs>,
): number | undefined {
  const value = cell.asSchema(kind.inputSchema).get()?.options?.mutexTimeoutMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * Builds the builtin Action factory for one fetch kind. All four fetch
 * builtins share this machinery: result/pending/error/internal cells minted
 * under the builtin's cause namespace, input snapshot hashing for
 * memoization, a cross-tab mutex, abort handling, and a CFC sink request
 * enqueued per fetch.
 *
 * Returns the fetched result as `result`. `pending` is true while a request
 * is pending; failures (including fetchJson schema verification failures)
 * land on `error`.
 */
function fetchBuiltin(kind: FetchKind) {
  const snapshotInputs = snapshotInputsFor(kind);

  return function (
    inputsCell: Cell<FetchInputs>,
    sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
    addCancel: (cancel: () => void) => void,
    cause: Cell<any>[],
    parentCell: Cell<any>,
    runtime: Runtime, // Runtime will be injected by the registration function
    _outputBinding?: NormalizedFullLink,
    _awaitSync?: boolean,
    publicationBinding?: NormalizedFullLink,
  ): Action {
    const instances = new Map<string, ReturnType<typeof createInstance>>();
    let publicationSequence = 0;
    addCancel(() => {
      const [cancelAll, addInstanceCancel] = useCancelGroup();
      for (const instance of instances.values()) {
        addInstanceCancel(instance.cancel);
      }
      instances.clear();
      cancelAll();
    });

    /** Applies binding ownership only after publication is durable. */
    function observePublication(
      tx: IExtendedStorageTransaction,
      publication: FetchStaging,
      onAccepted?: () => void,
    ): void {
      requireWaveAcceptance(tx);
      const accept = () => {
        for (const other of instances.values()) {
          other.supersedePublication(publication);
        }
        onAccepted?.();
      };
      tx.addCommitCallback((committedTx, outcome) => {
        if (outcome.error) return;
        const settlement = waveSettlementOf(committedTx) ??
          waveSettlementOf(tx);
        if (settlement) {
          settlement.then((verdict) => {
            if (!verdict.error) accept();
          });
        } else accept();
      });
    }

    /** Owns the request lifecycle for one selected result instance. */
    function createInstance(instanceKey: string, served: boolean) {
      let cellsInitialized = false;
      let pending: Cell<boolean>;
      let result: Cell<any | undefined>;
      let error: Cell<any | undefined>;
      let internal: Cell<Schema<typeof internalSchema>>;
      let cellScope: CellScope | undefined;
      let myRequestId: string | undefined = undefined;

      // Distinct output bindings can select the same result instance. Each
      // binding retains its latest request until dispatch or refusal settles.
      const stagings = new Map<string, FetchStaging>();

      // Accepted outbox work survives a change in the published target, even
      // before dispatch creates an abort controller or active work promise.
      const acceptedRequests = new Set<string>();
      let latestSequence = 0;

      let abortController: AbortController | undefined = undefined;
      let activeWork = 0;
      let requestIdentity: ScopeKeyIdentity | undefined;

      /** Retains pending requests while releasing completed served instances. */
      function releaseIfIdle(
        settled?: FetchStaging,
        sharedCompletion = false,
      ): void {
        // Outbox deduplication can drop accepted equivalent callbacks. An
        // uncommitted different binding still needs its own refusal outcome.
        if (settled) {
          if (sharedCompletion) {
            settled.finished = true;
            acceptedRequests.delete(settled.inputHash!);
          }
          for (const [key, latest] of stagings) {
            if (sharedCompletion && latest.inputHash === settled.inputHash) {
              latest.finished = true;
            }
            if (
              latest === settled ||
              (sharedCompletion && latest.inputHash === settled.inputHash &&
                (key === settled.bindingKey || latest.accepted))
            ) stagings.delete(key);
          }
        }
        if (
          !served || activeWork > 0 || stagings.size > 0 ||
          acceptedRequests.size > 0
        ) return;
        if (instances.get(instanceKey) === instance) {
          instances.delete(instanceKey);
        }
      }

      /** Drops older requests whose binding selected a different target. */
      function supersedePublication(publication: FetchStaging): void {
        const previous = stagings.get(publication.bindingKey);
        if (
          previous && previous.sequence < publication.sequence &&
          previous.target !== publication.target
        ) {
          stagings.delete(publication.bindingKey);
          releaseIfIdle();
        }
      }

      /** Keeps the instance alive through its authoritative writeback. */
      function trackWork(
        work: Promise<void>,
        staging: FetchStaging,
        sharedCompletion = false,
      ): void {
        activeWork++;
        runtime.trackAsyncWork(
          work.finally(() => {
            activeWork--;
            releaseIfIdle(staging, sharedCompletion);
          }),
          parentCell,
        );
      }

      // This is called when the pattern containing this node is being stopped.
      function cancel(): void {
        // Abort the request if it's still pending.
        abortController?.abort("Pattern stopped");

        // Only try to update state if cells were initialized
        if (!cellsInitialized) return;

        const tx = runtime.edit();

        try {
          // Teardown tx on piece stop — no scheduler run stamps it;
          // bookkeeping per serving-loop.md §3d, RULED 2026-08-05, so a
          // serving runtime releases the claim instead of refusing the
          // unstamped seal. No-op off the serving posture. INSIDE the
          // try (r3756175831's shape, applied to the sibling site): a
          // throwing stamper routes through the abort below instead of
          // leaking the manually-opened tx.
          runtime.stampServerRun(tx, {
            actionId: `${kind.name}/teardown/${parentCell.sourceURI}`,
            kind: "bookkeeping",
            ...(requestIdentity !== undefined
              ? { scopeKeyIdentity: requestIdentity }
              : {}),
          });

          // If the pending request is ours, set pending to false and clear the
          // requestId. A claim another replica has taken over carries its id,
          // not ours, and releasing it would strand the request it is running.
          const currentRequestId = internal.withTx(tx).key("requestId").get();
          if (myRequestId !== undefined && currentRequestId === myRequestId) {
            pending.withTx(tx).set(false);
            internal.withTx(tx).key("requestId").set("");
          }

          // Since we're aborting, don't retry. If the above fails, it's because the
          // requestId was already changing under us.
          runtime.prepareTxForCommit(tx);
          tx.commit();
        } catch (_) {
          // Ignore errors during cleanup - the runtime might be shutting down
          tx.abort();
        }
      }

      function run(
        tx: IExtendedStorageTransaction,
        inputsSnapshot: FetchInputs,
        mutexTimeoutMs: number | undefined,
        outputScope: CellScope,
        identity?: ScopeKeyIdentity,
      ): void {
        // Raw callers without publication coordinates share one callback;
        // declared container scope is not a physical binding address.
        const bindingKey =
          identity === undefined || publicationBinding === undefined
            ? "local"
            : resolveScopeKey(publicationBinding.scope ?? "space", identity);
        stagings.delete(bindingKey);
        latestSequence = ++publicationSequence;

        if (!cellsInitialized || cellScope !== outputScope) {
          pending = ownedCell<boolean>(
            runtime,
            tx,
            parentCell,
            { [kind.name]: { pending: cause } },
            undefined,
            outputScope,
          );

          result = ownedCell<any | undefined>(
            runtime,
            tx,
            parentCell,
            {
              [kind.name]: { result: cause },
            },
            undefined,
            outputScope,
          );

          error = ownedCell<any | undefined>(
            runtime,
            tx,
            parentCell,
            {
              [kind.name]: { error: cause },
            },
            undefined,
            outputScope,
          );

          internal = ownedCell(
            runtime,
            tx,
            parentCell,
            { [kind.name]: { internal: cause } },
            internalSchema,
            outputScope,
          );

          // Link the new result cells to the parent result cell
          setResultCell(pending, parentCell);
          setResultCell(result, parentCell);
          setResultCell(error, parentCell);
          setResultCell(internal, parentCell);
          // Link the new result cells to the pattern cell too
          const patternCellPtr = parentCell.key("pattern");
          setPatternCell(pending, patternCellPtr);
          setPatternCell(result, patternCellPtr);
          setPatternCell(error, patternCellPtr);
          setPatternCell(internal, patternCellPtr);

          // Kick off sync in the background
          pending.sync();
          result.sync();
          error.sync();
          internal.sync();

          cellsInitialized = true;
          cellScope = outputScope;
        }

        // Set results to links to our cells. We have to do this outside of
        // isInitialized since the write could conflict, and then this code will run
        // again, but isInitialized will be true already. The framework will notice
        // that this write is a no-op after the first successful write, so this
        // should be fine.
        sendResult(tx, { pending, result, error });
        const staging: FetchStaging = {
          bindingKey,
          target: effectTargetKey("publication", result),
          sequence: latestSequence,
        };
        if (identity !== undefined) {
          // Memo and empty results also select the binding's symbolic link.
          // Only accepted publication can supersede another target's refusal.
          observePublication(tx, staging, () => {
            staging.accepted = true;
            if (staging.inputHash !== undefined) {
              if (staging.finished) {
                releaseIfIdle(staging, true);
                return;
              }
              acceptedRequests.add(staging.inputHash);
            }
            // A shared request can finish before this equivalent contribution
            // is accepted. Its stored memo retires the accepted token without
            // depending on a deduplicated callback running again.
            if (staging.inputHash !== undefined && activeWork === 0) {
              const read = runtime.readTx();
              read.tx.scopeKeyIdentity = identity;
              if (
                internal.withTx(read).key("inputHash").get() ===
                  staging.inputHash &&
                pending.withTx(read).get() !== true &&
                (result.withTx(read).get() !== undefined ||
                  error.withTx(read).get() !== undefined)
              ) releaseIfIdle(staging, true);
            }
          });
        }

        const url = inputsSnapshot?.url;
        if (!url) {
          // Only update if values actually need to change to reduce transaction conflicts
          const currentPending = pending.withTx(tx).get();
          const currentResult = result.withTx(tx).get();
          const currentError = error.withTx(tx).get();
          const currentInternal = internal.withTx(tx).get();

          if (currentPending !== false) pending.withTx(tx).set(false);
          if (currentResult !== undefined) result.withTx(tx).set(undefined);
          if (currentError !== undefined) error.withTx(tx).set(undefined);
          // Clear internal state when URL is empty so we don't think we have cached results
          if (currentInternal.inputHash !== "") {
            internal.withTx(tx).set({
              requestId: "",
              lastActivity: 0,
              inputHash: "",
            });
          }
          return;
        }

        const inputHash = computeInputHashFromValue(inputsSnapshot);
        // Check if we're already working on or have the result for these inputs
        const currentInternal = internal.withTx(tx).get();
        const currentPending = pending.withTx(tx).get();
        const currentResult = result.withTx(tx).get();
        const currentError = error.withTx(tx).get();
        // Taken before this run writes to them, for an abandoned request's
        // ending to compare with (see `cellsBeforeStage`).
        const storedBeforeWrites = storedFetchCells(tx, {
          pending,
          result,
          error,
          internal,
        });

        const inputsMatch = currentInternal?.inputHash === inputHash;

        // If inputs changed, clear everything and abort any in-flight request
        if (!inputsMatch) {
          if (myRequestId) {
            abortController?.abort("Inputs changed");
            myRequestId = undefined;
          }

          pending.withTx(tx).set(false);
          result.withTx(tx).set(undefined);
          error.withTx(tx).set(undefined);
          internal.withTx(tx).update({
            inputHash,
            requestId: "",
            lastActivity: 0,
          });
        }

        // If we have a result OR error for these inputs, we're done
        const hasValidResult = inputsMatch && currentResult !== undefined;
        const hasError = inputsMatch && currentError !== undefined;
        if (hasValidResult || hasError) {
          // The §4 memo hit (server-execution v2): the stored request hash
          // matches, so the committed result (or error-shaped result) IS
          // the node's value — no effect fires, which is what makes
          // restart-recovery safe (serving-loop.md §4, §6 step 3).
          runtime.effectMemoObserver?.({
            kind: "hit",
            id: `${kind.name}:${inputHash}`,
          });
        }

        // If we're already fetching these inputs, wait
        const alreadyFetching = inputsMatch && currentPending &&
          myRequestId !== undefined;

        // Start a new fetch if we don't have a result/error and aren't already fetching
        if (!hasValidResult && !hasError && !alreadyFetching) {
          // The claim id names this replica, so teardown can tell a claim it
          // still holds from one another replica has taken over. `runtime.id` is
          // unique per storage manager and so per replica. The outbox/dedupe
          // key is the input hash WIDENED BY THIS NODE's result-cell identity
          // (effectTargetKey): dedupe collapses re-issues of the SAME node's
          // request from anywhere, while a DISTINCT node with identical
          // inputs keeps its own effect — its closure writes its own cells,
          // which a shared key would have dropped (round-2 headline).
          const newRequestId = `${runtime.id}:${inputHash}`;
          staging.inputHash = inputHash;
          stagings.set(bindingKey, staging);
          // These cells as this request found them. Whether anything has been
          // committed to them since is one question about all four together, not
          // four questions: a request that answers writes its result without
          // moving the claim id, and one that takes over moves the claim id
          // without writing a result.
          //
          // Asked of the values as stored, which are compared whole, rather than
          // of the views a read hands back, which would each be read through
          // again.
          const cellsBeforeStage = storedBeforeWrites;
          const effectKey = effectTargetKey(
            `${kind.name}:${inputHash}`,
            result,
            identity,
          );
          enqueueSinkRequestPostCommitEffect(
            tx,
            kind.name,
            `${kind.name}:${inputHash}`,
            inputsSnapshot,
            `${kind.name}-start`,
            () => {
              // Try to claim mutex - returns immediately if another tab is
              // processing. Tracked as async builtin work owned by this run, so
              // runtime.settled() and runtime.settledFor(parentCell) both wait
              // for the fetch and its writeback; idle() does not, so the
              // post-commit handler never blocks on network I/O.
              const work = tryClaimMutex(
                runtime,
                inputsCell,
                pending,
                result,
                error,
                internal,
                newRequestId,
                // Materialize inputs via the schema system and preprocess body.
                // asSchema().get() returns a frozen plain snapshot with nested
                // properties (like options.headers) fully resolved, safe to use
                // after commit.
                snapshotInputs,
                inputHash,
                mutexTimeoutMs,
                effectKey,
                identity,
              ).then(
                async ({ claimed }) => {
                  if (!claimed) {
                    // Another tab is handling this, we're done
                    return;
                  }

                  // Clear any previous result/error when starting a new fetch
                  // This ensures observers see a clean pending state
                  runtime.editWithRetry((tx) => {
                    if (identity !== undefined) {
                      tx.tx.scopeKeyIdentity = identity;
                    }
                    markEffectCompletion(tx, effectKey);
                    result.withTx(tx).set(undefined);
                    error.withTx(tx).set(undefined);
                  });

                  // Check if URL became empty while waiting for mutex
                  if (!inputsSnapshot.url) {
                    // Release the lock and clear state
                    myRequestId = undefined;
                    runtime.editWithRetry((tx) => {
                      if (identity !== undefined) {
                        tx.tx.scopeKeyIdentity = identity;
                      }
                      markEffectCompletion(tx, effectKey);
                      pending.withTx(tx).set(false);
                      result.withTx(tx).set(undefined);
                      error.withTx(tx).set(undefined);
                      internal.withTx(tx).set({
                        requestId: "",
                        lastActivity: 0,
                        inputHash: "",
                      });
                    });
                    return;
                  }

                  abortController = new AbortController();

                  // We claimed the mutex, start the fetch. `startFetch` compares
                  // against the input hash, not the claim id: any request for
                  // these inputs may write the result.
                  myRequestId = newRequestId;
                  requestIdentity = identity;
                  await startFetch(
                    runtime,
                    kind,
                    snapshotInputs,
                    inputsCell,
                    inputsSnapshot,
                    inputHash,
                    pending,
                    result,
                    error,
                    internal,
                    abortController.signal,
                    effectKey,
                    identity,
                  );
                },
              );
              trackWork(work, staging, true);
            },
            {
              idempotencyKey: effectKey,
              onReleaseRejected: () => releaseIfIdle(staging, true),
              onRejected: (rejection) => {
                if (
                  identity !== undefined &&
                  (instances.get(instanceKey) !== instance ||
                    stagings.get(bindingKey) !== staging)
                ) return;
                trackWork(
                  settleAbandonedRequest(
                    runtime,
                    kind.name,
                    effectKey,
                    (settleTx) => {
                      if (identity !== undefined) {
                        settleTx.tx.scopeKeyIdentity = identity;
                      }
                      const ownsBinding = identity === undefined ||
                        (instances.get(instanceKey) === instance &&
                          stagings.get(bindingKey) === staging);
                      if (!ownsBinding) return;
                      // A binding may need this announcement even when another
                      // binding's request owns the shared result fields.
                      sendResult(settleTx, { pending, result, error });
                      if (identity !== undefined) {
                        observePublication(settleTx, staging);
                      }
                      // Decided here rather than when this callback ran.
                      // Another request holds these cells in either of two ways,
                      // and the ending steps around both. One is in flight: the
                      // pending flag is up under a claim id that is not this
                      // request's. Or one has claimed here since this request was
                      // staged, whatever state it left — a later request that
                      // already answered leaves its own claim id with the flag
                      // down, and that answer is its own to keep.
                      //
                      // What was left over from before this request was staged is
                      // neither. A request that finished leaves its claim id
                      // standing with the flag down, so every request after the
                      // first one finds an id here that belongs to nobody, and
                      // reading that as a takeover would leave the pattern
                      // holding the finished request's answer under inputs it no
                      // longer describes.
                      // This node has moved on if its latest run staged
                      // something else, or staged nothing at all. The store can
                      // say nothing about that: a run whose inputs return to ones
                      // already answered keeps that answer and writes nothing, so
                      // the two durable tests below both see exactly what this
                      // request left behind.
                      if (latestSequence !== staging.sequence) return;
                      const cellsNow = {
                        pending: pending.withTx(settleTx).get(),
                        result: result.withTx(settleTx).get(),
                        error: error.withTx(settleTx).get(),
                        internal: internal.withTx(settleTx).get(),
                      };
                      const claim = cellsNow.internal?.requestId;
                      const inFlight = cellsNow.pending === true &&
                        claim !== undefined && claim !== "" &&
                        claim !== newRequestId;
                      // `valueEqual` rather than a structural walk: a fetched
                      // body is a `FabricValue`, and `fetchBinary` answers with
                      // `FabricBytes`, whose contents live in private fields that
                      // a structural walk cannot see — every distinct instance of
                      // one compares equal to every other.
                      const writtenSinceStaged = !valueEqual(
                        cellsBeforeStage,
                        storedFetchCells(settleTx, {
                          pending,
                          result,
                          error,
                          internal,
                        }),
                      );
                      if (inFlight || writtenSinceStaged) {
                        return;
                      }
                      pending.withTx(settleTx).set(false);
                      result.withTx(settleTx).set(undefined);
                      error.withTx(settleTx).set(rejection.message);
                    },
                  ),
                  staging,
                );
              },
            },
          );
        }
      }
      const instance = {
        run,
        cancel,
        releaseIfIdle,
        supersedePublication,
      };
      return instance;
    }

    return (tx: IExtendedStorageTransaction) => {
      tx.resetNarrowestReadScope();
      const inputsSnapshot = snapshotInputs(inputsCell.withTx(tx));
      const mutexTimeoutMs = mutexTimeoutForCell(kind, inputsCell.withTx(tx));
      const outputScope = tx.getNarrowestReadScope();
      const identity = waveRunContextOf(tx)?.scopeKeyIdentity;
      const instanceKey = identity === undefined
        ? "local"
        : resolveScopeKey(outputScope, identity);
      let instance = instances.get(instanceKey);
      if (instance === undefined) {
        instance = createInstance(instanceKey, identity !== undefined);
        instances.set(instanceKey, instance);
      }
      instance.run(tx, inputsSnapshot, mutexTimeoutMs, outputScope, identity);
      instance.releaseIfIdle();
    };
  };
}

function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

async function signedToolshedFetchOptions(
  runtime: Runtime,
  url: URL,
  apiBase: URL,
  options: FetchRequestOptions | undefined,
): Promise<FetchRequestOptions | undefined> {
  const method = options?.method ?? "GET";
  if (
    !isToolshedApiOrigin(url, apiBase) ||
    !isProtectedToolshedFirstPartyRoute(url, method)
  ) {
    return options;
  }

  const headers = await signFirstPartyHttpRequest({
    url,
    method,
    headers: options?.headers,
    body: options?.body as BodyInit | null | undefined,
    signer: runtime.storageManager.as,
  });

  return {
    ...options,
    method,
    headers: headersToRecord(headers),
  };
}

async function startFetch(
  runtime: Runtime,
  kind: FetchKind,
  snapshotInputs: (cell: Cell<FetchInputs>) => FetchInputs,
  inputsCell: Cell<FetchInputs>,
  inputsSnapshot: FetchInputs,
  inputHash: string,
  pending: Cell<boolean>,
  result: Cell<any | undefined>,
  error: Cell<any | undefined>,
  internal: Cell<Schema<typeof internalSchema>>,
  abortSignal: AbortSignal,
  effectKey: string,
  identity?: ScopeKeyIdentity,
) {
  const { url, options } = inputsSnapshot;

  // Body preprocessing (stringify non-string bodies) is handled by the
  // snapshotInputs callback in tryClaimMutex, so options is ready to use.
  try {
    // Relative URLs resolve against the executing space's host when the
    // space is host-mapped (federation: one runtime spans hosts). An
    // unmapped space keeps the pattern environment's api base — which on
    // some deployments (toolshed) deliberately differs from the runtime's
    // default memory host, so hostForSpace's fallback is NOT used here.
    const mappedHost = runtime.mappedHostFor(inputsCell.space);
    const apiBase = new URL(mappedHost ?? getPatternEnvironment().apiUrl);
    const resolvedUrl = new URL(url!, apiBase);
    const requestOptions = await signedToolshedFetchOptions(
      runtime,
      resolvedUrl,
      apiBase,
      options,
    );
    const response = await runtime.fetch(
      resolvedUrl,
      {
        signal: abortSignal,
        ...requestOptions,
      },
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await kind.process(response, inputsSnapshot);
    await runtime.idle();

    // Try to write result - any tab can write if inputs match
    const written = await tryWriteResult(
      runtime,
      internal,
      inputsCell,
      inputHash,
      (tx) => {
        pending.withTx(tx).set(false);
        result.withTx(tx).set(data);
        error.withTx(tx).set(undefined);
      },
      snapshotInputs,
      effectKey,
      identity,
    );
    // A writeback SUPERSEDED by changed inputs is done (the new inputs'
    // own request owns the cells now). A writeback whose COMMIT failed
    // is not: the claim (pending=true) is durable and this response is
    // the only completion it will ever get — swallowing the failure
    // retires the effect as "completed" while the claim wedges forever
    // under serving (nothing re-runs the action without input change).
    // Throw instead: the catch below converts it into an error-shaped
    // result (retryable, input-driven — §4's failure posture), and if
    // even that cannot commit, the rethrow makes the tracked work
    // reject so the outbox counts outbox.failed and logs it loudly.
    if (written.commitError !== undefined) {
      throw new Error(
        `${kind.name} completion write failed: ${written.commitError.message}`,
      );
    }
  } catch (err) {
    // Don't write errors if request was aborted
    if (abortSignal.aborted) return;

    await runtime.idle();

    // Write error - but only update inputHash if inputs haven't changed
    const errorWritten = await runtime.editWithRetry((tx) => {
      if (identity !== undefined) tx.tx.scopeKeyIdentity = identity;
      markEffectCompletion(tx, effectKey);
      const currentHash = computeInputHashFromValue(
        snapshotInputs(inputsCell.withTx(tx)),
      );

      pending.withTx(tx).set(false);

      // Taking over a claim that has gone stale can leave two requests for the
      // same inputs in flight at once. A result already recorded for those
      // inputs came from the other one, and this failure says nothing about
      // it, so leave it standing rather than replacing it with this error.
      if (
        currentHash === inputHash && result.withTx(tx).get() !== undefined
      ) {
        return;
      }

      result.withTx(tx).set(undefined);

      // Only write error and inputHash if inputs still match
      if (currentHash === inputHash) {
        error.withTx(tx).set(err);
        internal.withTx(tx).update({ inputHash });
      }
    });
    if (errorWritten.error !== undefined) {
      // Neither the result nor an error-shaped result could commit: the
      // claim stays wedged durably. Propagate so the effect's tracked
      // work REJECTS — outbox.failed counts it and the failure is loud
      // (recovery is §6's re-miss on the next activation, or an input
      // change; a silent return here would count "completed").
      throw new Error(
        `${kind.name} error writeback failed to commit: ` +
          `${errorWritten.error.message}`,
        { cause: err },
      );
    }
  }
}

/**
 * Fetch binary data from a URL.
 *
 * Returns the response body as `result`, shaped `{ bytes, mediaType }` where
 * `bytes` is a FabricBytes byte buffer. `pending` is true while a request is
 * pending; failures land on `error`.
 */
export const fetchBinary = fetchBuiltin(fetchBinaryKind);

/**
 * Fetch text from a URL.
 *
 * Returns the response body decoded as UTF-8 text as `result`. `pending` is
 * true while a request is pending; failures land on `error`.
 */
export const fetchText = fetchBuiltin(fetchTextKind);

/**
 * Fetch JSON from a URL.
 *
 * Returns the parsed response body as `result`. When a `schema` input is
 * present, the parsed body is verified against it at fetch time; a
 * verification failure lands on `error` and `result` stays undefined.
 * Verification follows standard JSON Schema semantics for object
 * properties not named in the schema (allowed unless the schema declares
 * `additionalProperties`). `pending` is true while a request is pending.
 */
export const fetchJson = fetchBuiltin(fetchJsonKind);

/**
 * Fetch JSON from a URL without any schema verification.
 *
 * Like fetchJson but the parsed body is returned as-is, never verified.
 * This is the escape hatch for responses whose shape isn't declared as a
 * type; fetchJson requires an explicit type argument.
 */
export const fetchJsonUnchecked = fetchBuiltin(fetchJsonUncheckedKind);
