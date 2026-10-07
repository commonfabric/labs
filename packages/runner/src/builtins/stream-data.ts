import {
  UNAVAILABLE_PENDING,
  unavailableError,
  unavailableMismatch,
} from "@commonfabric/data-model/availability";
import { internSchema } from "@commonfabric/data-model-schema";
import { hashOf } from "@commonfabric/data-model";

import type { JSONSchema } from "@commonfabric/api";

import type { CellScope } from "../builder/types.ts";
import { type Cell } from "../cell.ts";
import { createFrozenRequestSnapshot } from "../cfc/request-snapshot.ts";
import { validateSchemaValue } from "../cfc/schema-sanitization.ts";
import { enqueueSinkRequestPostCommitEffect } from "../cfc/sink-request.ts";
import { effectTargetKey } from "../executor/effect-completion.ts";
import { settleAbandonedRequest } from "./abandoned-request.ts";
import { ownedCell } from "./runtime-owned-store.ts";
import { setResultCell } from "../result-utils.ts";
import type { Runtime } from "../runtime.ts";
import { type Action } from "../scheduler.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { selectUnavailableInput } from "../data-unavailability.ts";

/**
 * Stream data from a URL, used for querying Synopsys.
 * Ben: This is a hack for demo purposes, we should feel free to delete this file when we have a robust integration.
 *
 * This differs from a regular fetch in that we poll in a generator loop to get all the data.
 *
 * Returns the streamed result as `result`. `pending` is true while a request is pending.
 *
 * @param url - A doc containing the URL to stream data from.
 * @returns { pending: boolean, result: any, error: any } - As individual docs, representing `pending` state, streamed `result`, and any `error`.
 */
export function streamData(
  inputsCell: Cell<StreamDataInputs>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  return createStreamDataAction(
    "legacy",
    inputsCell,
    sendResult,
    addCancel,
    cause,
    parentCell,
    runtime,
  );
}

/** Direct-final stream contract used by newly compiled graphs. */
export function streamDataResult(
  inputsCell: Cell<StreamDataInputs>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  return createStreamDataAction(
    "availability",
    inputsCell,
    sendResult,
    addCancel,
    cause,
    parentCell,
    runtime,
  );
}

