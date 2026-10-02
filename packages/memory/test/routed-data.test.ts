/** Real toolshed authority behind an in-process framed router peer. */
// @ts-types="@types/ws"
import WebSocket from "ws";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { sha256 } from "@commonfabric/content-hash";
import { setModernCellRepConfig } from "@commonfabric/data-model/cell-rep";
import type { MemorySpace } from "../interface.ts";
import {
  getMemoryProtocolFlags,
  resetServerExecutionConfig,
  setServerExecutionConfig,
} from "../v2.ts";
import { connect, type Transport } from "../v2/client.ts";
import * as Engine from "../v2/engine.ts";
import { RoutedEpochStore } from "../v2/routed-epochs.ts";
import { RoutedMemoryHost } from "../v2/routed-host.ts";
import { listenRoutedMemory } from "../v2/routed-listener.ts";
import {
  decodeRoutedFrame,
  encodeRoutedFrame,
  routedFlags,
} from "../v2/routed-parser.ts";
import {
  routedBase64,
  routedHex,
  RoutedReader,
  routedStatementPayload,
  RoutedWriter,
} from "../v2/routed-wire.ts";
import { Server } from "../v2/server.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";

class FramedSocket extends EventTarget {
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  output: (string | Uint8Array)[] = [];
  changed = Promise.withResolvers<void>();
  closed = Promise.withResolvers<void>();
  send(bytes: string | Uint8Array) {
    this.output.push(bytes);
    this.changed.resolve();
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.changed.resolve();
    this.closed.resolve();
    this.dispatchEvent(new Event("close"));
  }
  receive(bytes: string | Uint8Array) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: typeof bytes === "string" ? bytes : bytes.slice().buffer,
      }),
    );
  }
  async take(): Promise<string | Uint8Array> {
    while (!this.output.length) {
      assertEquals(this.readyState, 1);
      this.changed = Promise.withResolvers<void>();
      await this.changed.promise;
    }
    return this.output.shift()!;
  }
  async bytes(): Promise<Uint8Array> {
    const bytes = await this.take();
    assert(bytes instanceof Uint8Array);
    return bytes;
  }
}

