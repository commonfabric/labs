import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";

import { type FabricValue, hashOf } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type SessionOpenChallenge,
} from "@commonfabric/memory/v2";
import { type JSONSchema, Runtime } from "@commonfabric/runner";
import { resolvedSchema } from "../../../../runner/test/schema-ref-helpers.ts";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { defer } from "@commonfabric/utils/defer";

import app from "@/app.ts";
import { memoryServer } from "@/routes/storage/memory.ts";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

type HelloOkWithSessionOpen = {
  type: "hello.ok";
  protocol: string;
  flags: ReturnType<typeof getMemoryProtocolFlags>;
  sessionOpen: {
    audience: string;
    challenge: SessionOpenChallenge;
  };
};

const openSocket = async (url: URL): Promise<WebSocket> => {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", (event) => reject(event), { once: true });
  });
  return socket;
};

const createSessionOpenAuth = async (
  identity: Identity,
  space: string,
  session: { sessionId?: string; seenSeq?: number } = {},
  sessionOpen: {
    audience?: string;
    challenge?: SessionOpenChallenge;
  },
  overrides: {
    audience?: string | null;
    challenge?: string | null;
  } = {},
) => {
  const iat = Math.floor(Date.now() / 1000);
  const audience = overrides.audience ?? sessionOpen.audience;
  const challenge = overrides.challenge ?? sessionOpen.challenge?.value;
  const invocation = {
    iss: identity.did(),
    cmd: "session.open",
    sub: space,
    ...(overrides.audience === null || audience === undefined ? {} : {
      aud: audience,
    }),
    args: {
      protocol: MEMORY_PROTOCOL,
      session,
    },
    ...(overrides.challenge === null || challenge === undefined ? {} : {
      challenge,
    }),
    iat,
    exp: iat + 300,
  };
  const signature = await identity.sign(hashOf(invocation).bytes);
  if (signature.error) {
    throw signature.error;
  }
  return {
    invocation,
    // Mirror the production producer (`v2-remote-session.ts`): send the
    // signature as a `FabricBytes`.
    authorization: {
      signature: new FabricBytes(signature.ok),
    },
  };
};

const readJsonMessage = async <Message extends FabricValue>(
  socket: WebSocket,
): Promise<Message> => {
  const payload = await new Promise<string>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        reject(new Error("Expected a string websocket message"));
        return;
      }
      resolve(event.data);
    }, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("WebSocket error before message")),
      { once: true },
    );
  });

  return decodeMemoryBoundary<Message>(payload);
};

const createRuntime = (identity: Identity, base: URL) =>
  new Runtime({
    apiUrl: base,
    storageManager: StorageManager.open({
      as: identity,
      memoryHost: new URL(base),
    }),
  });

let routeTestQueue = Promise.resolve();

const serialTest = (
  name: string,
  fn: () => Promise<void>,
) =>
  Deno.test(name, async () => {
    const previous = routeTestQueue;
    const current = Promise.withResolvers<void>();
    routeTestQueue = current.promise;
    await previous;
    try {
      await fn();
    } finally {
      // The toolshed `memoryServer` is a module-level singleton. Its
      // `#refreshTimer` (armed when sessions write into dirty spaces) is
      // not cancelled by per-test `Deno.serve().shutdown()`. Drain it
      // here so the timer doesn't survive into a later test, where
      // Deno's leak sanitizer would flag it as either "started in this
      // test, but never completed" (timer still pending at test end) or
      // "started before the test, but completed during the test" (timer
      // from a prior test fires inside this one).
      await memoryServer.idle();
      current.resolve();
    }
  });