function createStreamDataAction(
  contract: "legacy" | "availability",
  inputsCell: Cell<StreamDataInputs>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  const status = { run: 0, controller: undefined } as {
    run: number;
    controller: AbortController | undefined;
  };

  let previousCall = "";
  let startAttempt = 0;
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<any | undefined>;
  let partial: Cell<any | undefined> | undefined;
  let error: Cell<any | undefined>;
  let cellScope: CellScope | undefined;

  addCancel(() => {
    ++status.run;
    status.controller?.abort();
    status.controller = undefined;
  });

  return (tx: IExtendedStorageTransaction) => {
    // Deferred under server-execution v2: disabled while the flag is on, with
    // nothing half-working — no cells are minted and no request starts
    // (docs/specs/server-side-execution/builtins.md §5).
    if (runtime.experimental.serverExecution) {
      throw new Error(
        "The streamData built-in is disabled under " +
          "EXPERIMENTAL_SERVER_EXECUTION: it is deferred in server-execution " +
          "v2 (docs/specs/server-side-execution/builtins.md §5).",
      );
    }
    tx.resetNarrowestReadScope();
    const inputWithLog = inputsCell.withTx(tx);
    const unavailableInput = contract === "availability"
      ? selectUnavailableInput(inputWithLog.getRaw(), {
        runtime,
        tx,
        base: inputsCell,
      })
      : undefined;
    const requestSnapshot = unavailableInput === undefined
      ? snapshotStreamDataInputs(inputWithLog)
      : undefined;
    const outputScope = tx.getNarrowestReadScope();

    if (!cellsInitialized || cellScope !== outputScope) {
      if (cellsInitialized && cellScope !== outputScope) {
        previousCall = "";
      }
      const namespace = contract === "legacy"
        ? "streamData"
        : "streamDataResult";
      pending = ownedCell<boolean>(
        runtime,
        tx,
        parentCell,
        { [namespace]: { pending: cause } },
        undefined,
        outputScope,
      );
      pending.send(false);

      result = ownedCell<any | undefined>(
        runtime,
        tx,
        parentCell,
        { [namespace]: { result: cause } },
        undefined,
        outputScope,
      );

      if (contract === "availability") {
        partial = ownedCell<any | undefined>(
          runtime,
          tx,
          parentCell,
          { [namespace]: { partial: cause } },
          undefined,
          outputScope,
        );
      }

      error = ownedCell<any | undefined>(
        runtime,
        tx,
        parentCell,
        { [namespace]: { error: cause } },
        undefined,
        outputScope,
      );

      // Link the new result cells to the parent result cell
      setResultCell(pending, parentCell);
      setResultCell(result, parentCell);
      if (partial) setResultCell(partial, parentCell);
      setResultCell(error, parentCell);

      // Since we'll only write into the docs above, we only have to call this once
      // here, instead of in the action.
      sendResult(
        tx,
        contract === "availability"
          ? { pending, result, partial, error }
          : { pending, result, error },
      );
      cellsInitialized = true;
      cellScope = outputScope;
    }
    const pendingWithLog = pending.withTx(tx);
    const resultWithLog = result.withTx(tx);
    const partialWithLog = partial?.withTx(tx);
    const errorWithLog = error.withTx(tx);

    if (unavailableInput !== undefined) {
      previousCall = "";
      if (status.controller) {
        status.controller.abort("Inputs unavailable");
        status.controller = undefined;
      }
      ++status.run;
      pendingWithLog.set(
        unavailableInput.reason === "pending" ||
          unavailableInput.reason === "syncing",
      );
      resultWithLog.setRaw(unavailableInput);
      partialWithLog!.setRaw(unavailableInput);
      errorWithLog.set(
        unavailableInput.reason === "error"
          ? unavailableInput.rawErrorMessage ?? undefined
          : undefined,
      );
      return;
    }

    // Unavailable inputs return above, so the request is materialized here.
    const materializedRequest = requestSnapshot!;
    const { url, options, schema } = materializedRequest;

    const requestId = hashOf(materializedRequest).toString();
    // Re-entrancy guard: Don't restart the stream if the entire canonical
    // request, including its event schema, is unchanged.
    const currentCall = requestId;
    if (currentCall === previousCall) return;
    const previousCallBeforeAttempt = previousCall;
    const thisAttempt = ++startAttempt;
    previousCall = currentCall;
    tx.addCommitCallback((_committedTx, commitResult) => {
      if (
        commitResult.error &&
        startAttempt === thisAttempt &&
        previousCall === currentCall
      ) {
        previousCall = previousCallBeforeAttempt;
      }
    });

    if (status.controller) {
      status.controller.abort();
      status.controller = undefined;
    }

    if (url === undefined) {
      pendingWithLog.set(false);
      if (contract === "availability") {
        const unavailable = unavailableError(
          "Streaming requires a URL",
          "invalidInput",
        );
        resultWithLog.setRaw(unavailable);
        partialWithLog!.setRaw(unavailable);
      } else {
        resultWithLog.set(undefined);
      }
      errorWithLog.set(undefined);
      ++status.run;
      return;
    }

    pendingWithLog.set(true);
    if (contract === "availability") {
      resultWithLog.setRaw(UNAVAILABLE_PENDING);
      partialWithLog!.setRaw(UNAVAILABLE_PENDING);
    } else {
      resultWithLog.set(undefined);
    }
    errorWithLog.set(undefined);

    const thisRun = ++status.run;
    const effectNamespace = contract === "legacy"
      ? "streamData"
      : "streamDataResult";
    // The outbox key is the request widened by THIS node's result-cell
    // identity, so two distinct nodes streaming the same url each keep their
    // own effect and their own ending, rather than sharing one under the bare
    // request id.
    const effectKey = effectTargetKey(
      `${effectNamespace}:${requestId}`,
      result,
    );

    enqueueSinkRequestPostCommitEffect(
      tx,
      // Both persisted contracts perform the same external stream operation;
      // the deployment ceiling is declared for that capability, not for the
      // graph-version-specific result namespace below.
      "streamData",
      `${effectNamespace}:${requestId}`,
      materializedRequest,
      `${effectNamespace}-start`,
      // The read loop below lives until the stream ends or is aborted, so it
      // is not handed to `trackAsyncWork`: a barrier waiting on it would never
      // return while a stream is connected. The abandonment settle below is
      // separate work with its own completion, and is registered.
      () => {
        if (thisRun !== status.run) {
          return;
        }

        const controller = new AbortController();
        const signal = controller.signal;
        status.controller = controller;

        fetch(url, { ...options, signal })
          .then(async (response) => {
            if (!response.ok) {
              throw new Error(
                `Stream request failed: ${response.status} ${response.statusText}`,
              );
            }
            const reader = response.body?.getReader();
            const utf8 = new TextDecoder();

            if (!reader) {
              throw new Error("Response body is not readable");
            }

            const decoder = createSseEventDecoder();
            let lastEvent: unknown;

            while (true) {
              if (thisRun !== status.run) {
                controller.abort();
                return;
              }

              const { done, value } = await reader.read();
              const text = value ? utf8.decode(value, { stream: !done }) : "";
              const decoded = decoder.push(
                done ? text + utf8.decode() : text,
                done,
              );

              for (const parsedData of decoded) {
                if (schema !== undefined) {
                  const failure = validateSchemaValue(schema, parsedData);
                  if (failure) {
                    throw new StreamDataSchemaMismatchError(failure);
                  }
                }
                lastEvent = parsedData;
                await runtime.idle();
                await runtime.editWithRetry((tx) => {
                  if (thisRun !== status.run) return;
                  if (contract === "availability") {
                    partial!.withTx(tx).set(parsedData);
                  } else {
                    result.withTx(tx).set(parsedData);
                  }
                });
              }

              if (done) {
                if (contract === "availability") {
                  if (lastEvent === undefined) {
                    throw new Error("Stream closed before emitting an event");
                  }
                  await runtime.editWithRetry((tx) => {
                    if (thisRun !== status.run) return;
                    pending.withTx(tx).set(false);
                    result.withTx(tx).set(lastEvent);
                    error.withTx(tx).set(undefined);
                  });
                }
                if (thisRun === status.run) status.controller = undefined;
                break;
              }
            }
          })
          .catch(async (e) => {
            if (e instanceof DOMException && e.name === "AbortError") {
              return;
            }
            // The legacy contract clears its raw result. The availability
            // contract publishes a terminal marker; callers that need visual
            // continuity can retain its partial result with latestComplete().
            console.error(e);

            await runtime.idle();

            await runtime.editWithRetry((tx) => {
              if (thisRun !== status.run) return;
              pending.withTx(tx).set(false);
              if (contract === "availability") {
                const unavailable = e instanceof StreamDataSchemaMismatchError
                  ? unavailableMismatch(e.message)
                  : unavailableError(
                    e instanceof Error ? e : new Error(String(e)),
                  );
                result.withTx(tx).setRaw(unavailable);
                partial!.withTx(tx).setRaw(unavailable);
              } else {
                result.withTx(tx).set(undefined);
              }
              error.withTx(tx).set(e);
            });

            if (contract === "legacy") {
              // Preserve the old raw state's retry behavior.
              previousCall = "";
            }
            if (thisRun === status.run) status.controller = undefined;
          });
      },
      {
        idempotencyKey: effectKey,
        onRejected: (rejection) => {
          runtime.trackAsyncWork(
            settleAbandonedRequest(
              runtime,
              effectNamespace,
              effectKey,
              (settleTx) => {
                // The announcement rode the abandoned transaction, so it is
                // made again whoever owns the answer now.
                sendResult(
                  settleTx,
                  contract === "availability"
                    ? { pending, result, partial, error }
                    : { pending, result, error },
                );
                // Decided here rather than when this callback ran: a newer
                // request can start in between, and the stream it opens owns
                // these cells from then on.
                if (thisRun !== status.run) return;
                pending.withTx(settleTx).set(false);
                if (contract === "availability") {
                  const unavailable = unavailableError(rejection);
                  result.withTx(settleTx).setRaw(unavailable);
                  partial!.withTx(settleTx).setRaw(unavailable);
                } else {
                  result.withTx(settleTx).set(undefined);
                }
                error.withTx(settleTx).set(rejection.message);
              },
            ),
            parentCell,
          );
        },
      },
    );
  };
}

