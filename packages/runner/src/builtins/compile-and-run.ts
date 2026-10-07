import {
  UNAVAILABLE_PENDING,
  unavailableError,
  type UnavailableVariant,
} from "@commonfabric/data-model/availability";

import type { JSONSchema } from "@commonfabric/api";
import { hashOf } from "@commonfabric/data-model";

import { CompilerError } from "@commonfabric/js-compiler/errors";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import type {
  BuiltInCompileAndRunParams,
  CompileDiagnostic,
} from "commonfabric";

import type { CellScope } from "../builder/types.ts";
import { type Cell } from "../cell.ts";
import { enqueueSinkRequestPostCommitEffect } from "../cfc/sink-request.ts";
import {
  effectTargetKey,
  markEffectCompletion,
} from "../executor/effect-completion.ts";
import { waveSettlementOf } from "../executor/wave.ts";
import type { RuntimeProgram } from "../harness/types.ts";
import { snapshotQueryResult } from "../query-result-proxy.ts";
import type { Runtime } from "../runtime.ts";
import { type Action } from "../scheduler.ts";
import { narrowestScope } from "../scope.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../storage/interface.ts";
import { settleAbandonedRequest } from "./abandoned-request.ts";
import { ownedCell } from "./runtime-owned-store.ts";
import { resolvedCellScope } from "./scope-policy.ts";
import { selectUnavailableInput } from "../data-unavailability.ts";

/** Converts a compiler failure message into a terminal compilation marker. */
function compileUnavailable(
  message: string,
): UnavailableVariant {
  return unavailableError(message, "compile");
}

function markerIsPending(marker: UnavailableVariant): boolean {
  return marker.reason === "pending" || marker.reason === "syncing";
}

function markerErrorMessage(
  marker: UnavailableVariant,
): string | undefined {
  return marker.rawErrorMessage ?? undefined;
}

function compileRequestHash(
  program: RuntimeProgram | undefined,
  unavailable: UnavailableVariant | undefined,
): string {
  return unavailable === undefined
    ? hashOf(program ?? { files: [], main: "" }).toString()
    : hashOf({ unavailable }).toString();
}

/** Durable state of a compile request, including its instantiation outcome. */
type CompileMemo = {
  /** Request whose progress the output cells describe. */
  requestHash: string;

  /** Whether the request awaits compilation, child setup, or neither. */
  phase: "pending" | "compiled" | "resolved";
};

const programSchema: JSONSchema = {
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
      default: [],
    },
    main: { type: "string", default: "" },
    // Named here or dropped: the traverser omits every key the properties
    // map leaves out, so a field missing from this schema never reaches
    // the compile however well the parameter type declares it.
    dataFiles: { type: "array", items: { type: "string" } },
  },
  required: ["files", "main"],
};

/**
 * Compile a pattern/module and run it.
 *
 * @param files - Map of `{ filename: string }` to source code.
 * @param main - The name of the main pattern to run.
 * @param input - Inputs passed to the pattern once compiled.
 *
 * @returns { result?: any, error?: string, errors?: Array<{line: number, column: number, message: string, type: string, file?: string}>, pending: boolean }
 *   - `result` is the result of the pattern, or undefined.
 *   - `error` error string that occurred during compilation or execution, or
 *     undefined.
 *   - `errors` structured error array with line/column/file information for
 *     compilation errors.
 *   - `pending` is true if the pattern is still being compiled.
 *
 * Note that if an error occurs during execution, both `result` and `error` can
 * be defined. (Note: Runtime errors are not currently handled).
 */
