import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { InspectorProtocolClient } from "./inspector-protocol-client.ts";

class FakeInspectorSocket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  sendError?: Error;
  closeError?: Event;
  closeCalls = 0;

  send(data: string): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls++;
    if (this.closeError) {
      this.dispatchEvent(this.closeError);
      return;
    }
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close"));
  }

  receive(message: unknown): void {
    this.receiveRaw(JSON.stringify(message));
  }

  receiveRaw(message: string): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: message }),
    );
  }

  fail(event: Event): void {
    this.dispatchEvent(event);
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

Deno.test("InspectorProtocolClient sends commands and resolves responses", async () => {
  const socket = new FakeInspectorSocket();
  const client = new InspectorProtocolClient(socket.asWebSocket());

  const stop = client.Profiler.stop();
  assertEquals(JSON.parse(socket.sent[0]), {
    id: 1,
    method: "Profiler.stop",
    params: {},
  });

  const profile = { nodes: [{ id: 1 }] };
  socket.receive({ id: 1, result: { profile } });
  assertEquals(await stop, { profile });
});

Deno.test("InspectorProtocolClient exposes the profiling command set", async () => {
  const socket = new FakeInspectorSocket();
  const client = new InspectorProtocolClient(socket.asWebSocket());

  const commands = [
    client.Runtime.enable(),
    client.Console.enable(),
    client.Debugger.enable({}),
    client.Profiler.enable(),
    client.Profiler.setSamplingInterval({ interval: 100 }),
    client.Profiler.start(),
  ];
  assertEquals(socket.sent.map((message) => JSON.parse(message)), [
    { id: 1, method: "Runtime.enable", params: {} },
    { id: 2, method: "Console.enable", params: {} },
    { id: 3, method: "Debugger.enable", params: {} },
    { id: 4, method: "Profiler.enable", params: {} },
    {
      id: 5,
      method: "Profiler.setSamplingInterval",
      params: { interval: 100 },
    },
    { id: 6, method: "Profiler.start", params: {} },
  ]);

  for (let id = 1; id <= commands.length; id++) {
    socket.receive({ id, result: {} });
  }
  await Promise.all(commands);
});

Deno.test("InspectorProtocolClient forwards protocol events", () => {
  const socket = new FakeInspectorSocket();
  const client = new InspectorProtocolClient(socket.asWebSocket());
  const received: unknown[] = [];
  client.addEventListener("Runtime.consoleAPICalled", (event) => {
    received.push((event as CustomEvent).detail);
  });

  const detail = { type: "log", args: [{ type: "string", value: "hello" }] };
  socket.receive({
    method: "Runtime.consoleAPICalled",
    params: detail,
  });

  assertEquals(received, [detail]);
});

Deno.test("InspectorProtocolClient rejects protocol errors", async () => {
  const socket = new FakeInspectorSocket();
  const client = new InspectorProtocolClient(socket.asWebSocket());

  const enable = client.Runtime.enable();
  socket.receive({
    id: 1,
    error: {
      code: -32601,
      message: "Method not found",
      data: "Runtime.enable",
    },
  });

  await assertRejects(
    () => enable,
    Error,
    "Method not found (-32601): Runtime.enable",
  );
});

Deno.test("InspectorProtocolClient rejects commands while the socket is not open", async () => {
  const socket = new FakeInspectorSocket();
  socket.readyState = WebSocket.CONNECTING;
  const client = new InspectorProtocolClient(socket.asWebSocket());

  await assertRejects(
    () => client.Runtime.enable(),
    Error,
    "Inspector WebSocket is not open",
  );
  assertEquals(socket.sent, []);
});

Deno.test("InspectorProtocolClient rejects send failures and permits later commands", async () => {
  const socket = new FakeInspectorSocket();
  const sendError = new Error("send failed");
  socket.sendError = sendError;
  const client = new InspectorProtocolClient(socket.asWebSocket());

  await assertRejects(
    () => client.Runtime.enable(),
    Error,
    sendError.message,
  );
  assertEquals(socket.sent, []);

  socket.sendError = undefined;
  const enable = client.Runtime.enable();
  assertEquals(JSON.parse(socket.sent[0]), {
    id: 2,
    method: "Runtime.enable",
    params: {},
  });
  socket.receive({ id: 2, result: { enabled: true } });
  assertEquals(await enable, { enabled: true });
});

Deno.test("InspectorProtocolClient rejects pending commands after an invalid message", async () => {
  const socket = new FakeInspectorSocket();
  const client = new InspectorProtocolClient(socket.asWebSocket());
  const enable = client.Runtime.enable();

  socket.receiveRaw("{");

  const error = await assertRejects(
    () => enable,
    Error,
    "Inspector sent an invalid protocol message",
  );
  assertInstanceOf(error.cause, SyntaxError);
});

Deno.test("InspectorProtocolClient rejects malformed protocol message values", async (t) => {
  const malformedMessages = [
    { name: "null", value: null },
    { name: "primitive", value: "not a protocol message" },
    { name: "array", value: [] },
    { name: "object without an id or method", value: {} },
    {
      name: "response with a nonnumeric id",
      value: { id: "1", result: {} },
    },
  ];

  for (const { name, value } of malformedMessages) {
    await t.step(name, async () => {
      const socket = new FakeInspectorSocket();
      const client = new InspectorProtocolClient(socket.asWebSocket());
      const enable = client.Runtime.enable();

      socket.receive(value);

      await assertRejects(
        () => enable,
        Error,
        "Inspector sent an invalid protocol message",
      );
    });
  }
});

Deno.test("InspectorProtocolClient ignores responses for unknown command IDs", async () => {
  const socket = new FakeInspectorSocket();
  const client = new InspectorProtocolClient(socket.asWebSocket());
  const enable = client.Runtime.enable();

  socket.receive({ id: 999, result: { unexpected: true } });
  socket.receive({ id: 1, result: { enabled: true } });

  assertEquals(await enable, { enabled: true });
});

Deno.test("InspectorProtocolClient rejects pending commands on socket errors", async () => {
  const socket = new FakeInspectorSocket();
  const client = new InspectorProtocolClient(socket.asWebSocket());
  const enable = client.Runtime.enable();
  const settled = enable.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason) => ({ status: "rejected" as const, reason }),
  );
  const socketError = new ErrorEvent("error", {
    message: "inspector connection failed",
  });

  socket.fail(socketError);

  const result = await settled;
  assert(result.status === "rejected");
  assertStrictEquals(result.reason, socketError);
});