class StreamDataSchemaMismatchError extends Error {}

function createSseEventDecoder(): {
  push(text: string, flush: boolean): unknown[];
} {
  let buffer = "";
  let id: string | undefined;
  let event: string | undefined;
  let data: string[] = [];

  const finishEvent = (): unknown | undefined => {
    if (id === undefined && event === undefined && data.length === 0) {
      return undefined;
    }
    if (id === undefined || event === undefined || data.length === 0) {
      throw new Error("Incomplete server-sent event");
    }
    const value = { id, event, data: JSON.parse(data.join("\n")) };
    id = undefined;
    event = undefined;
    data = [];
    return value;
  };

  const consumeLine = (line: string): unknown | undefined => {
    if (line === "") return finishEvent();
    if (line.startsWith("id:")) id = line.slice(3).trimStart();
    else if (line.startsWith("event:")) event = line.slice(6).trimStart();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    return undefined;
  };

  return {
    push(text: string, flush: boolean): unknown[] {
      buffer += text;
      const values: unknown[] = [];
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        const value = consumeLine(line);
        if (value !== undefined) values.push(value);
      }
      if (flush) {
        if (buffer.length > 0) {
          const value = consumeLine(buffer.replace(/\r$/, ""));
          if (value !== undefined) values.push(value);
          buffer = "";
        }
        const value = finishEvent();
        if (value !== undefined) values.push(value);
      }
      return values;
    },
  };
}