export function compileAndRun(
  inputsCell: Cell<BuiltInCompileAndRunParams<any>>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  let requestId: string | undefined = undefined;
  let abortController: AbortController | undefined = undefined;
  let previousCallHash: string | undefined = undefined;
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<unknown>;
  let error: Cell<string | undefined>;
  let errors: Cell<CompileDiagnostic[] | undefined>;
  let cellScope: CellScope | undefined;
  let internal: Cell<CompileMemo | undefined>;
  let reportedCreatedHash: string | undefined;
  const served = runtime.experimental.serverExecution === true;
  const issuedRequests = new Map<string, string>();
  const retainedChildScopes = new Set<CellScope>();

  // This is called when the pattern containing this node is being stopped.
  addCancel(() => {
    // Abort any in-flight compilation if it's still pending.
    abortController?.abort("Pattern stopped");
  });

  return (tx: IExtendedStorageTransaction) => {
    tx.resetNarrowestReadScope();
    const rawInputs = inputsCell.withTx(tx).getRaw();
    const unavailableInput = selectUnavailableInput(rawInputs, {
      runtime,
      tx,
      base: inputsCell,
    });

    // TODO(seefeld): Ideally, this cell already has this schema, because we set
    // it on the node itself.
    // Detached from the input view once, here: the program is hashed, handed
    // to the compiler, and queued as an outbox request, and each of those would
    // otherwise read the whole program through the view again.
    const program = snapshotQueryResult(
      inputsCell.asSchema<RuntimeProgram>(programSchema).withTx(tx).get(),
    );
    const input = inputsCell.withTx(tx).key("input");
    const outputScope = narrowestScope([
      tx.getNarrowestReadScope(),
      resolvedCellScope(runtime, tx, input),
    ]);

    if (!cellsInitialized || cellScope !== outputScope) {
      if (cellsInitialized && cellScope !== outputScope) {
        previousCallHash = undefined;
        reportedCreatedHash = undefined;
      }
      pending = ownedCell<boolean>(
        runtime,
        tx,
        parentCell,
        { compile: { pending: cause } },
        undefined,
        outputScope,
      );
      pending.send(false);

      result = ownedCell<unknown>(
        runtime,
        tx,
        parentCell,
        { compile: { result: cause } },
        undefined,
        outputScope,
      );
      if (served && runtime.servingPosture) {
        // The fixed node cause gives each scope one child registration,
        // shared by every actor selecting a program in that scope.
        const scope = result.getAsNormalizedFullLink().scope ?? "space";
        if (!retainedChildScopes.has(scope)) {
          retainedChildScopes.add(scope);
          addCancel(runtime.runner.retainChild(result));
        }
      }

      error = ownedCell<string | undefined>(
        runtime,
        tx,
        parentCell,
        { compile: { error: cause } },
        undefined,
        outputScope,
      );

      errors = ownedCell<CompileDiagnostic[] | undefined>(
        runtime,
        tx,
        parentCell,
        { compile: { errors: cause } },
        undefined,
        outputScope,
      );

      if (served) {
        internal = ownedCell<CompileMemo | undefined>(
          runtime,
          tx,
          parentCell,
          { compile: { internal: cause } },
          undefined,
          outputScope,
        );
        internal.sync();
      }
      if (!served) sendResult(tx, { pending, result, error, errors });
      cellsInitialized = true;
      cellScope = outputScope;
    }

    if (served) {
      // Each acting instance owns its output binding, even when the node
      // shares initialized cells with another instance of the same scope.
      sendResult(tx, { pending, result, error, errors });

      const announce = (settleTx: IExtendedStorageTransaction) =>
        sendResult(settleTx, { pending, result, error, errors });

      const reportCreated = (hash: string) => {
        if (reportedCreatedHash === hash) return;
        reportedCreatedHash = hash;
        runtime.pieceCreatedCallback?.(result);
      };

      return compileAndRunServed(
        runtime,
        tx,
        inputsCell,
        parentCell,
        {
          pending,
          result,
          error,
          errors,
          internal,
        },
        program,
        unavailableInput,
        issuedRequests,
        announce,
        reportCreated,
      );
    }

    const pendingWithLog = pending.withTx(tx);
    const resultWithLog = result.withTx(tx);
    const errorWithLog = error.withTx(tx);
    const errorsWithLog = errors.withTx(tx);

    // Concrete input values do not require recompilation, but availability
    // transitions do. Include the controlling marker so an unavailable input
    // can settle back into the same source program.
    const hash = hashOf({
      program: program ?? null,
      unavailable: unavailableInput ?? null,
    }).toString();

    // Return if the same request is being made again, either concurrently (same
    // as previousCallHash) or when rehydrated from storage (same as the
    // contents of the requestHash doc).
    if (hash === previousCallHash) return;

    previousCallHash = hash;

    // Abort any in-flight compilation before starting a new one
    abortController?.abort("New compilation started");
    abortController = undefined;
    requestId = crypto.randomUUID();

    runtime.runner.stop(result);
    errorWithLog.set(undefined);
    errorsWithLog.set(undefined);

    if (unavailableInput !== undefined) {
      resultWithLog.setRawUntyped(unavailableInput, true);
      pendingWithLog.set(markerIsPending(unavailableInput));
      errorWithLog.set(markerErrorMessage(unavailableInput));
      return;
    }

    const hasValidInputs = program?.main && program.files &&
      program.files.length > 0;
    if (!hasValidInputs || program === undefined) {
      resultWithLog.setRawUntyped(
        unavailableError(
          "Compilation requires a main entrypoint and files",
          "invalidInput",
        ),
        true,
      );
      pendingWithLog.set(false);
      return;
    }

    // Main file not found => Error, not pending
    if (!program.files.some((file) => file?.name === program.main)) {
      const message = `"${program.main}" not found in files`;
      resultWithLog.setRawUntyped(compileUnavailable(message), true);
      errorWithLog.set(message);
      pendingWithLog.set(false);
      return;
    }

    // Now we're sure that we have a new file to compile
    resultWithLog.setRawUntyped(UNAVAILABLE_PENDING, true);
    pendingWithLog.set(true);
    abortController = new AbortController();

    // Capture requestId for this compilation run
    const thisRequestId = requestId;

    const compilePromise = runtime.patternManager
      .compileOrGetPattern(program, parentCell.space)
      .catch(
        async (err) => {
          // Only process this error if the request hasn't been superseded
          if (requestId !== thisRequestId) return;
          if (abortController?.signal.aborted) return;

          await runtime.editWithRetry((asyncTx) => {
            if (requestId !== thisRequestId) return;
            if (abortController?.signal.aborted) return;

            // Extract structured errors if this is a CompilerError
            if (err instanceof CompilerError) {
              const structuredErrors: CompileDiagnostic[] = err.errors.map(
                (e) => ({
                  line: e.line ?? 1,
                  column: e.column ?? 1,
                  message: e.message,
                  type: e.type,
                  file: e.file,
                }),
              );
              errors.withTx(asyncTx).set(structuredErrors);
              result.withTx(asyncTx).setRawUntyped(
                compileUnavailable(err.message),
                true,
              );
            } else {
              const message = err instanceof Error
                ? err.message + (err.stack ? "\n" + err.stack : "")
                : String(err);
              error.withTx(asyncTx).set(message);
              result.withTx(asyncTx).setRawUntyped(
                compileUnavailable(message),
                true,
              );
            }
          });
        },
      ).finally(async () => {
        // Only update pending if this is still the current request
        if (requestId !== thisRequestId) return;
        // Always clear pending state, even if cancelled, to avoid stuck state

        await runtime.editWithRetry((asyncTx) => {
          if (requestId !== thisRequestId) return;
          pending.withTx(asyncTx).set(false);
        });
      });

    const work = compilePromise.then((pattern) => {
      // Only run the result if this is still the current request
      if (requestId !== thisRequestId) return;
      if (abortController?.signal.aborted) return;

      if (pattern) {
        // TODO(ja): to support editting of existing pieces / running with
        // inputs from other pieces, we will need to think more about
        // how we pass input into the builtin.

        // The instantiation is the builtin's, in a continuation of its
        // action: no principal's act attributes what its setup initializes.
        runtime.runSynced(result, pattern, input.get(), {
          attributeInitialization: false,
        });
        runtime.editWithRetry((asyncTx) => {
          result.withTx(asyncTx).key("isHidden").set(true);
        });
        runtime.pieceCreatedCallback?.(result);
      }
      // TODO(seefeld): Add capturing runtime errors.
    });
    runtime.trackAsyncWork(work, parentCell);
  };
}