Deno.test("InspectorProtocolClient rejects commands when the socket closes", async () => {
  const socket = new FakeInspectorSocket();
  const client = new InspectorProtocolClient(socket.asWebSocket());

  const enable = client.Console.enable();
  socket.close();

  await assertRejects(
    () => enable,
    Error,
    "Inspector WebSocket closed",
  );
});

Deno.test("InspectorProtocolClient rejects commands when an earlier close listener closes the client", async () => {
  const socket = new FakeInspectorSocket();
  let closeFromListener: Promise<void> | undefined;
  socket.addEventListener("close", () => {
    closeFromListener = client.close();
  });
  const client = new InspectorProtocolClient(socket.asWebSocket());

  const enable = client.Console.enable();
  const rejected = assertRejects(
    () => enable,
    Error,
    "Inspector WebSocket closed",
  );
  socket.close();

  await closeFromListener;
  await rejected;
});

Deno.test("InspectorProtocolClient closes its WebSocket", async () => {
  const socket = new FakeInspectorSocket();
  const client = new InspectorProtocolClient(socket.asWebSocket());

  await client.close();

  assertEquals(socket.readyState, WebSocket.CLOSED);
});

Deno.test("InspectorProtocolClient rejects when WebSocket close reports an error", async () => {
  const socket = new FakeInspectorSocket();
  const closeError = new ErrorEvent("error", {
    message: "close failed",
  });
  socket.closeError = closeError;
  const client = new InspectorProtocolClient(socket.asWebSocket());

  const settled = client.close().then(
    () => ({ status: "fulfilled" as const }),
    (reason) => ({ status: "rejected" as const, reason }),
  );

  const result = await settled;
  assert(result.status === "rejected");
  assertStrictEquals(result.reason, closeError);

  socket.closeError = undefined;
  await client.close();
});

Deno.test("InspectorProtocolClient close is idempotent", async () => {
  const socket = new FakeInspectorSocket();
  const client = new InspectorProtocolClient(socket.asWebSocket());

  await client.close();
  await client.close();

  assertEquals(socket.closeCalls, 1);
});