serialTest(
  "memory websocket admits the creator of a created space and refuses another identity",
  async () => {
    const creator = await Identity.generate({ implementation: "noble" });
    const stranger = await Identity.generate({ implementation: "noble" });
    const server = Deno.serve({ port: 0 }, app.fetch);
    const base = new URL(`http://${server.addr.hostname}:${server.addr.port}`);
    const runtime = createRuntime(creator, base);
    let socket: WebSocket | undefined;

    try {
      const space = await runtime.createSpace();
      const tx = runtime.edit();
      const cell = runtime.getCell(
        space,
        `memory-created-space-cell-${Date.now()}`,
        undefined,
        tx,
      );
      cell.set({ hello: "created" });

      const result = await tx.commit();
      assert("ok" in result);

      await runtime.storageManager.synced();
      const provider = runtime.storageManager.open(space);
      assertEquals(
        provider.replica.get({
          id: cell.getAsNormalizedFullLink().id,
          type: "application/json",
        })?.is,
        { value: { hello: "created" } },
      );

      // The space's genesis grants its creator alone, so a signed session
      // open from anyone else is refused.
      socket = await openSocket(
        new URL(
          `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
        ),
      );
      socket.send(encodeMemoryBoundary(HELLO));
      const hello = await readJsonMessage<HelloOkWithSessionOpen>(socket);
      socket.send(encodeMemoryBoundary({
        type: "session.open",
        requestId: "open-1",
        space,
        session: {},
        ...(await createSessionOpenAuth(
          stranger,
          space,
          {},
          hello.sessionOpen,
        )),
      }));
      const refusal = await readJsonMessage<{
        type: "response";
        requestId: string;
        error: { name: string; message: string };
      }>(socket);
      assertEquals(refusal.requestId, "open-1");
      assertEquals(refusal.error?.name, "AuthorizationError");
    } finally {
      socket?.close();
      await runtime.dispose();
      await runtime.storageManager.close();
      await server.shutdown();
    }
  },
);

serialTest(
  "memory websocket supports a runtime using the memory path",
  async () => {
    const identity = await Identity.fromPassphrase("memory-route-traffic");
    const server = Deno.serve({ port: 0 }, app.fetch);
    const base = new URL(
      `http://${server.addr.hostname}:${server.addr.port}`,
    );
    let runtime: Runtime | undefined;
    let storageManager:
      | ReturnType<typeof StorageManager.open>
      | undefined;

    try {
      storageManager = StorageManager.open({
        as: identity,
        memoryHost: base,
      });
      runtime = new Runtime({
        apiUrl: base,
        storageManager,
      });
      const tx = runtime.edit();
      const cell = runtime.getCell(
        identity.did(),
        `memory-toolshed-${Date.now()}`,
        undefined,
        tx,
      );

      cell.set({ hello: "world" });
      await tx.commit();
      await runtime.idle();
      await storageManager.synced();

      const provider = storageManager.open(identity.did());
      await provider.sync(cell.getAsNormalizedFullLink().id);
      const persisted = provider.replica.get({
        id: cell.getAsNormalizedFullLink().id,
        type: "application/json",
      });

      assertEquals(persisted?.is, { value: { hello: "world" } });
    } finally {
      await runtime?.dispose();
      await server.shutdown();
    }
  },
);

serialTest(
  "memory websocket persists memory runtime data across fresh runtimes",
  async () => {
    const identity = await Identity.fromPassphrase("memory-route-persist");
    const server = Deno.serve({ port: 0 }, app.fetch);
    const base = new URL(`http://${server.addr.hostname}:${server.addr.port}`);
    const cause = `memory-toolshed-persist-${Date.now()}`;
    let runtime1: Runtime | undefined;
    let runtime2: Runtime | undefined;

    try {
      runtime1 = new Runtime({
        apiUrl: base,
        storageManager: StorageManager.open({
          as: identity,
          memoryHost: base,
        }),
      });
      const tx = runtime1.edit();
      const writer = runtime1.getCell(identity.did(), cause, undefined, tx);
      writer.set({ persisted: true, count: 1 });
      await tx.commit();
      await runtime1.idle();
      await runtime1.storageManager.synced();
      await runtime1.dispose();
      runtime1 = undefined;

      runtime2 = new Runtime({
        apiUrl: base,
        storageManager: StorageManager.open({
          as: identity,
          memoryHost: base,
        }),
      });
      const reader = runtime2.getCell(identity.did(), cause);
      await reader.sync();
      await runtime2.storageManager.synced();

      assertEquals(reader.get(), { persisted: true, count: 1 });
    } finally {
      await runtime2?.dispose();
      await runtime1?.dispose();
      await server.shutdown();
    }
  },
);

serialTest("memory websocket negotiates a session", async () => {
  const identity = await Identity.fromPassphrase("memory-route-open-auth");
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );
  const space = identity.did();

  try {
    const socket = await openSocket(address);
    socket.send(encodeMemoryBoundary(HELLO));

    const message = await readJsonMessage<HelloOkWithSessionOpen>(socket);

    assertEquals(message.type, "hello.ok");
    assertEquals(message.protocol, MEMORY_PROTOCOL);
    assertEquals(message.flags, getMemoryProtocolFlags());
    assert(message.sessionOpen.audience.length > 0);
    assert(message.sessionOpen.challenge.value.length > 0);

    const auth = await createSessionOpenAuth(
      identity,
      space,
      {},
      message.sessionOpen,
    );
    socket.send(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      ...auth,
    }));

    const opened = await readJsonMessage<{
      type: "response";
      requestId: string;
      ok: { sessionId: string; serverSeq: number };
    }>(socket);

    assertEquals(opened.type, "response");
    assertEquals(opened.requestId, "open-1");
    assertEquals(opened.ok.serverSeq, 0);
    assert(opened.ok.sessionId.length > 0);

    socket.close();
  } finally {
    await server.shutdown();
  }
});