/** Direct-result module ref used by newly compiled graphs. */
export function compileAndRunResult(
  inputsCell: Cell<BuiltInCompileAndRunParams<any>>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  return compileAndRun(
    inputsCell,
    (tx, state) => sendResult(tx, state.result),
    addCancel,
    cause,
    parentCell,
    runtime,
  );
}

/** Output and memo cells addressed at the requesting node's scope. */
type ServedCompileCells = {
  /** Compilation and child-setup progress. */
  pending: Cell<boolean>;

  /** Child piece's deterministic result cell. */
  result: Cell<any>;

  /** Unstructured compiler error. */
  error: Cell<string | undefined>;

  /** Structured compiler diagnostics. */
  errors: Cell<unknown>;

  /** Durable request and resolution markers. */
  internal: Cell<CompileMemo | undefined>;
};

/**
 * Serves a compile request through the outbox and instantiates its cached
 * pattern in a derivation. Clients observe the committed result and report
 * successful child creation through their local hook.
 */
function compileAndRunServed(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  inputs: Cell<BuiltInCompileAndRunParams<any>>,
  parent: Cell<any>,
  cells: ServedCompileCells,
  program: RuntimeProgram | undefined,
  unavailableInput: UnavailableVariant | undefined,
  issuedRequests: Map<string, string>,
  announce: (tx: IExtendedStorageTransaction) => void,
  reportCreated: (hash: string) => void,
): void | Promise<never> {
  const { pending, result, error, errors, internal } = cells;
  const memo = internal.withTx(tx).get();
  const hash = compileRequestHash(program, unavailableInput);
  const valid = !!(program?.main && program.files?.length);
  if (memo?.requestHash === hash && memo.phase === "resolved") {
    runtime.effectMemoObserver?.({ kind: "hit", id: `compileAndRun:${hash}` });
    const child = result.withTx(tx).get();
    const succeeded = valid && error.withTx(tx).get() === undefined &&
      errors.withTx(tx).get() === undefined;
    // The child body materializes its result after setup. Reading it here
    // rearms this derivation when that value arrives.
    if (runtime.servingPosture && succeeded && child !== undefined) {
      result.withTx(tx).key("isHidden").set(true);
    }
    if (
      !runtime.servingPosture && succeeded && child?.isHidden === true
    ) {
      reportCreated(hash);
    }
    return;
  }
  if (!runtime.servingPosture) return;

  const newRequest = memo?.requestHash !== hash;
  if (unavailableInput !== undefined) {
    runtime.runner.clearInTransaction(tx, result);
    result.withTx(tx).setRawUntyped(unavailableInput, true);
    error.withTx(tx).set(markerErrorMessage(unavailableInput));
    errors.withTx(tx).set(undefined);
    pending.withTx(tx).set(markerIsPending(unavailableInput));
    internal.withTx(tx).set({ requestHash: hash, phase: "resolved" });
    return;
  }

  if (!valid) {
    const intentionallyEmpty = program?.main === "" &&
      program.files?.length === 0;
    if (memo?.requestHash !== undefined && newRequest && !intentionallyEmpty) {
      return;
    }
  }

  const missingMain = valid && program !== undefined &&
    !program.files.some((file) => file?.name === program.main);
  if (!valid || program === undefined || missingMain) {
    runtime.runner.clearInTransaction(tx, result);
    const message = missingMain
      ? `"${program.main}" not found in files`
      : undefined;
    result.withTx(tx).setRawUntyped(
      message === undefined
        ? unavailableError(
          "Compilation requires a main entrypoint and files",
          "invalidInput",
        )
        : compileUnavailable(message),
      true,
    );
    error.withTx(tx).set(message);
    errors.withTx(tx).set(undefined);
    pending.withTx(tx).set(false);
    internal.withTx(tx).set({ requestHash: hash, phase: "resolved" });
    return;
  }

  const identity = tx.tx.scopeKeyIdentity ?? runtime.scopeKeyIdentity;
  const targetKey = effectTargetKey("compileAndRun", result, identity);
  // A recovered marker must first issue this instance's target-space compile
  // request, which registers closure replication before the cache is consumed.
  const compiled = memo?.requestHash === hash && memo.phase === "compiled" &&
      issuedRequests.get(targetKey) === hash
    ? runtime.patternManager.getCompiledPatternForProgramSync(
      program,
      parent.space,
    )
    : undefined;
  if (compiled !== undefined) {
    // Child setup belongs to the graph run, whose transaction carries the
    // requesting instance and whose stop/start order owns the result cell.
    runtime.runner.clearInTransaction(tx, result);
    const started = runtime.runner.runInTransaction(
      tx,
      compiled,
      inputs.withTx(tx).key("input").get(),
      result,
      { parentPieceRootId: parent.getAsNormalizedFullLink().id },
    );
    if (started instanceof Promise) return started;
    if (result.withTx(tx).get() !== undefined) {
      result.withTx(tx).key("isHidden").set(true);
    }
    error.withTx(tx).set(undefined);
    errors.withTx(tx).set(undefined);
    pending.withTx(tx).set(false);
    internal.withTx(tx).set({
      requestHash: hash,
      phase: "resolved",
    });
    return;
  }

  const effectKey = effectTargetKey(`compileAndRun:${hash}`, result, identity);
  // A durable pending marker survives the runtime that issued it. Only an
  // issue accepted in this runtime can suppress a repeated request, and the
  // record belongs to the concrete user or session instance.
  if (
    !newRequest && issuedRequests.get(targetKey) === hash &&
    memo?.phase !== "compiled"
  ) return;

  runtime.runner.clearInTransaction(tx, result);
  result.withTx(tx).setRawUntyped(UNAVAILABLE_PENDING, true);
  error.withTx(tx).set(undefined);
  errors.withTx(tx).set(undefined);
  pending.withTx(tx).set(true);
  internal.withTx(tx).set({ requestHash: hash, phase: "pending" });
  // The outbox owns the request, and `program` is already detached from the
  // issuing transaction.
  const request = program;
  enqueueSinkRequestPostCommitEffect(
    tx,
    "compileAndRun",
    `compileAndRun:${hash}`,
    request,
    "compile-and-run",
    (committedTx) => {
      const work = (async () => {
        // A successful wave can withdraw one contribution while accepting
        // others. Only this request's accepted contribution may compile.
        const settlement = waveSettlementOf(committedTx) ??
          waveSettlementOf(tx);
        if (
          settlement !== undefined && (await settlement).error !== undefined
        ) {
          return;
        }
        // Only accepted outbox dispatch can suppress a subsequent request;
        // sealing alone can still be withdrawn before compilation starts.
        issuedRequests.set(targetKey, hash);
        await performServedCompile(
          runtime,
          inputs,
          parent.space,
          cells,
          request,
          hash,
          effectKey,
          identity,
          () => {
            if (issuedRequests.get(targetKey) === hash) {
              issuedRequests.delete(targetKey);
            }
          },
        );
      })();
      runtime.trackAsyncWork(work, parent);
    },
    {
      idempotencyKey: effectKey,
      onRejected: (rejection) => {
        runtime.trackAsyncWork(
          settleAbandonedRequest(
            runtime,
            "compileAndRun",
            effectKey,
            (settleTx) => {
              settleTx.tx.scopeKeyIdentity = identity;
              const current = snapshotQueryResult(
                inputs.asSchema<RuntimeProgram>(programSchema).withTx(settleTx)
                  .get(),
              );
              const currentUnavailable = selectUnavailableInput(
                inputs.withTx(settleTx).getRaw(),
                { runtime, tx: settleTx, base: inputs },
              );
              if (
                compileRequestHash(current, currentUnavailable) !== hash
              ) {
                return;
              }
              const memo = internal.withTx(settleTx).get();
              if (memo?.requestHash === hash && memo.phase === "resolved") {
                return;
              }
              pending.withTx(settleTx).set(false);
              result.withTx(settleTx).setRawUntyped(
                compileUnavailable(rejection.message),
                true,
              );
              error.withTx(settleTx).set(rejection.message);
              errors.withTx(settleTx).set(undefined);
              internal.withTx(settleTx).set({
                requestHash: hash,
                phase: "resolved",
              });
              announce(settleTx);
            },
          ),
          parent,
        );
      },
    },
  );
}

