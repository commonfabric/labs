import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { RuntimeClient } from "@/runtime-client.ts";
import { EventEmitter } from "@/client/emitter.ts";
import type {
  RuntimeTransport,
  RuntimeTransportEvents,
} from "@/client/transport.ts";
import {
  type CellRef,
  type Commands,
  type ConsoleNotification,
  type IPCClientMessage,
  type IPCClientNotification,
  type IPCClientRequest,
  NotificationType,
  type RemoteResponse,
  RequestType,
  type TelemetryNotification,
} from "@/protocol/mod.ts";

/**
 * A transport standing in for the worker: it records every request after the
 * handshake and responds to each with what `answers` holds for its type, or
 * with nothing.
 */
class AnsweringTransport extends EventEmitter<RuntimeTransportEvents>
  implements RuntimeTransport {
  readonly requests: IPCClientRequest[] = [];
  /** The build each reply says the worker runs. */
  runtimeBuild: string | undefined;
  readonly #answers: Partial<Record<RequestType, RemoteResponse>>;

  constructor(answers: Partial<Record<RequestType, RemoteResponse>> = {}) {
    super();
    this.#answers = answers;
  }

  send(message: IPCClientMessage | IPCClientNotification): void {
    if (!("msgId" in message)) return;
    if (message.data.type !== RequestType.Initialize) {
      this.requests.push(message.data);
    }
    queueMicrotask(() =>
      this.emit("message", {
        msgId: message.msgId,
        runtimeBuild: this.runtimeBuild,
        data: this.#answers[message.data.type],
      })
    );
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

const identity = await Identity.fromPassphrase("runtime-client-requests");

async function clientOver(
  transport: AnsweringTransport,
): Promise<RuntimeClient> {
  return await RuntimeClient.initialize(transport, {
    apiUrl: new URL("http://localhost:9/"),
    identity,
    spaceDid: identity.did(),
  });
}

const space = identity.did();

const homeRef: CellRef = {
  id: "of:fid1-runtime-client-requests-home" as CellRef["id"],
  space,
  scope: "space",
  path: [],
};

/**
 * Methods that send one request and resolve with nothing, each with the
 * request it sends.
 */
const commands: Array<{
  name: string;
  call: (client: RuntimeClient) => Promise<void>;
  request: IPCClientRequest;
}> = [
  {
    name: "allSynced()",
    call: (client) => client.allSynced(),
    request: { type: RequestType.RuntimeSynced },
  },
  {
    name: "synced()",
    call: (client) => client.synced(space),
    request: { type: RequestType.PieceSynced, space },
  },
  {
    name: "flushCompileCacheWrites()",
    call: (client) => client.flushCompileCacheWrites(),
    request: { type: RequestType.FlushCompileCacheWrites },
  },
  {
    name: "setLoggerLevel()",
    call: (client) => client.setLoggerLevel("debug", "runner"),
    request: {
      type: RequestType.SetLoggerLevel,
      level: "debug",
      loggerName: "runner",
    },
  },
  {
    name: "setLoggerEnabled()",
    call: (client) => client.setLoggerEnabled(false),
    request: {
      type: RequestType.SetLoggerEnabled,
      enabled: false,
      loggerName: undefined,
    },
  },
  {
    name: "setTelemetryEnabled()",
    call: (client) => client.setTelemetryEnabled(true),
    request: { type: RequestType.SetTelemetryEnabled, enabled: true },
  },
  {
    name: "resetLoggerBaselines()",
    call: (client) => client.resetLoggerBaselines(),
    request: { type: RequestType.ResetLoggerBaselines },
  },
  {
    name: "setSettleStatsEnabled()",
    call: (client) => client.setSettleStatsEnabled(true),
    request: { type: RequestType.SetSettleStatsEnabled, enabled: true },
  },
  {
    name: "setActionRunTraceEnabled()",
    call: (client) => client.setActionRunTraceEnabled(false),
    request: { type: RequestType.SetActionRunTraceEnabled, enabled: false },
  },
  {
    name: "setTriggerTraceEnabled()",
    call: (client) => client.setTriggerTraceEnabled(true),
    request: { type: RequestType.SetTriggerTraceEnabled, enabled: true },
  },
  {
    name: "setWriteStackTraceMatchers()",
    call: (client) =>
      client.setWriteStackTraceMatchers([{ space, entityId: "of:x" }]),
    request: {
      type: RequestType.SetWriteStackTraceMatchers,
      matchers: [{ space, entityId: "of:x" }],
    },
  },
  {
    name: "setBreakpoints()",
    call: (client) => client.setBreakpoints(["action-1", "action-2"]),
    request: {
      type: RequestType.SetBreakpoints,
      actionIds: ["action-1", "action-2"],
    },
  },
];

/**
 * A method that sends one request and resolves with part of the answer: the
 * request it sends, the answer the worker gives, and a value equal to the part
 * it resolves with.
 */
type Query = {
  name: string;
  call: (client: RuntimeClient) => Promise<unknown>;
  request: IPCClientRequest;
  answer: RemoteResponse;
  result: () => unknown;
};

function query<T extends keyof Commands>(
  name: string,
  call: (client: RuntimeClient) => Promise<unknown>,
  request: Commands[T]["request"],
  answer: Commands[T]["response"],
  result: (answer: Commands[T]["response"]) => unknown,
): Query {
  return {
    name,
    call,
    request,
    answer,
    result: () => result(answer),
  };
}

const queries: Query[] = [
  query<RequestType.RegisterSpaceHost>(
    "registerSpaceHost()",
    (client) => client.registerSpaceHost(space, "https://a.test"),
    { type: RequestType.RegisterSpaceHost, space, host: "https://a.test" },
    { value: true },
    (answer) => answer.value,
  ),
  query<RequestType.GetGraphSnapshot>(
    "getGraphSnapshot()",
    (client) => client.getGraphSnapshot(),
    { type: RequestType.GetGraphSnapshot },
    { snapshot: { nodes: [], edges: [], timestamp: 1 } },
    (answer) => answer.snapshot,
  ),
  query<RequestType.GetSettleStatsHistory>(
    "getSettleStatsHistory()",
    (client) => client.getSettleStatsHistory(),
    { type: RequestType.GetSettleStatsHistory },
    { history: [] },
    (answer) => answer.history,
  ),
  query<RequestType.GetActionRunTrace>(
    "getActionRunTrace()",
    (client) => client.getActionRunTrace(),
    { type: RequestType.GetActionRunTrace },
    { trace: [] },
    (answer) => answer.trace,
  ),
  query<RequestType.GetTriggerTrace>(
    "getTriggerTrace()",
    (client) => client.getTriggerTrace(),
    { type: RequestType.GetTriggerTrace },
    { trace: [] },
    (answer) => answer.trace,
  ),
  query<RequestType.GetWriteStackTrace>(
    "getWriteStackTrace()",
    (client) => client.getWriteStackTrace(),
    { type: RequestType.GetWriteStackTrace },
    { trace: [] },
    (answer) => answer.trace,
  ),
  query<RequestType.GetPatternSources>(
    "getPatternSources()",
    (client) => client.getPatternSources(),
    { type: RequestType.GetPatternSources },
    { patterns: [] },
    (answer) => answer,
  ),
  query<RequestType.DetectNonIdempotent>(
    "detectNonIdempotent()",
    (client) => client.detectNonIdempotent(250),
    { type: RequestType.DetectNonIdempotent, durationMs: 250 },
    { result: { nonIdempotent: [], cycles: [], duration: 250, busyTime: 0 } },
    (answer) => answer.result,
  ),
];

describe("runtime-client", () => {
  describe("RuntimeClient", () => {
    describe("instance members", () => {
      for (const { name, call, request } of commands) {
        describe(name, () => {
          it("sends its request and resolves with nothing", async () => {
            const transport = new AnsweringTransport();
            await using client = await clientOver(transport);
            await expect(call(client)).resolves.toBeUndefined();
            expect(transport.requests).toEqual([request]);
          });
        });
      }

      for (const { name, call, request, answer, result } of queries) {
        describe(name, () => {
          it("sends its request and resolves with the worker's answer", async () => {
            const transport = new AnsweringTransport({
              [request.type]: answer,
            });
            await using client = await clientOver(transport);
            const resolved = await call(client);
            expect(resolved).toEqual(result());
            expect(resolved).not.toBeUndefined();
            expect(transport.requests).toEqual([request]);
          });
        });
      }

      describe("buildDiagnostics", () => {
        it("returns the build the worker named when it answered the handshake", async () => {
          const transport = new AnsweringTransport();
          transport.runtimeBuild = "c".repeat(40);
          await using client = await clientOver(transport);
          expect(client.buildDiagnostics.peer).toBe("c".repeat(40));
        });

        it("returns no peer build for a worker that named none", async () => {
          await using client = await clientOver(new AnsweringTransport());
          expect(client.buildDiagnostics.peer).toBeUndefined();
        });
      });

      describe("getPiecesListCell()", () => {
        it("returns a handle on the list cell the worker names for the space", async () => {
          const transport = new AnsweringTransport({
            [RequestType.PieceGetAll]: { cell: homeRef },
          });
          await using client = await clientOver(transport);
          const cell = await client.getPiecesListCell(space);
          expect(cell.ref()).toEqual(homeRef);
          expect(transport.requests).toEqual([{
            type: RequestType.PieceGetAll,
            space,
          }]);
        });
      });

      describe("getHomeSpaceCell()", () => {
        it("returns a handle on the cell the worker names", async () => {
          const transport = new AnsweringTransport({
            [RequestType.GetHomeSpaceCell]: { cell: homeRef },
          });
          await using client = await clientOver(transport);
          const cell = await client.getHomeSpaceCell();
          expect(cell.ref()).toEqual(homeRef);
          expect(transport.requests).toEqual([{
            type: RequestType.GetHomeSpaceCell,
          }]);
        });
      });

      describe("getSubscriptionDiagnostics()", () => {
        it("returns no cells before anything subscribes", async () => {
          await using client = await clientOver(new AnsweringTransport());
          expect(client.getSubscriptionDiagnostics()).toEqual({
            totals: {
              localSubscribes: 0,
              localUnsubscribes: 0,
              backendSubscribes: 0,
              backendUnsubscribes: 0,
              activeInstances: 0,
            },
            cells: {},
          });
        });

        it("counts each handle locally and one subscription per cell at the worker", async () => {
          const transport = new AnsweringTransport();
          await using client = await clientOver(transport);
          const cancelFirst = client.getCellFromRef(homeRef).subscribe(
            () => {},
            { onRefused: () => {} },
          );
          client.getCellFromRef(homeRef).subscribe(() => {}, {
            onRefused: () => {},
          });
          cancelFirst();
          const [cell, ...others] = Object.values(
            client.getSubscriptionDiagnostics().cells,
          );
          expect(others).toEqual([]);
          expect(cell).toMatchObject({
            localSubscribes: 2,
            localUnsubscribes: 1,
            backendSubscribes: 1,
            backendUnsubscribes: 0,
            activeInstances: 1,
          });
          expect(client.getSubscriptionDiagnostics().totals).toEqual({
            localSubscribes: 2,
            localUnsubscribes: 1,
            backendSubscribes: 1,
            backendUnsubscribes: 0,
            activeInstances: 1,
          });
        });
      });

      describe("resetSubscriptionDiagnostics()", () => {
        it("zeroes the counters and keeps the handles still subscribed", async () => {
          await using client = await clientOver(new AnsweringTransport());
          client.getCellFromRef(homeRef).subscribe(() => {}, {
            onRefused: () => {},
          });
          client.resetSubscriptionDiagnostics();
          expect(client.getSubscriptionDiagnostics().totals).toEqual({
            localSubscribes: 0,
            localUnsubscribes: 0,
            backendSubscribes: 0,
            backendUnsubscribes: 0,
            activeInstances: 1,
          });
        });
      });
    });

    describe("console", () => {
      it("emits each console notification as it arrived", async () => {
        const transport = new AnsweringTransport();
        await using client = await clientOver(transport);
        const heard: unknown[] = [];
        client.on("console", (message) => heard.push(message));
        const message: ConsoleNotification = {
          type: NotificationType.ConsoleMessage,
          method: "log",
          args: ["hello", 1],
        };
        transport.emit("message", message);
        expect(heard).toEqual([message]);
      });
    });

    describe("navigaterequest", () => {
      it("emits a handle on the cell the worker asks to navigate to", async () => {
        const transport = new AnsweringTransport();
        await using client = await clientOver(transport);
        const heard: CellRef[] = [];
        client.on("navigaterequest", ({ cell }) => heard.push(cell.ref()));
        transport.emit("message", {
          type: NotificationType.NavigateRequest,
          targetCellRef: homeRef,
        });
        expect(heard).toEqual([homeRef]);
      });
    });

    describe("telemetry", () => {
      it("emits the marker of each telemetry notification", async () => {
        const transport = new AnsweringTransport();
        await using client = await clientOver(transport);
        const markers: unknown[] = [];
        client.on("telemetry", (marker) => markers.push(marker));
        const marker: TelemetryNotification["marker"] = {
          type: "scheduler.run",
          actionId: "action-1",
          timeStamp: 1,
        };
        transport.emit("message", {
          type: NotificationType.Telemetry,
          marker,
        });
        expect(markers).toEqual([marker]);
      });
    });
  });
});