serialTest("memory websocket rejects an unsigned session open", async () => {
  const identity = await Identity.fromPassphrase("memory-route-open-reject");
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );
  let socket: WebSocket | undefined;

  try {
    socket = await openSocket(address);
    socket.send(encodeMemoryBoundary(HELLO));
    await readJsonMessage(socket);

    socket.send(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space: identity.did(),
      session: {},
    }));

    const message = await readJsonMessage<{
      type: "response";
      requestId: string;
      error: { name: string; message: string };
    }>(socket);

    assertEquals(message.type, "response");
    assertEquals(message.requestId, "open-1");
    assertEquals(message.error.name, "AuthorizationError");
  } finally {
    socket?.close();
    await server.shutdown();
  }
});

serialTest("memory websocket rejects a missing challenge", async () => {
  const identity = await Identity.fromPassphrase(
    "memory-route-missing-challenge",
  );
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );
  let socket: WebSocket | undefined;

  try {
    socket = await openSocket(address);
    socket.send(encodeMemoryBoundary(HELLO));
    const hello = await readJsonMessage<HelloOkWithSessionOpen>(socket);
    const auth = await createSessionOpenAuth(
      identity,
      identity.did(),
      {},
      hello.sessionOpen,
      { challenge: null },
    );

    socket.send(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space: identity.did(),
      session: {},
      ...auth,
    }));

    const message = await readJsonMessage<{
      type: "response";
      requestId: string;
      error: { name: string; message: string };
    }>(socket);
    assertEquals(message.requestId, "open-1");
    assertEquals(message.error.name, "AuthorizationError");
    assert(message.error.message.includes("challenge"));
  } finally {
    socket?.close();
    await server.shutdown();
  }
});

serialTest("memory websocket rejects a mismatched challenge", async () => {
  const identity = await Identity.fromPassphrase(
    "memory-route-wrong-challenge",
  );
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );
  let socket: WebSocket | undefined;

  try {
    socket = await openSocket(address);
    socket.send(encodeMemoryBoundary(HELLO));
    const hello = await readJsonMessage<HelloOkWithSessionOpen>(socket);
    const auth = await createSessionOpenAuth(
      identity,
      identity.did(),
      {},
      hello.sessionOpen,
      { challenge: "challenge:wrong" },
    );

    socket.send(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space: identity.did(),
      session: {},
      ...auth,
    }));

    const message = await readJsonMessage<{
      type: "response";
      requestId: string;
      error: { name: string; message: string };
    }>(socket);
    assertEquals(message.requestId, "open-1");
    assertEquals(message.error.name, "AuthorizationError");
    assert(message.error.message.includes("challenge"));
  } finally {
    socket?.close();
    await server.shutdown();
  }
});

serialTest("memory websocket rejects a missing audience", async () => {
  const identity = await Identity.fromPassphrase(
    "memory-route-missing-audience",
  );
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );
  let socket: WebSocket | undefined;

  try {
    socket = await openSocket(address);
    socket.send(encodeMemoryBoundary(HELLO));
    const hello = await readJsonMessage<HelloOkWithSessionOpen>(socket);
    const auth = await createSessionOpenAuth(
      identity,
      identity.did(),
      {},
      hello.sessionOpen,
      { audience: null },
    );

    socket.send(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space: identity.did(),
      session: {},
      ...auth,
    }));

    const message = await readJsonMessage<{
      type: "response";
      requestId: string;
      error: { name: string; message: string };
    }>(socket);
    assertEquals(message.requestId, "open-1");
    assertEquals(message.error.name, "AuthorizationError");
    assert(message.error.message.includes("audience"));
  } finally {
    socket?.close();
    await server.shutdown();
  }
});