/**
 * Compiles an issued request and commits its outcome with the issuing identity.
 * Superseded requests finish without writing, releasing their outbox key so
 * an attached request for the same content can complete.
 */
async function performServedCompile(
  runtime: Runtime,
  inputs: Cell<BuiltInCompileAndRunParams<any>>,
  space: MemorySpace,
  cells: ServedCompileCells,
  program: RuntimeProgram,
  hash: string,
  effectKey: string,
  identity: ScopeKeyIdentity,
  retireRequest: () => void,
): Promise<void> {
  let failure: unknown;
  let failed = false;
  let compiled = false;
  try {
    compiled =
      !!(await runtime.patternManager.compileOrGetPattern(program, space));
  } catch (error) {
    failure = error;
    failed = true;
  }

  let superseded = false;
  const written = await runtime.editWithRetry((tx) => {
    tx.tx.scopeKeyIdentity = identity;
    markEffectCompletion(tx, effectKey);
    // The accepted derivation owns request selection. Computed source cells
    // can require that derivation's scoped projection to resolve, whereas this
    // completion only records the outcome for its accepted request.
    const memo = cells.internal.withTx(tx).get();
    if (memo?.requestHash !== hash) {
      superseded = true;
      return;
    }
    superseded = false;
    if (memo.phase === "resolved") return;
    // Completion labels include the current source projection as well as the
    // accepted request marker. Its value does not select the child program.
    const rawCurrent = inputs.withTx(tx).getRaw();
    const currentUnavailable = selectUnavailableInput(rawCurrent, {
      runtime,
      tx,
      base: inputs,
    });
    snapshotQueryResult(
      currentUnavailable === undefined
        ? inputs.asSchema<RuntimeProgram>(programSchema).withTx(tx).get()
        : rawCurrent,
    );
    if (compiled) {
      // The derivation reads this marker and performs child setup in its own
      // wave. Completion alone does not declare the request resolved.
      cells.internal.withTx(tx).set({ requestHash: hash, phase: "compiled" });
      return;
    }
    if (failed) {
      if (failure instanceof CompilerError) {
        const diagnostics = failure.errors.map((error) => ({
          line: error.line ?? 1,
          column: error.column ?? 1,
          message: error.message,
          type: error.type,
          file: error.file,
        }));
        cells.errors.withTx(tx).set(diagnostics);
        cells.result.withTx(tx).setRawUntyped(
          compileUnavailable(failure.message),
          true,
        );
      } else {
        const message = failure instanceof Error
          ? failure.message + (failure.stack ? "\n" + failure.stack : "")
          : String(failure);
        cells.error.withTx(tx).set(message);
        cells.result.withTx(tx).setRawUntyped(
          compileUnavailable(message),
          true,
        );
      }
    }
    cells.pending.withTx(tx).set(false);
    cells.internal.withTx(tx).set({ requestHash: hash, phase: "resolved" });
  });
  if (written.error !== undefined) {
    throw new Error(`Compile completion failed: ${written.error.message}`, {
      cause: written.error,
    });
  }
  if (superseded) {
    // A rejected newer overlay or a delayed accepted marker can reveal this
    // request again. Allow its next derivation to attach a fresh completion.
    retireRequest();
    runtime.effectMemoObserver?.({
      kind: "superseded",
      id: `compileAndRun:${hash}`,
    });
  }
}