async function fixture(name: string) {
  setModernCellRepConfig(true);
  const root = Deno.makeTempDirSync({ prefix: `routed-data-${name}-` });
  const [space, principal, outsider, toolshed, router] = await Promise.all(
    [121, 122, 123, 124, 125].map((n) =>
      Identity.fromRaw(new Uint8Array(32).fill(n))
    ),
  );
  const store = toFileUrl(`${root}/store/`);
  Deno.mkdirSync(`${root}/store/engine-v3`, { recursive: true });
  const engine = await Engine.open({
    url: resolveSpaceStoreUrl(store, space.did() as MemorySpace),
  });
  Engine.applyCommit(engine, {
    sessionId: "seed",
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${space.did()}`,
        value: {
          value: { [principal.did()]: "OWNER" },
        },
      }],
    },
  });
  Engine.close(engine);
  let ownership = 1;
  const now = Math.floor(Date.now() / 1000);
  const server = new Server({
    store,
    acl: { mode: "enforce" },
    requireExplicitAcl: true,
    ownsSpace: (did) => did === space.did() && ownership > 0,
    authorizeSessionOpen: () => undefined,
    sessionOpenAuth: { audience: toolshed.did() },
    subscriptionRefreshDelayMs: "manual",
  });
  const epochs = new RoutedEpochStore(`${root}/ledger`);
  const host = new RoutedMemoryHost({
    server,
    identity: toolshed,
    deployment: "fixture",
    epochs,
    ownership: (did) =>
      did === space.did() && ownership > 0 ? ownership : undefined,
    routers: new Map([[router.did(), new Set(["127.0.0.1"])]]),
  });
  const flagObject = {
    ...server.memoryProtocolFlags(),
    connectionAuth: true,
    routedAuthV1: true,
  };
  const flags = routedFlags(flagObject);
  const epoch = new Uint8Array(16).fill(11),
    context = new Uint8Array(16).fill(12);
  const link = new FramedSocket();
  host.accept(link as unknown as WebSocket, "/memory/router-link", "127.0.0.1");
  const hello = new RoutedReader((await link.bytes()).slice(0, -64), "mlh1");
  assertEquals(hello.text(), toolshed.did());
  const nonce = hello.fixed(32);
  link.receive(
    await new RoutedWriter("mlc1").text("fixture").text(router.did())
      .text(toolshed.did()).fixed(epoch).fixed(nonce).sign(router),
  );
  assertEquals(new TextDecoder().decode(await link.bytes()), "mlo1");
  let sequence = 0, challengeNumber = 20;
  async function control(op: number, payload: Uint8Array) {
    link.receive(
      new RoutedWriter("mlq1").time(++sequence).fixed(new Uint8Array([op]))
        .blob(payload).bytes,
    );
    const response = new RoutedReader(await link.bytes(), "mls1");
    assertEquals(response.time(), sequence);
    const status = response.fixed(1)[0], bytes = response.blob();
    response.end();
    return { status, bytes };
  }
  async function proof(signer = principal, seconds = 600) {
    const challenge = new Uint8Array(32).fill(++challengeNumber);
    const statement = await routedStatementPayload({
      principal: signer.did(),
      router: router.did(),
      deployment: "fixture",
      challenge,
      iat: now,
      exp: now + seconds,
    }).sign(signer);
    const issuance = await new RoutedWriter("mrc1").text("fixture").text(
      router.did(),
    )
      .fixed(epoch).fixed(context).fixed(challenge).time(now).time(now + 60)
      .sign(router);
    const receipt = await new RoutedWriter("mrr1").fixed(sha256(issuance)).text(
      signer.did(),
    )
      .fixed(sha256(statement)).time(now).sign(router);
    return new RoutedWriter("mrp1").blob(statement).blob(issuance).blob(receipt)
      .bytes;
  }
  const issued = await control(
    1,
    new RoutedWriter("mat1").fixed(context).blob(flags)
      .text(space.did()).time(1).bytes,
  );
  assertEquals(issued.status, 0);
  const ticket = issued.bytes;
  const evidence = await proof();
  assertEquals(
    (await control(
      2,
      new RoutedWriter("map1").fixed(ticket).blob(evidence).bytes,
    )).status,
    0,
  );
  async function dataSocket() {
    const socket = new FramedSocket();
    host.accept(
      socket as unknown as WebSocket,
      "/memory/router-data",
      "127.0.0.1",
    );
    const greeting = new RoutedReader(
      (await socket.bytes()).slice(0, -64),
      "mdh1",
    );
    assertEquals(greeting.text(), toolshed.did());
    const nonce = greeting.fixed(32), issued = greeting.time();
    greeting.end();
    const binding = await new RoutedWriter("mdb1").text(router.did()).text(
      "fixture",
    )
      .text(toolshed.did()).fixed(epoch).fixed(context).fixed(ticket).fixed(
        nonce,
      )
      .time(issued).fixed(sha256(flags)).sign(router);
    socket.receive(
      `fvj1:${
        JSON.stringify({
          type: "hello",
          protocol: "memory",
          flags: flagObject,
          routerTicket: routedHex(ticket),
          routerBinding: routedBase64(binding),
        })
      }`,
    );
    return socket;
  }
  const socket = await dataSocket();
  assertEquals(
    decodeRoutedFrame(await socket.take(), true).body.type,
    "hello.ok",
  );
  let requestNumber = 0;
  async function request(body: Record<string, unknown>) {
    const requestId = `r${++requestNumber}`;
    socket.receive(
      encodeRoutedFrame(`fvj1:${JSON.stringify({ ...body, requestId })}`),
    );
    while (true) {
      const message = decodeRoutedFrame(await socket.take(), true).body;
      if (message.requestId === requestId) return message;
    }
  }
  async function open() {
    const message = await request({
      type: "session.open",
      space: space.did(),
      principal: principal.did(),
      session: {},
    });
    assert(message.ok !== undefined, JSON.stringify(message));
    return message.ok as { sessionId: string; sessionToken: string };
  }
  return {
    server,
    host,
    socket,
    link,
    context,
    flags,
    space,
    principal,
    outsider,
    root,
    toolshed,
    control,
    proof,
    ticket,
    evidence,
    dataSocket,
    request,
    open,
    advanceOwnership: () => {
      ownership++;
    },
    close: async () => {
      host.close();
      await server.close();
      epochs.close();
      Deno.removeSync(root, { recursive: true });
    },
  };
}

Deno.test("redeemed Mode A tickets are single use; control renews and releases authority independently", async () => {
  const f = await fixture("lifecycle");
  try {
    const session = await f.open();
    const admit = (proof: Uint8Array) =>
      new RoutedWriter("mvp1").fixed(f.context).blob(f.flags).blob(proof).bytes;
    assertEquals(
      (await f.control(
        2,
        new RoutedWriter("map1").fixed(f.ticket).blob(f.evidence).bytes,
      )).status,
      1,
    );
    const copied = await f.dataSocket();
    await copied.closed.promise;
    assertEquals(f.socket.readyState, 1);
    assertEquals((await f.control(6, admit(await f.proof()))).status, 0);
    assertEquals(
      (await f.control(6, admit(await f.proof(f.outsider)))).status,
      0,
    );
    assert(
      (await f.request({
        type: "session.open",
        space: f.space.did(),
        principal: f.outsider.did(),
        session: {},
      })).error !== undefined,
    );
    assertEquals(
      (await f.control(
        4,
        new RoutedWriter("mrl1").fixed(f.context).text(f.principal.did()).bytes,
      )).status,
      0,
    );
    // Release retains the existing session lease, while denying new admission.
    assert(
      (await f.request({
        type: "session.watch.set",
        space: f.space.did(),
        sessionId: session.sessionId,
        watches: [],
      })).ok !== undefined,
    );
    assertEquals((await f.control(6, admit(await f.proof()))).status, 0);
    await f.open();
    assert(
      (await f.request({ type: "memory.compression", enabled: false }))
        .enabled === false,
    );
    assert(
      (await f.request({
        type: "session.close",
        space: f.space.did(),
        sessionId: session.sessionId,
      })).ok !== undefined,
    );
    f.advanceOwnership();
    f.host.fenceOwnership();
    await f.socket.closed.promise;
    assertEquals(f.link.readyState, 1);
  } finally {
    await f.close();
  }
});

Deno.test("omitted views retain their quota across watch replacements and resume", async () => {
  setServerExecutionConfig(true);
  const f = await fixture("retained-views");
  const views = Array.from(
    { length: 64 },
    (_, i) => ({
      id: `v${i}`,
      revision: 0,
      query: {
        roots: [{ id: "of:visible", selector: { path: [], schema: false } }],
      },
      mode: "speculate",
      componentContractVersion: "1",
    }),
  );
  try {
    for (let i = 0; i < 16; i++) {
      const session = await f.open();
      const watched = await f.request({
        type: "session.watch.set",
        space: f.space.did(),
        sessionId: session.sessionId,
        watches: [],
        views,
      });
      assert(watched.ok !== undefined, JSON.stringify(watched));
      assert(
        (await f.request({
          type: "session.watch.set",
          space: f.space.did(),
          sessionId: session.sessionId,
          watches: [],
        })).ok !== undefined,
      );
      assert(
        (await f.request({
          type: "session.open",
          space: f.space.did(),
          principal: f.principal.did(),
          session,
        })).ok !== undefined,
      );
    }
    const overflow = await f.open();
    f.socket.receive(
      encodeRoutedFrame(`fvj1:${
        JSON.stringify({
          type: "session.watch.set",
          requestId: "overflow",
          space: f.space.did(),
          sessionId: overflow.sessionId,
          watches: [],
          views,
        })
      }`),
    );
    await f.socket.closed.promise;
    assertEquals(f.link.readyState, 1);
  } finally {
    await f.close();
    resetServerExecutionConfig();
  }
});

Deno.test("the private data boundary closes a forged route without affecting the authenticated link", async () => {
  const f = await fixture("forged-route");
  try {
    const session = await f.open();
    f.socket.receive(
      `fvj1:${
        JSON.stringify({
          type: "session.watch.set",
          requestId: "forged",
          space: f.space.did(),
          sessionId: session.sessionId,
          watches: [],
          upstream: "127.0.0.1:9",
        })
      }`,
    );
    await f.socket.closed.promise;
    assertEquals(f.link.readyState, 1);
  } finally {
    await f.close();
  }
});

Deno.test("a slow private reader exhausts only its bounded output context", async () => {
  const f = await fixture("slow-output");
  try {
    const session = await f.open();
    f.socket.bufferedAmount = 4 * 1024 * 1024;
    f.socket.receive(
      `fvj1:${
        JSON.stringify({
          type: "session.watch.set",
          requestId: "slow",
          space: f.space.did(),
          sessionId: session.sessionId,
          watches: [],
        })
      }`,
    );
    await f.socket.closed.promise;
    assertEquals(f.link.readyState, 1);
  } finally {
    await f.close();
  }
});

Deno.test("custom transports omit routed capability and reject an unsolicited routed hello", async () => {
  const flags = {
    ...getMemoryProtocolFlags(),
    connectionAuth: true,
    routedAuthV1: true,
  };
  let receiver: ((payload: string) => void) | undefined;
  const transport: Transport = {
    send: (payload) => {
      const hello = decodeRoutedFrame(payload, false).body;
      assertEquals(
        (hello.flags as Record<string, unknown>).routedAuthV1,
        false,
      );
      receiver!(
        `fvj1:${
          JSON.stringify({ type: "hello.ok", protocol: "memory", flags })
        }`,
      );
      return Promise.resolve();
    },
    setReceiver: (callback) => {
      receiver = callback;
    },
    close: () => Promise.resolve(),
  };
  await assertRejects(
    () => connect({ transport }),
    Error,
    "Routed transport codec unavailable",
  );
});

Deno.test("private TLS listener accepts bounded binary links and rejects HTTP, Origin and extensions", async () => {
  const f = await fixture("tls-listener");
  const key = `${f.root}/key.pem`, cert = `${f.root}/cert.pem`;
  const certificate = await new Deno.Command("openssl", {
    args: [
      "req",
      "-new",
      "-x509",
      "-newkey",
      "ed25519",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-addext",
      "basicConstraints=critical,CA:FALSE",
    ],
    stdout: "null",
    stderr: "piped",
  }).output();
  assert(certificate.success);
  const listener = await listenRoutedMemory({
    hostname: "127.0.0.1",
    port: 0,
    certificate: Deno.readTextFileSync(cert),
    key: Deno.readTextFileSync(key),
    host: f.host,
  });
  const url = `https://127.0.0.1:${listener.port}`;
  const client = Deno.createHttpClient({
    caCerts: [Deno.readTextFileSync(cert)],
  });
  const sockets: WebSocket[] = [];
  function socket(
    path: string,
    options: { origin?: string; perMessageDeflate?: boolean } = {},
  ) {
    const peer = new WebSocket(`${url.replace("https:", "wss:")}${path}`, {
      ca: Deno.readTextFileSync(cert),
      perMessageDeflate: false,
      ...options,
    });
    sockets.push(peer);
    peer.on("error", () => {});
    return peer;
  }
  try {
    const options: RequestInit & { client: Deno.HttpClient } = { client };
    const response = await fetch(url, options);
    assertEquals(response.status, 404);
    await response.text();
    for (
      const [path, options] of [
        ["/toolshed/http", {}],
        ["/memory/router-link", { origin: "https://public.example" }],
        ["/memory/router-data", { perMessageDeflate: true }],
      ] as const
    ) {
      const peer = socket(path, options);
      await new Promise<void>((resolve) => peer.once("close", resolve));
      assertEquals(peer.readyState, WebSocket.CLOSED);
    }
    const link = socket("/memory/router-link");
    const greeting = await new Promise<Uint8Array>((resolve) =>
      link.once(
        "message",
        (data) => resolve(new Uint8Array(data as ArrayBuffer)),
      )
    );
    const parsed = new RoutedReader(greeting.slice(0, -64), "mlh1");
    assertEquals(parsed.text(), f.toolshed.did());
    const closed = new Promise<void>((resolve) => link.once("close", resolve));
    link.send(new Uint8Array([1, 2, 3]));
    await closed;
    assertEquals(f.socket.readyState, 1);
  } finally {
    for (const socket of sockets) socket.terminate();
    client.close();
    await listener.close();
    await f.close();
  }
});