serialTest("memory websocket rejects a mismatched audience", async () => {
  const identity = await Identity.fromPassphrase("memory-route-wrong-audience");
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );
  let socket: WebSocket | undefined;

  try {
    socket = await openSocket(address);
    socket.send(encodeMemoryBoundary(HELLO));
    const hello = await readJsonMessage<HelloOkWithSessionOpen>(socket);
    const auth = await createSessionOpenAuth(
      identity,
      identity.did(),
      {},
      hello.sessionOpen,
      { audience: "did:key:z6Mk-memory-route-wrong-audience" },
    );

    socket.send(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space: identity.did(),
      session: {},
      ...auth,
    }));

    const message = await readJsonMessage<{
      type: "response";
      requestId: string;
      error: { name: string; message: string };
    }>(socket);
    assertEquals(message.requestId, "open-1");
    assertEquals(message.error.name, "AuthorizationError");
    assert(message.error.message.includes("audience"));
  } finally {
    socket?.close();
    await server.shutdown();
  }
});

serialTest("memory websocket rejects a reused challenge", async () => {
  const identity = await Identity.fromPassphrase("memory-route-reused");
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );
  let socket: WebSocket | undefined;

  try {
    socket = await openSocket(address);
    socket.send(encodeMemoryBoundary(HELLO));
    const hello = await readJsonMessage<HelloOkWithSessionOpen>(socket);
    const auth = await createSessionOpenAuth(
      identity,
      identity.did(),
      {},
      hello.sessionOpen,
    );

    socket.send(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space: identity.did(),
      session: {},
      ...auth,
    }));
    const opened = await readJsonMessage<{
      type: "response";
      requestId: string;
      ok: { sessionId: string; serverSeq: number };
    }>(socket);
    assertEquals(opened.requestId, "open-1");
    assert(opened.ok.sessionId.length > 0);

    socket.send(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-2",
      space: identity.did(),
      session: {},
      ...auth,
    }));
    const replay = await readJsonMessage<{
      type: "response";
      requestId: string;
      error: { name: string; message: string };
    }>(socket);
    assertEquals(replay.requestId, "open-2");
    assertEquals(replay.error.name, "AuthorizationError");
    assert(replay.error.message.includes("challenge"));
  } finally {
    socket?.close();
    await server.shutdown();
  }
});

serialTest("memory websocket resumes a requested session id", async () => {
  const identity = await Identity.fromPassphrase("memory-route-resume-auth");
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );
  const space = identity.did();

  try {
    const socket = await openSocket(address);
    socket.send(encodeMemoryBoundary(HELLO));

    const hello = await readJsonMessage<HelloOkWithSessionOpen>(socket);

    const auth = await createSessionOpenAuth(identity, space, {
      sessionId: "session:test-resume",
      seenSeq: 7,
    }, hello.sessionOpen);
    socket.send(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {
        sessionId: "session:test-resume",
        seenSeq: 7,
      },
      ...auth,
    }));

    const message = await readJsonMessage<{
      type: "response";
      requestId: string;
      ok: { sessionId: string; serverSeq: number };
    }>(socket);

    assertEquals(message.type, "response");
    assertEquals(message.requestId, "open-1");
    assertEquals(message.ok.sessionId, "session:test-resume");
    assertEquals(message.ok.serverSeq, 0);

    socket.close();
  } finally {
    await server.shutdown();
  }
});