type StreamDataInputs = {
  url?: string;
  schema?: JSONSchema;
  options?: { body?: any; method?: string; headers?: Record<string, string> };
};

const streamDataInputSchema = internSchema(
  {
    type: "object",
    properties: {
      url: { type: "string" },
      schema: true,
      options: {
        type: "object",
        properties: {
          body: {},
          method: { type: "string" },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
      },
    },
  },
);

function snapshotStreamDataInputs(
  cell: Cell<StreamDataInputs>,
): StreamDataInputs {
  const snapshot = cell.asSchema(streamDataInputSchema).get() ??
    ({} as StreamDataInputs);
  const body = snapshot.options?.body;
  if (!snapshot.options) {
    return createFrozenRequestSnapshot({
      url: snapshot.url,
      ...(snapshot.schema !== undefined && { schema: snapshot.schema }),
    });
  }
  // TODO(danfuzz): same gap as the fetch builtin's body handling: the `body`
  // schema is open (`{}`), and `JSON.stringify` renders a
  // `FabricSpecialObject` body as `"{}"` — on the wire and in the request id
  // the snapshot hashes to.
  const options = {
    ...snapshot.options,
    body: body !== undefined && typeof body !== "string"
      ? JSON.stringify(body)
      : body,
  };
  return createFrozenRequestSnapshot({
    url: snapshot.url,
    ...(snapshot.schema !== undefined && { schema: snapshot.schema }),
    options,
  });
}
