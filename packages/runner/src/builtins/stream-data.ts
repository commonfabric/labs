import { internSchema } from "@commonfabric/data-model-schema";
import { hashOf } from "@commonfabric/data-model";

import type { CellScope } from "../builder/types.ts";
import { type Cell } from "../cell.ts";
import { createFrozenRequestSnapshot } from "../cfc/request-snapshot.ts";
import { enqueueSinkRequestPostCommitEffect } from "../cfc/sink-request.ts";
import { effectTargetKey } from "../executor/effect-completion.ts";
import { settleAbandonedRequest } from "./abandoned-request.ts";
import { ownedCell } from "./runtime-owned-store.ts";
import { setResultCell } from "../result-utils.ts";
import type { Runtime } from "../runtime.ts";
import { type Action } from "../scheduler.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

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
  inputsCell: Cell<{
    url: string;
    options?: { body?: any; method?: string; headers?: Record<string, string> };
    result?: any;
  }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime, // Runtime will be injected by the registration function
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
  let error: Cell<any | undefined>;
  let cellScope: CellScope | undefined;

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
    const requestSnapshot = snapshotStreamDataInputs(inputsCell.withTx(tx));
    const outputScope = tx.getNarrowestReadScope();

    if (!cellsInitialized || cellScope !== outputScope) {
      if (cellsInitialized && cellScope !== outputScope) {
        previousCall = "";
      }
      pending = ownedCell<boolean>(
        runtime,
        tx,
        parentCell,
        { streamData: { pending: cause } },
        undefined,
        outputScope,
      );
      pending.send(false);

      result = ownedCell<any | undefined>(
        runtime,
        tx,
        parentCell,
        {
          streamData: { result: cause },
        },
        undefined,
        outputScope,
      );

      error = ownedCell<any | undefined>(
        runtime,
        tx,
        parentCell,
        {
          streamData: { error: cause },
        },
        undefined,
        outputScope,
      );

      // Link the new result cells to the parent result cell
      setResultCell(pending, parentCell);
      setResultCell(result, parentCell);
      setResultCell(error, parentCell);

      // Since we'll only write into the docs above, we only have to call this once
      // here, instead of in the action.
      sendResult(tx, { pending, result, error });
      cellsInitialized = true;
      cellScope = outputScope;
    }
    const pendingWithLog = pending.withTx(tx);
    const resultWithLog = result.withTx(tx);
    const errorWithLog = error.withTx(tx);

    const { url, options } = requestSnapshot;

    // Re-entrancy guard: Don't restart the stream if it's the same request.
    const currentCall = `${url}${JSON.stringify(options)}`;
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
      resultWithLog.set(undefined);
      errorWithLog.set(undefined);
      ++status.run;
      return;
    }

    pendingWithLog.set(true);
    resultWithLog.set(undefined);
    errorWithLog.set(undefined);

    const thisRun = ++status.run;
    const requestId = hashOf(requestSnapshot).toString();
    // The outbox key is the request widened by THIS node's result-cell
    // identity, so two distinct nodes streaming the same url each keep their
    // own effect and their own ending, rather than sharing one under the bare
    // request id.
    const effectKey = effectTargetKey(`streamData:${requestId}`, result);

    enqueueSinkRequestPostCommitEffect(
      tx,
      "streamData",
      `streamData:${requestId}`,
      requestSnapshot,
      "streamData-start",
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
            const reader = response.body?.getReader();
            const utf8 = new TextDecoder();

            if (!reader) {
              throw new Error("Response body is not readable");
            }

            let buffer = "";
            let id: string | undefined = undefined;
            let event: string | undefined = undefined;
            let data: string | undefined = undefined;

            while (true) {
              if (thisRun !== status.run) {
                controller.abort();
                return;
              }

              const { done, value } = await reader.read();

              buffer += utf8.decode(value);
              while (buffer.includes("\n")) {
                const line = buffer.split("\n")[0];
                buffer = buffer.slice(line.length + 1);

                if (line.startsWith("id:")) {
                  id = line.slice("id:".length);
                } else if (line.startsWith("event:")) {
                  event = line.slice("event:".length);
                } else if (line.startsWith("data:")) {
                  data = line.slice("data:".length);
                }
              }

              if (id && event && data) {
                const parsedData = {
                  id,
                  event,
                  data: JSON.parse(data),
                };

                await runtime.idle();

                await runtime.editWithRetry((tx) => {
                  result.withTx(tx).set(parsedData);
                });

                id = undefined;
                event = undefined;
                data = undefined;
              }

              if (done) {
                break;
              }
            }
          })
          .catch(async (e) => {
            if (e instanceof DOMException && e.name === "AbortError") {
              return;
            }
            // FIXME(ja): I don't think this is the right logic... if the stream
            // disconnects, we should probably not erase the result.
            // FIXME(ja): also pending should probably be more like "live"?
            console.error(e);

            await runtime.idle();

            await runtime.editWithRetry((tx) => {
              pending.withTx(tx).set(false);
              result.withTx(tx).set(undefined);
              error.withTx(tx).set(e);
            });

            // Allow retrying the same request.
            previousCall = "";
          });
      },
      {
        idempotencyKey: effectKey,
        onRejected: (rejection) => {
          runtime.trackAsyncWork(
            settleAbandonedRequest(
              runtime,
              "streamData",
              effectKey,
              (settleTx) => {
                // The announcement rode the abandoned transaction, so it is
                // made again whoever owns the answer now.
                sendResult(settleTx, { pending, result, error });
                // Decided here rather than when this callback ran: a newer
                // request can start in between, and the stream it opens owns
                // these cells from then on.
                if (thisRun !== status.run) return;
                pending.withTx(settleTx).set(false);
                result.withTx(settleTx).set(undefined);
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

type StreamDataInputs = {
  url?: string;
  options?: { body?: any; method?: string; headers?: Record<string, string> };
};

const streamDataInputSchema = internSchema(
  {
    type: "object",
    properties: {
      url: { type: "string" },
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
    return createFrozenRequestSnapshot({ url: snapshot.url });
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
  return createFrozenRequestSnapshot({ url: snapshot.url, options });
}