serialTest(
  "memory websocket requires hello before opening a session",
  async () => {
    const server = Deno.serve({ port: 0 }, app.fetch);
    const address = new URL(
      `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
    );

    try {
      const socket = await openSocket(address);
      socket.send(encodeMemoryBoundary({
        type: "session.open",
        requestId: "open-without-hello",
        space: "did:key:z6Mk-toolshed-no-hello",
        session: {},
      }));

      const message = await readJsonMessage<{
        type: "response";
        requestId: string;
        error: { name: string; message: string };
      }>(socket);

      assertEquals(message.type, "response");
      assertEquals(message.requestId, "handshake");
      assertEquals(message.error.name, "ProtocolError");

      socket.close();
    } finally {
      await server.shutdown();
    }
  },
);

serialTest(
  "memory websocket discovers newly linked documents for a subscribed memory runtime",
  async () => {
    const identity = await Identity.fromPassphrase(
      `memory-new-link-${Date.now()}`,
    );
    const server = Deno.serve({ port: 0 }, app.fetch);
    const base = new URL(`http://${server.addr.hostname}:${server.addr.port}`);
    const space = identity.did();

    const addressSchema = {
      type: "object",
      properties: {
        city: { type: "string" },
      },
      required: ["city"],
    } as const satisfies JSONSchema;

    const personSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        address: addressSchema,
      },
      required: ["name"],
    } as const satisfies JSONSchema;

    try {
      const runtime1 = createRuntime(identity, base);
      let tx = runtime1.edit();
      const addressCell = runtime1.getCell(
        space,
        "memory-link-address",
        addressSchema,
        tx,
      );
      addressCell.set({ city: "San Francisco" });
      await tx.commit();

      tx = runtime1.edit();
      const personCell = runtime1.getCell(
        space,
        "memory-link-person",
        personSchema,
        tx,
      );
      personCell.set({ name: "Alice" });
      await tx.commit();
      await runtime1.storageManager.synced();
      const addressLink = structuredClone(addressCell.getAsLink());
      await runtime1.dispose();

      const runtime2 = createRuntime(identity, base);
      const personCell2 = runtime2.getCell(
        space,
        "memory-link-person",
        personSchema,
      );
      await personCell2.sync();
      await runtime2.storageManager.synced();
      assertEquals(personCell2.get()?.address, undefined);

      const gotAddress = defer<void>();
      personCell2.sink((value) => {
        if (value?.address?.city === "San Francisco") {
          gotAddress.resolve();
        }
      });

      const runtime3 = createRuntime(identity, base);
      const personCell3 = runtime3.getCell(
        space,
        "memory-link-person",
        personSchema,
      );
      await personCell3.sync();
      tx = runtime3.edit();
      personCell3.withTx(tx).setRawUntyped({
        name: "Alice",
        address: runtime3.acquireExternalInput(space, addressLink),
      });
      assertEquals((await tx.commit()).error, undefined);
      await runtime3.storageManager.synced();

      await gotAddress.promise;
      assertEquals(personCell2.get(), {
        name: "Alice",
        address: { city: "San Francisco" },
      });

      await runtime3.dispose();
      await runtime2.dispose();
    } finally {
      await server.shutdown();
    }
  },
);

serialTest(
  "memory websocket propagates linked document changes to a subscribed memory runtime",
  async () => {
    const identity = await Identity.fromPassphrase(
      `memory-linked-update-${Date.now()}`,
    );
    const server = Deno.serve({ port: 0 }, app.fetch);
    const base = new URL(`http://${server.addr.hostname}:${server.addr.port}`);
    const space = identity.did();

    const addressSchema = {
      type: "object",
      properties: {
        city: { type: "string" },
      },
      required: ["city"],
    } as const satisfies JSONSchema;

    const personSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        address: addressSchema,
      },
      required: ["name", "address"],
    } as const satisfies JSONSchema;

    try {
      const runtime1 = createRuntime(identity, base);
      let tx = runtime1.edit();
      const addressCell = runtime1.getCell(
        space,
        "memory-linked-address",
        addressSchema,
        tx,
      );
      addressCell.set({ city: "New York" });
      expect((await tx.commit()).error).toBeUndefined();
      await addressCell.sync();
      await runtime1.storageManager.synced();
      const addressLink = structuredClone(addressCell.getAsLink());

      tx = runtime1.edit();
      const personCell = runtime1.getCell(
        space,
        "memory-linked-person",
        personSchema,
        tx,
      );
      personCell.setRawUntyped({
        name: "Bob",
        address: runtime1.acquireExternalInput(space, addressLink),
      });
      expect((await tx.commit()).error).toBeUndefined();
      await runtime1.storageManager.synced();
      await runtime1.dispose();

      const runtime2 = createRuntime(identity, base);
      const personCell2 = runtime2.getCell(
        space,
        "memory-linked-person",
        personSchema,
      );
      await personCell2.sync();
      await runtime2.storageManager.synced();
      assertEquals(personCell2.get(), {
        name: "Bob",
        address: { city: "New York" },
      });

      const gotNewCity = defer<void>();
      personCell2.sink((value) => {
        if (value?.address?.city === "Los Angeles") {
          gotNewCity.resolve();
        }
      });

      const runtime3 = createRuntime(identity, base);
      const addressCell3 = runtime3.getCell(
        space,
        "memory-linked-address",
        addressSchema,
      );
      await addressCell3.sync();
      tx = runtime3.edit();
      addressCell3.withTx(tx).set({ city: "Los Angeles" });
      expect((await tx.commit()).error).toBeUndefined();
      await runtime3.storageManager.synced();

      await gotNewCity.promise;
      assertEquals(personCell2.get(), {
        name: "Bob",
        address: { city: "Los Angeles" },
      });

      await runtime3.dispose();
      await runtime2.dispose();
    } finally {
      await server.shutdown();
    }
  },
);

serialTest(
  "memory websocket keeps deep linked chains live for a subscribed memory runtime",
  async () => {
    const identity = await Identity.fromPassphrase(
      `memory-deep-link-${Date.now()}`,
    );
    const server = Deno.serve({ port: 0 }, app.fetch);
    const base = new URL(`http://${server.addr.hostname}:${server.addr.port}`);
    const space = identity.did();

    const citySchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        population: { type: "number" },
      },
      required: ["name"],
    } as const satisfies JSONSchema;

    const addressSchema = {
      type: "object",
      properties: {
        street: { type: "string" },
        city: citySchema,
      },
      required: ["street", "city"],
    } as const satisfies JSONSchema;

    const personSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        address: addressSchema,
      },
      required: ["name", "address"],
    } as const satisfies JSONSchema;

    try {
      const runtime1 = createRuntime(identity, base);
      let tx = runtime1.edit();
      const cityCell = runtime1.getCell(
        space,
        "memory-deep-city",
        citySchema,
        tx,
      );
      cityCell.set({ name: "Seattle", population: 750000 });
      expect((await tx.commit()).error).toBeUndefined();
      await cityCell.sync();
      await runtime1.storageManager.synced();
      const cityLink = structuredClone(cityCell.getAsLink());

      tx = runtime1.edit();
      const addressCell = runtime1.getCell(
        space,
        "memory-deep-address",
        addressSchema,
        tx,
      );
      addressCell.setRawUntyped({
        street: "123 Main St",
        city: runtime1.acquireExternalInput(space, cityLink),
      });
      expect((await tx.commit()).error).toBeUndefined();
      await addressCell.sync();
      await runtime1.storageManager.synced();
      const addressLink = structuredClone(addressCell.getAsLink());

      tx = runtime1.edit();
      const personCell = runtime1.getCell(
        space,
        "memory-deep-person",
        personSchema,
        tx,
      );
      personCell.setRawUntyped({
        name: "Charlie",
        address: runtime1.acquireExternalInput(space, addressLink),
      });
      expect((await tx.commit()).error).toBeUndefined();
      await runtime1.storageManager.synced();
      await runtime1.dispose();

      const runtime2 = createRuntime(identity, base);
      const personCell2 = runtime2.getCell(
        space,
        "memory-deep-person",
        personSchema,
      );
      await personCell2.sync();
      await runtime2.storageManager.synced();
      assertEquals(personCell2.get(), {
        name: "Charlie",
        address: {
          street: "123 Main St",
          city: { name: "Seattle", population: 750000 },
        },
      });

      const gotPopulation = defer<void>();
      personCell2.sink((value) => {
        if (value?.address?.city?.population === 800000) {
          gotPopulation.resolve();
        }
      });

      const runtime3 = createRuntime(identity, base);
      const cityCell3 = runtime3.getCell(space, "memory-deep-city", citySchema);
      await cityCell3.sync();
      tx = runtime3.edit();
      cityCell3.withTx(tx).set({ name: "Seattle", population: 800000 });
      expect((await tx.commit()).error).toBeUndefined();
      await runtime3.storageManager.synced();

      await gotPopulation.promise;
      assertEquals(personCell2.get(), {
        name: "Charlie",
        address: {
          street: "123 Main St",
          city: { name: "Seattle", population: 800000 },
        },
      });

      await runtime3.dispose();
      await runtime2.dispose();
    } finally {
      await server.shutdown();
    }
  },
);

serialTest(
  "memory websocket re-establishes subscribed memory runtimes after server restart",
  async () => {
    const identity = await Identity.fromPassphrase(
      `memory-reconnect-runtime-${Date.now()}`,
    );
    let server = Deno.serve({ port: 0 }, app.fetch);
    const port = server.addr.port;
    const base = new URL(`http://${server.addr.hostname}:${port}`);
    const space = identity.did();

    const counterSchema = {
      type: "object",
      properties: {
        count: { type: "number" },
      },
      required: ["count"],
    } as const satisfies JSONSchema;

    try {
      const runtime1 = createRuntime(identity, base);
      let tx = runtime1.edit();
      const writer = runtime1.getCell(
        space,
        "memory-reconnect-counter",
        counterSchema,
        tx,
      );
      writer.set({ count: 1 });
      await tx.commit();
      await runtime1.storageManager.synced();
      await runtime1.dispose();

      const subscriberRuntime = createRuntime(identity, base);
      const counterCell = subscriberRuntime.getCell(
        space,
        "memory-reconnect-counter",
        counterSchema,
      );
      await counterCell.sync();
      await subscriberRuntime.storageManager.synced();
      assertEquals(counterCell.get(), { count: 1 });

      const gotReconnectUpdate = defer<void>();
      counterCell.sink((value) => {
        if (value?.count === 2) {
          gotReconnectUpdate.resolve();
        }
      });

      await server.shutdown();
      server = Deno.serve({ port }, app.fetch);

      const runtime2 = createRuntime(identity, base);
      const counterWriter = runtime2.getCell(
        space,
        "memory-reconnect-counter",
        counterSchema,
      );
      await counterWriter.sync();
      tx = runtime2.edit();
      counterWriter.withTx(tx).set({ count: 2 });
      await tx.commit();
      await runtime2.storageManager.synced();

      await gotReconnectUpdate.promise;
      assertEquals(counterCell.get(), { count: 2 });

      await runtime2.dispose();
      await subscriberRuntime.dispose();
    } finally {
      await server.shutdown();
    }
  },
);

serialTest(
  "memory websocket round-trips alias schema metadata through synced memory runtimes",
  async () => {
    const identity = await Identity.fromPassphrase(
      `memory-alias-schema-${Date.now()}`,
    );
    const server = Deno.serve({ port: 0 }, app.fetch);
    const base = new URL(`http://${server.addr.hostname}:${server.addr.port}`);
    const space = identity.did();

    const schema = {
      type: "object",
      properties: {
        count: { type: "number" },
        label: { type: "string" },
      },
    } as const satisfies JSONSchema;

    try {
      const runtime1 = createRuntime(identity, base);
      const tx = runtime1.edit();
      const targetCell = runtime1.getCell(
        space,
        "memory-alias-schema-target",
        undefined,
        tx,
      );
      targetCell.set({ count: 42, label: "test" });

      const aliasCell = runtime1.getCell(
        space,
        "memory-alias-schema-source",
        undefined,
        tx,
      );
      aliasCell.setRaw(
        targetCell.asSchema(schema).getAsWriteRedirectLink({
          includeSchema: true,
        }),
      );
      await tx.commit();
      await runtime1.storageManager.synced();
      await runtime1.dispose();

      const runtime2 = createRuntime(identity, base);
      const aliasCell2 = runtime2.getCell<{ count: number; label: string }>(
        space,
        "memory-alias-schema-source",
      );
      await aliasCell2.sync();
      await runtime2.storageManager.synced();
      assertEquals(resolvedSchema(aliasCell2.schema), schema);
      assertEquals(aliasCell2.key("count").schema, { type: "number" });
      assertEquals(aliasCell2.get(), { count: 42, label: "test" });

      await runtime2.dispose();
    } finally {
      await server.shutdown();
    }
  },
);

serialTest(
  "memory websocket preserves alias-derived schemas after reconnect",
  async () => {
    const identity = await Identity.fromPassphrase(
      `memory-alias-reconnect-${Date.now()}`,
    );
    let server = Deno.serve({ port: 0 }, app.fetch);
    const port = server.addr.port;
    const base = new URL(`http://${server.addr.hostname}:${port}`);
    const space = identity.did();

    const schema = {
      type: "object",
      properties: {
        count: { type: "number" },
        label: { type: "string" },
      },
    } as const satisfies JSONSchema;

    try {
      const runtime1 = createRuntime(identity, base);
      let tx = runtime1.edit();
      const targetCell = runtime1.getCell(
        space,
        "memory-alias-reconnect-target",
        undefined,
        tx,
      );
      targetCell.set({ count: 1, label: "start" });
      const aliasCell = runtime1.getCell(
        space,
        "memory-alias-reconnect-source",
        undefined,
        tx,
      );
      aliasCell.setRaw(
        targetCell.asSchema(schema).getAsWriteRedirectLink({
          includeSchema: true,
        }),
      );
      await tx.commit();
      await runtime1.storageManager.synced();
      await runtime1.dispose();

      const subscriberRuntime = createRuntime(identity, base);
      const aliasCell2 = subscriberRuntime.getCell<
        { count: number; label: string }
      >(
        space,
        "memory-alias-reconnect-source",
      );
      await aliasCell2.sync();
      await subscriberRuntime.storageManager.synced();
      assertEquals(resolvedSchema(aliasCell2.schema), schema);
      assertEquals(aliasCell2.get(), { count: 1, label: "start" });

      const gotUpdate = defer<void>();
      aliasCell2.sink((value) => {
        if (value?.count === 2 && value?.label === "after-restart") {
          gotUpdate.resolve();
        }
      });

      await server.shutdown();
      server = Deno.serve({ port }, app.fetch);

      const runtime2 = createRuntime(identity, base);
      const targetCell2 = runtime2.getCell(
        space,
        "memory-alias-reconnect-target",
      );
      await targetCell2.sync();
      tx = runtime2.edit();
      targetCell2.withTx(tx).set({ count: 2, label: "after-restart" });
      await tx.commit();
      await runtime2.storageManager.synced();

      await gotUpdate.promise;
      assertEquals(resolvedSchema(aliasCell2.schema), schema);
      assertEquals(aliasCell2.key("count").schema, { type: "number" });
      assertEquals(aliasCell2.get(), { count: 2, label: "after-restart" });

      await runtime2.dispose();
      await subscriberRuntime.dispose();
    } finally {
      await server.shutdown();
    }
  },
);

serialTest(
  "memory websocket keeps retargeted aliases live for subscribed memory runtimes",
  async () => {
    const identity = await Identity.fromPassphrase(
      `memory-alias-retarget-${Date.now()}`,
    );
    const server = Deno.serve({ port: 0 }, app.fetch);
    const base = new URL(`http://${server.addr.hostname}:${server.addr.port}`);
    const space = identity.did();

    const schema = {
      type: "object",
      properties: {
        count: { type: "number" },
        label: { type: "string" },
      },
    } as const satisfies JSONSchema;

    try {
      const runtime1 = createRuntime(identity, base);
      let tx = runtime1.edit();
      const firstTarget = runtime1.getCell(
        space,
        "memory-alias-retarget-first",
        undefined,
        tx,
      );
      firstTarget.set({ count: 1, label: "first" });
      const secondTarget = runtime1.getCell(
        space,
        "memory-alias-retarget-second",
        undefined,
        tx,
      );
      secondTarget.set({ count: 2, label: "second" });
      const aliasCell = runtime1.getCell(
        space,
        "memory-alias-retarget-source",
        undefined,
        tx,
      );
      aliasCell.setRaw(
        firstTarget.asSchema(schema).getAsWriteRedirectLink({
          includeSchema: true,
        }),
      );
      await tx.commit();
      await runtime1.storageManager.synced();

      const subscriberRuntime = createRuntime(identity, base);
      const aliasCell2 = subscriberRuntime.getCell<
        { count: number; label: string }
      >(
        space,
        "memory-alias-retarget-source",
      );
      await aliasCell2.sync();
      await subscriberRuntime.storageManager.synced();
      assertEquals(aliasCell2.get(), { count: 1, label: "first" });

      const gotRetarget = defer<void>();
      aliasCell2.sink((value) => {
        if (value?.count === 2 && value?.label === "second") {
          gotRetarget.resolve();
        }
      });

      tx = runtime1.edit();
      aliasCell.withTx(tx).setRaw(
        secondTarget.asSchema(schema).getAsWriteRedirectLink({
          includeSchema: true,
        }),
      );
      await tx.commit();
      await runtime1.storageManager.synced();

      await gotRetarget.promise;
      assertEquals(resolvedSchema(aliasCell2.schema), schema);
      assertEquals(aliasCell2.get(), { count: 2, label: "second" });

      await subscriberRuntime.dispose();
      await runtime1.dispose();
    } finally {
      await server.shutdown();
    }
  },
);

// Registered last so it runs after every case above. Per-test `idle()` only
// drains the singleton's refresh timer; its SQLite engine handles and read-pool
// connections stay open until `close()`. Deno isolates each test file's module
// graph, so this instance is owned by this file alone. Closing it here releases
// those handles.
serialTest("memory websocket server releases its resources", async () => {
  await memoryServer.close();
});
