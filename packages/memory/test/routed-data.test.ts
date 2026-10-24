/** Real toolshed authority behind an in-process framed router peer. */
// deno-lint-ignore no-external-import -- Exercise the host's event-loop marker through the same immediate queue.
import { setImmediate } from "node:timers/promises";

// @ts-types="@types/ws"
import WebSocket from "ws";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import { sha256 } from "@commonfabric/content-hash";
import { taggedHashStringOf } from "@commonfabric/data-model";
import { setModernCellRepConfig } from "@commonfabric/data-model/cell-rep";
import type { MemorySpace } from "../interface.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  resetServerExecutionConfig,
  type ServerMessage,
  type SessionReport,
  setServerExecutionConfig,
} from "../v2.ts";
import { connect, type Transport } from "../v2/client.ts";
import * as Engine from "../v2/engine.ts";
import { RoutedEpochStore } from "../v2/routed-epochs.ts";
import {
  DEFAULT_ROUTED_HOST_LIMITS,
  RoutedControlDiagnostics,
  type RoutedHostLimits,
  routedHostLimits,
  routedHostLimitsFor,
  RoutedMemoryHost,
  validatedRoutedEncodingFlags,
} from "../v2/routed-host.ts";
import { listenRoutedMemory } from "../v2/routed-listener.ts";
import {
  decodeRoutedFrame,
  encodeRoutedFrame,
  ROUTED_QUEUE_LIMIT,
  ROUTED_RAW_LIMIT,
  routedFlags,
  routedObject,
} from "../v2/routed-parser.ts";
import {
  readRoutedBase64,
  readRoutedHex,
  readRoutedProof,
  readRoutedStatement,
  routedBase64,
  routedHex,
  RoutedReader,
  routedStatementPayload,
  RoutedWriter,
  verifyRoutedRecord,
} from "../v2/routed-wire.ts";
import {
  decodeRouterHeader,
  decodeRouterRecord,
  decodeRouterRequestCredit,
  encodeRouterHeader,
  isRouterRequestCredit,
  ROUTER_REQUEST_WINDOW,
  ROUTER_SEND_WINDOW_BYTES,
  RouterAssembler,
  type RouterHeader,
  routerRecord,
  routerRecords,
  routerRoute,
} from "../v2/router-protocol.ts";
import { Server } from "../v2/server.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";

/** The frame cap the test's router peer and clients apply, the toolshed's default. */
const FRAME_SLOTS = DEFAULT_ROUTED_HOST_LIMITS.frameSlots;

/** Router peer that exposes logical Memory messages to the test cases. */
class FramedSocket extends EventTarget {
  assembler = new RouterAssembler();
  dataProtocol = false;
  readyState = 1;
  bufferedAmount = 0;
  isPaused = false;
  binaryType = "arraybuffer";
  output: (string | Uint8Array)[] = [];
  changed = Promise.withResolvers<void>();
  closed = Promise.withResolvers<void>();
  negotiatedMemoryFlags: unknown;
  requestOrdinal = 0;
  /** Request credit the toolshed has returned and this router has not spent. */
  credit = 0;
  /** Uploads waiting for credit, in order, by declared body bytes. */
  uploads: { bytes: number; send: () => void }[] = [];

  /** Records read flow; `deliver()` can model ws callbacks already buffered. */
  pause() {
    this.isPaused = true;
  }

  /** Records the host releasing read backpressure. */
  resume() {
    this.isPaused = false;
  }

  send(bytes: string | Uint8Array, done?: (error?: Error) => void) {
    if (bytes instanceof Uint8Array && isRouterRequestCredit(bytes)) {
      this.credit += decodeRouterRequestCredit(bytes);
      expect(this.credit).toBeLessThanOrEqual(ROUTER_REQUEST_WINDOW);
      queueMicrotask(() => {
        done?.();
        this.pumpUploads();
      });
      return;
    }
    if (
      bytes instanceof Uint8Array && bytes[0] === 109 && bytes[1] === 114 &&
      bytes[2] === 116
    ) {
      const complete = this.assembler.receive(bytes);
      if (complete !== undefined) {
        this.output.push(complete.payload);
        this.changed.resolve();
      }
      queueMicrotask(() => done?.());
      return;
    }
    if (
      typeof bytes === "string" && bytes.startsWith('{"type":"router.ready"')
    ) {
      const ready = JSON.parse(bytes);
      expect(ready.version).toBe(1);
      expect(ready.routerEncodingNegotiation).toBe(true);
      expect(ready.routerRequestCredit).toBe(true);
      expect(ready.negotiatedMemoryFlags).toEqual(this.negotiatedMemoryFlags);
      expect(ready.memoryFlags).toMatchObject({
        connectionAuth: true,
        routedAuthV1: true,
      });
      expect(Object.hasOwn(ready.memoryFlags, "routerEncodingNegotiation"))
        .toBe(false);
      expect(Object.hasOwn(ready.memoryFlags, "routerRequestCredit"))
        .toBe(false);
      bytes = `fvj1:${
        JSON.stringify({
          type: "hello.ok",
          protocol: "memory",
          flags: ready.memoryFlags,
        })
      }`;
    } else {
      expect(this.dataProtocol, "Private data output must use router records")
        .toBe(false);
    }
    this.output.push(bytes);
    this.changed.resolve();
    queueMicrotask(() => done?.());
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.changed.resolve();
    this.closed.resolve();
    this.dispatchEvent(new Event("close"));
  }
  receive(bytes: string | Uint8Array) {
    if (typeof bytes === "string" && bytes.startsWith("fvj1:")) {
      try {
        const value = JSON.parse(bytes.slice(5));
        if (value.type === "hello") {
          const { protocol: _protocol, flags, ...rest } = value;
          this.dataProtocol = true;
          this.negotiatedMemoryFlags = value.negotiatedMemoryFlags;
          bytes = JSON.stringify({
            ...rest,
            type: "router.hello",
            version: 1,
            memoryFlags: flags,
            routerRequestCredit: true,
          });
          this.deliver(bytes);
          return;
        }
      } catch { /* Malformed input is sent to the boundary under test. */ }
    }
    if (this.dataProtocol) {
      try {
        const decoded = decodeRoutedFrame(bytes, true, FRAME_SLOTS, null);
        const completed = Promise.withResolvers<void>();
        this.uploads.push({
          bytes: typeof bytes === "string"
            ? new TextEncoder().encode(bytes).length
            : bytes.length,
          send: () => {
            // Within credit the body follows its header at once.
            for (
              const record of routerRecords(
                routerRoute(decoded.body),
                bytes,
                ++this.requestOrdinal,
              )
            ) this.deliver(record);
            completed.resolve();
          },
        });
        this.pumpUploads();
        return completed.promise;
      } catch { /* Malformed input is sent to the boundary under test. */ }
    }
    this.deliver(bytes);
  }
  /** Sends the waiting uploads, in order, while the credit covers them. */
  pumpUploads() {
    while (
      this.readyState === WebSocket.OPEN && this.uploads.length > 0 &&
      this.uploads[0].bytes <= this.credit
    ) {
      const next = this.uploads.shift()!;
      this.credit -= next.bytes;
      next.send();
    }
  }

  /**
   * Sends a manual request header once the credit covers it, as the router
   * does; callers deliver the body after it.
   */
  header(header: RouterHeader): Promise<void> {
    const sent = Promise.withResolvers<void>();
    this.uploads.push({
      bytes: header.bytes,
      send: () => {
        const ordinal = header.requestOrdinal ?? ++this.requestOrdinal;
        this.deliver(
          encodeRouterHeader({ ...header, requestOrdinal: ordinal }),
        );
        sent.resolve();
      },
    });
    this.pumpUploads();
    return sent.promise;
  }
  deliver(bytes: string | Uint8Array) {
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

/** Stalls response writes while the fixture keeps taking request credit. */
function stubOutput(socket: FramedSocket, send: FramedSocket["send"]) {
  const original = socket.send.bind(socket);
  return stub(socket, "send", (bytes, done) => {
    if (bytes instanceof Uint8Array && isRouterRequestCredit(bytes)) {
      original(bytes, done);
    } else send(bytes, done);
  });
}

/**
 * `modernCellRep` is the toolshed's cell representation and
 * `clientModernCellRep` the one the routed client's hello names; they agree
 * unless a test says otherwise.
 */
async function fixture(
  name: string,
  {
    modernCellRep = true,
    clientModernCellRep = modernCellRep,
    limits,
    clock,
    otherRouters = 0,
    extraSpaces = [],
    serverFlags,
    negotiatedFlags = {},
    clientFlags = {},
  }: {
    modernCellRep?: boolean;
    clientModernCellRep?: boolean;
    limits?: Partial<RoutedHostLimits>;
    /** The toolshed's time and the time proofs are made at, if not now. */
    clock?: { now: number };
    /** Routers the toolshed also allows, which never link. */
    otherRouters?: number;

    /** Additional owned spaces with the fixture principal on their ACL. */
    extraSpaces?: Identity[];

    /** Instance-local capabilities advertised before the private link opens. */
    serverFlags?: Partial<ReturnType<Server["memoryProtocolFlags"]>>;

    /** Effective public negotiation over the fixture's original client flags. */
    negotiatedFlags?: Record<string, boolean | string[]>;

    /**
     * The client's own capabilities where they differ from the toolshed's;
     * `undefined` removes a capability the client does not know.
     */
    clientFlags?: Record<string, boolean | string[] | undefined>;
  } = {},
) {
  setModernCellRepConfig(modernCellRep);
  const root = Deno.makeTempDirSync({ prefix: `routed-data-${name}-` });
  const [space, principal, outsider, toolshed, router] = await Promise.all(
    [121, 122, 123, 124, 125].map((n) =>
      Identity.fromRaw(new Uint8Array(32).fill(n))
    ),
  );
  const store = toFileUrl(`${root}/store/`);
  Deno.mkdirSync(`${root}/store/engine-v3`, { recursive: true });
  const ownedSpaces = new Set<string>(
    [space, ...extraSpaces].map((space) => space.did()),
  );
  for (const did of ownedSpaces) {
    const engine = await Engine.open({
      url: resolveSpaceStoreUrl(store, did as MemorySpace),
    });
    Engine.applyCommit(engine, {
      sessionId: "seed",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${did}`,
          value: {
            value: { [principal.did()]: "OWNER" },
          },
        }],
      },
    });
    Engine.close(engine);
  }
  let ownership = 1;
  const at = () => clock?.now ?? Math.floor(Date.now() / 1000);
  const server = new Server({
    store,
    acl: { mode: "enforce" },
    requireExplicitAcl: true,
    ownsSpace: (did) => ownedSpaces.has(did) && ownership > 0,
    authorizeSessionOpen: () => undefined,
    sessionOpenAuth: { audience: toolshed.did() },
    subscriptionRefreshDelayMs: "manual",
  });
  const memoryProtocolFlags = server.memoryProtocolFlags.bind(server);
  const flagsStub = serverFlags === undefined ? undefined : stub(
    server,
    "memoryProtocolFlags",
    () => ({ ...memoryProtocolFlags(), ...serverFlags }),
  );
  const epochs = new RoutedEpochStore(`${root}/ledger`);
  const host = new RoutedMemoryHost({
    server,
    identity: toolshed,
    deployment: "fixture",
    epochs,
    ownership: (did) =>
      ownedSpaces.has(did) && ownership > 0 ? ownership : undefined,
    routers: new Map([
      [router.did(), new Set(["127.0.0.1"])],
      ...await Promise.all(
        Array.from({ length: otherRouters }, async (_, i) =>
          [
            (await Identity.fromRaw(new Uint8Array(32).fill(130 + i))).did(),
            new Set([`127.0.0.${2 + i}`]),
          ] as const),
      ),
    ]),
    limits,
    ...(clock === undefined ? {} : { now: () => clock.now }),
  });
  const flagObject = Object.fromEntries(
    Object.entries({
      ...server.memoryProtocolFlags(),
      // A current SDK offers end-to-end compression; a test overrides it to
      // model an older one.
      routedCompressionV1: true,
      ...clientFlags,
      modernCellRep: clientModernCellRep,
      connectionAuth: true,
      routedAuthV1: true,
    }).filter(([, value]) => value !== undefined),
  );
  const flags = routedFlags(flagObject);
  const encodingFlags = {
    ...Object.fromEntries(
      Object.entries(flagObject).filter(([key]) => key !== "serverExecution"),
    ),
    ...negotiatedFlags,
  };
  const epoch = new Uint8Array(16).fill(11),
    context = new Uint8Array(16).fill(12);
  const link = new FramedSocket();
  host.accept(link as unknown as WebSocket, "/memory/router-link", "127.0.0.1");
  const hello = new RoutedReader(
    await verifyRoutedRecord(await link.bytes(), toolshed.did()),
    "rph1",
  );
  assertEquals(hello.text(), toolshed.did());
  const nonce = hello.fixed(32);
  hello.time();
  const privateFlags = JSON.parse(new TextDecoder().decode(hello.blob()));
  expect(privateFlags.routerEncodingNegotiation).toBe(true);
  expect(
    Object.hasOwn(server.memoryProtocolFlags(), "routerEncodingNegotiation"),
  )
    .toBe(false);
  hello.end();
  link.receive(
    await new RoutedWriter("rpc1").text("fixture").text(router.did())
      .text(toolshed.did()).fixed(epoch).fixed(nonce).fixed(new Uint8Array([1]))
      .sign(router),
  );
  assertEquals(new TextDecoder().decode(await link.bytes()), "rpo1");
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
  /** Attests `statement` for context `ctx`, the fixture's own by default. */
  async function attest(statement: Uint8Array, ctx = context) {
    const now = at();
    const { challenge, principal } = await readRoutedStatement(statement);
    const issuance = await new RoutedWriter("mrc1").text("fixture").text(
      router.did(),
    )
      .fixed(epoch).fixed(ctx).fixed(challenge).time(now).time(now + 60)
      .sign(router);
    const receipt = await new RoutedWriter("mrr1").fixed(sha256(issuance)).text(
      principal,
    )
      .fixed(sha256(statement)).time(now).sign(router);
    return new RoutedWriter("mrp1").blob(statement).blob(issuance).blob(receipt)
      .bytes;
  }
  /** A fresh proof by `signer`, for context `ctx` if not the fixture's. */
  async function proof(signer = principal, seconds = 600, ctx = context) {
    const challenge = new Uint8Array(32).fill(++challengeNumber % 256);
    challenge[0] = challengeNumber >> 8;
    return await attest(
      await routedStatementPayload({
        principal: signer.did(),
        router: router.did(),
        deployment: "fixture",
        challenge,
        iat: at(),
        exp: at() + seconds,
      }).sign(signer),
      ctx,
    );
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
  /** Asks for another ticket for the fixture's context and space. */
  async function issueTicket() {
    const issued = await control(
      1,
      new RoutedWriter("mat1").fixed(context).blob(flags)
        .text(space.did()).time(1).bytes,
    );
    assertEquals(issued.status, 0);
    return issued.bytes;
  }
  /**
   * A data socket that has the toolshed's greeting, and the hello that
   * presents `presented` on it for the fixture's context, not yet sent.
   */
  async function socketBeforeHello(
    presented = ticket,
    selectedFlags = encodingFlags,
  ) {
    const socket = new FramedSocket();
    host.accept(
      socket as unknown as WebSocket,
      "/memory/router-data",
      "127.0.0.1",
    );
    const greeting = new RoutedReader(
      (await socket.bytes()).slice(0, -64),
      "rdh1",
    );
    assertEquals(greeting.text(), toolshed.did());
    const nonce = greeting.fixed(32), issued = greeting.time();
    greeting.end();
    const binding = await new RoutedWriter("rdb1").text(router.did()).text(
      "fixture",
    )
      .text(toolshed.did()).fixed(epoch).fixed(context).fixed(presented).fixed(
        nonce,
      )
      .time(issued).fixed(sha256(flags))
      .fixed(sha256(routedFlags(selectedFlags))).sign(router);
    const hello = `fvj1:${
      JSON.stringify({
        type: "hello",
        protocol: "memory",
        flags: flagObject,
        negotiatedMemoryFlags: selectedFlags,
        routerTicket: routedHex(presented),
        routerBinding: routedBase64(binding),
      })
    }`;
    return { socket, hello };
  }
  /** A data socket that has sent the hello presenting `presented`. */
  async function dataSocket(presented = ticket) {
    const { socket, hello } = await socketBeforeHello(presented);
    socket.receive(hello);
    return socket;
  }
  const socket = await dataSocket();
  const greeted = modernCellRep === clientModernCellRep
    ? decodeRoutedFrame(await socket.take(), true, FRAME_SLOTS).body
    : (await socket.closed.promise, { type: "closed" });
  if (modernCellRep === clientModernCellRep) {
    assertEquals(greeted.type, "hello.ok");
  }
  let requestNumber = 0;
  async function request(body: Record<string, unknown>) {
    const requestId = `r${++requestNumber}`;
    socket.receive(
      encodeRoutedFrame(
        `fvj1:${JSON.stringify({ ...body, requestId })}`,
        FRAME_SLOTS,
      ),
    );
    while (true) {
      const message =
        decodeRoutedFrame(await socket.take(), true, FRAME_SLOTS).body;
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
    greeted,
    link,
    context,
    flags,
    encodingFlags,
    privateFlags,
    space,
    principal,
    outsider,
    root,
    toolshed,
    router,
    attest,
    epochs,
    control,
    proof,
    ticket,
    evidence,
    issueTicket,
    socketBeforeHello,
    dataSocket,
    request,
    open,
    advanceOwnership: () => {
      ownership++;
    },
    close: async () => {
      host.close();
      await server.close();
      flagsStub?.restore();
      epochs.close();
      Deno.removeSync(root, { recursive: true });
    },
  };
}

/**
 * Runs `run` and returns the reasons of the `request-refused` verdicts the
 * toolshed logged while it ran, in order. The answer a client gets names no
 * reason, so the toolshed's journal line is the only place one can be read.
 */
async function refusalReasons(run: () => Promise<void>): Promise<string[]> {
  const reasons: string[] = [];
  using _info = stub(console, "info", (line: unknown) => {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(String(line));
    } catch {
      return;
    }
    if (
      entry.event === "routed-memory-verdict" &&
      entry.verdict === "request-refused"
    ) reasons.push(String(entry.reason));
  });
  await run();
  return reasons;
}

/**
 * A further data socket on `f` whose requests reach the Memory server only
 * when the test releases them, as on a busy toolshed whose turns are still
 * running when the router sends more.
 */
async function heldTurns(f: Awaited<ReturnType<typeof fixture>>) {
  const stubs = new DisposableStack();
  const held: (() => void)[] = [];
  const entered = new Set<string>();
  let hold = false;
  const connect = f.server.connectRouted.bind(f.server);
  stubs.use(stub(f.server, "connectRouted", (send, ...args) => {
    const backend = connect(send, ...args);
    const receive = backend.receive.bind(backend);
    stubs.use(stub(backend, "receive", async (payload) => {
      if (hold) {
        const { requestId } =
          decodeRoutedFrame(payload, true, FRAME_SLOTS).body;
        if (typeof requestId === "string") entered.add(requestId);
        await new Promise<void>((resolve) => held.push(resolve));
      }
      await receive(payload);
    }));
    return backend;
  }));
  const socket = await f.dataSocket(await f.issueTicket());
  assertEquals(
    decodeRoutedFrame(await socket.take(), true, FRAME_SLOTS).body.type,
    "hello.ok",
  );
  hold = true;
  let requests = 0;
  const answers = new Map<string, Record<string, unknown>>();
  const drain = async () => {
    while (socket.output.length > 0) {
      const message =
        decodeRoutedFrame(await socket.take(), true, FRAME_SLOTS).body;
      if (typeof message.requestId === "string") {
        answers.set(message.requestId, message);
      }
    }
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  /** Sends every body at once and returns their request IDs. */
  const send = (bodies: Record<string, unknown>[]) =>
    bodies.map((body) => {
      const requestId = `held${++requests}`;
      socket.receive(
        encodeRoutedFrame(
          `fvj1:${JSON.stringify({ ...body, requestId })}`,
          FRAME_SLOTS,
        ),
      );
      return requestId;
    });
  /** Whether `id` has reached the server or been answered without it. */
  const dispatched = async (id: string) => {
    for (let i = 0; i < 10; i++) await tick();
    await drain();
    return entered.has(id) || answers.has(id);
  };
  /** Lets the server take each held request as it comes; answers `ids`. */
  const settle = async (ids: string[]) => {
    for (let i = 0; !ids.every((id) => answers.has(id)); i++) {
      assert(i < 2000, "requests were not all answered");
      for (const resolve of held.splice(0)) resolve();
      await drain();
      await tick();
    }
    return ids.map((id) => answers.get(id)!);
  };
  const pipelined = (bodies: Record<string, unknown>[]) => settle(send(bodies));
  return {
    send,
    dispatched,
    settle,
    pipelined,
    request: async (body: Record<string, unknown>) =>
      (await pipelined([body]))[0],
    open: async () => {
      const [opened] = await pipelined([{
        type: "session.open",
        space: f.space.did(),
        principal: f.principal.did(),
        session: {},
      }]);
      assert(opened.ok !== undefined, JSON.stringify(opened));
      return opened.ok as { sessionId: string; sessionToken: string };
    },
    [Symbol.dispose]: () => stubs.dispose(),
  };
}

/**
 * What the toolshed does to `socket` next: the type of the frame it sends,
 * or "closed" once it has closed the socket.
 */
async function frameOrClose(socket: FramedSocket): Promise<unknown> {
  try {
    return decodeRoutedFrame(await socket.take(), true, FRAME_SLOTS).body.type;
  } catch (error) {
    if (socket.readyState === 3) return "closed";
    throw error;
  }
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

describe("routed session reports", () => {
  it("records reports under the admitted principal and refuses them after ACL revocation", async () => {
    const f = await fixture("session-reports");
    try {
      const session = await f.open();
      const report: SessionReport = {
        kind: "echo-breaker",
        event: "trip",
        document: { id: "of:reported-document", scopeKey: "space" },
        action: "cf:routed-report",
      };
      const request = {
        type: "session.report",
        space: f.space.did(),
        sessionId: session.sessionId,
        report,
      };
      expect(f.greeted.flags).toMatchObject({ sessionReportV1: true });
      expect(await f.request(request)).toMatchObject({
        type: "response",
        ok: {},
      });
      const recorded = f.server.sessionReports();
      expect(recorded.echoBreaker.trips).toBe(1);
      expect(recorded.recent).toEqual([{
        ...report,
        at: expect.any(Number),
        space: f.space.did(),
        session: session.sessionId,
        principal: f.principal.did(),
      }]);
      const committed = await f.request({
        type: "transact",
        space: f.space.did(),
        sessionId: session.sessionId,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: `of:${f.space.did()}`,
            value: { value: { [f.outsider.did()]: "OWNER" } },
          }],
        },
      });
      expect(committed.ok).toBeDefined();
      expect(await f.request(request)).toMatchObject({
        type: "response",
        error: { message: "Routed memory request denied" },
      });
      expect(f.server.sessionReports()).toEqual(recorded);
      expect(f.socket.readyState).toBe(1);
    } finally {
      await f.close();
    }
  });
});

describe("optional routed host quotas", () => {
  const disabled = routedHostLimits(Object.fromEntries(
    Object.keys(DEFAULT_ROUTED_HOST_LIMITS).map((key) => [key, null]),
  ));
  const watches = (length: number) =>
    Array.from({ length }, (_, i) => ({
      id: `w${i}`,
      kind: "graph",
      query: { roots: [] },
    }));
  const holdings = (length: number) =>
    Array.from({ length }, (_, i) => ({ id: `of:h${i}`, seq: 0 }));

  for (const kind of ["sessions", "watches", "holdings"] as const) {
    for (
      const scope of ["Context", "Router", "Toolshed", "Principal"] as const
    ) {
      it(`enforces ${kind}Per${scope} independently and releases its capacity`, async () => {
        const f = await fixture("independent-quota", {
          limits: { ...disabled, [`${kind}Per${scope}`]: 2 },
        });
        try {
          const first = await f.open();
          const second = await f.open();
          expect(f.host.accessForTestingOnly).toMatchObject({
            watchMirrors: kind === "watches" ? 2 : 0,
            viewMirrors: kind === "watches" ? 2 : 0,
            holdingMirrors: kind === "holdings" ? 2 : 0,
          });
          if (kind === "sessions") {
            expect(
              await f.request({
                type: "session.open",
                space: f.space.did(),
                principal: f.principal.did(),
                session: {},
              }),
            ).toMatchObject({ error: { retriable: true } });
          } else {
            const set = (sessionId: string, count: number) =>
              f.request({
                type: "session.watch.set",
                space: f.space.did(),
                sessionId,
                watches: kind === "watches" ? watches(count) : [],
                ...(kind === "holdings" ? { holdings: holdings(count) } : {}),
              });
            expect(await set(first.sessionId, 2)).toHaveProperty("ok");
            expect(await set(second.sessionId, 1)).toMatchObject({
              error: { retriable: true },
            });
            expect(await set(first.sessionId, 0)).toHaveProperty("ok");
            expect(await set(second.sessionId, 2)).toHaveProperty("ok");
            const totals = f.host.accessForTestingOnly.toolshedTotals;
            expect(totals).toEqual({
              sessions: 0,
              watches: kind === "watches" ? 2 : 0,
              holdings: kind === "holdings" ? 2 : 0,
            });
          }
          expect(
            await f.request({
              type: "session.close",
              space: f.space.did(),
              sessionId: second.sessionId,
            }),
          ).toHaveProperty("ok");
          expect((await f.open()).sessionId).toBeDefined();
          expect(f.socket.readyState).toBe(1);
        } finally {
          await f.close();
        }
      });
    }
  }

  it("admits disabled quotas without aggregate bookkeeping and retains session authorization", async () => {
    const f = await fixture("disabled-quotas", { limits: disabled });
    try {
      const first = await f.open();
      await f.open();
      await f.open();
      expect(
        await f.request({
          type: "session.watch.set",
          space: f.space.did(),
          sessionId: first.sessionId,
          watches: watches(2049),
          holdings: holdings(2),
          views: [],
        }),
      ).toHaveProperty("ok");
      const backendSession = f.server.accessForTestingOnly.sessionsForSpace(
        f.space.did(),
      ).find((session) => session.id === first.sessionId);
      expect(backendSession?.watches.length).toBe(2049);
      expect(
        await f.request({
          type: "session.watch.add",
          space: f.space.did(),
          sessionId: first.sessionId,
          watches: [{ id: "added", kind: "graph", query: { roots: [] } }],
          holdings: [],
          views: [],
        }),
      ).toHaveProperty("ok");
      expect(backendSession?.watches.length).toBe(2050);
      expect(
        await f.request({
          type: "session.watch.set",
          space: f.space.did(),
          sessionId: first.sessionId,
          watches: watches(1),
        }),
      ).toHaveProperty("ok");
      expect(backendSession?.watches.map((watch) => watch.id)).toEqual(["w0"]);
      expect(f.host.accessForTestingOnly).toMatchObject({
        watchMirrors: 0,
        mirroredWatchIds: 0,
        viewMirrors: 0,
        holdingMirrors: 0,
      });
      expect(f.host.accessForTestingOnly.toolshedTotals).toEqual({
        sessions: 0,
        watches: 0,
        holdings: 0,
      });
      expect(f.host.accessForTestingOnly.routerTotals.size).toBe(0);
      expect(f.host.accessForTestingOnly.principalTotals.size).toBe(0);
      expect(f.host.accessForTestingOnly.usageEntries).toBe(0);
      expect(
        await f.request({
          type: "session.watch.set",
          space: f.space.did(),
          sessionId: "unknown",
          watches: [],
        }),
      ).toHaveProperty("error");
      expect(
        await f.request({
          type: "session.open",
          space: f.space.did(),
          principal: f.outsider.did(),
          session: {},
        }),
      ).toHaveProperty("error");
      expect(
        await f.request({
          type: "session.close",
          space: f.space.did(),
          sessionId: first.sessionId,
        }),
      ).toHaveProperty("ok");
      expect(
        await f.request({
          type: "session.watch.set",
          space: f.space.did(),
          sessionId: first.sessionId,
          watches: [],
        }),
      ).toHaveProperty("error");
    } finally {
      await f.close();
    }
  });

  for (const quota of ["watchesPerSession", "viewsPerSession"] as const) {
    for (const limit of [2, null]) {
      it(`applies ${quota}=${limit} independently of aggregate quotas`, async () => {
        setServerExecutionConfig(true);
        const f = await fixture("session-quotas", {
          limits: { ...disabled, [quota]: limit },
        });
        try {
          const session = await f.open();
          expect(f.host.accessForTestingOnly).toMatchObject({
            watchMirrors: quota === "watchesPerSession" && limit !== null
              ? 1
              : 0,
            viewMirrors: quota === "viewsPerSession" && limit !== null ? 1 : 0,
            holdingMirrors: 0,
          });
          const set = (length: number) =>
            f.request({
              type: "session.watch.set",
              space: f.space.did(),
              sessionId: session.sessionId,
              watches: quota === "watchesPerSession" ? watches(length) : [],
              views: quota === "viewsPerSession"
                ? Array.from({ length }, (_, i) => ({
                  id: `v${i}`,
                  revision: 0,
                  query: {
                    roots: [{
                      id: "of:visible",
                      selector: { path: [], schema: false },
                    }],
                  },
                  mode: "speculate",
                  componentContractVersion: "1",
                }))
                : [],
            });
          expect(await set(2)).toHaveProperty("ok");
          const response = await set(limit === null ? 65 : 3);
          if (limit === null) expect(response).toHaveProperty("ok");
          else {
            expect(response).toHaveProperty("error");
            expect(response.error).not.toHaveProperty("retriable");
          }
          expect(f.socket.readyState).toBe(1);
        } finally {
          await f.close();
          resetServerExecutionConfig();
        }
      });
    }
  }

  for (const limit of [2, 8193, null]) {
    it(`applies holdingsPerSession=${limit} to raw frames`, async () => {
      const f = await fixture("holding-quota", {
        limits: { ...disabled, holdingsPerSession: limit },
      });
      try {
        const session = await f.open();
        const send = (length: number) =>
          f.socket.receive(`fvj1:${
            JSON.stringify({
              type: "session.watch.set",
              requestId: "holdings",
              space: f.space.did(),
              sessionId: session.sessionId,
              watches: [],
              holdings: holdings(length),
            })
          }`);
        send(limit ?? 8193);
        let message;
        do {
          message =
            decodeRoutedFrame(await f.socket.take(), true, FRAME_SLOTS).body;
        } while (message.requestId !== "holdings");
        expect(message).toHaveProperty("ok");
        if (limit !== null) {
          send(limit + 1);
          await f.socket.closed.promise;
          expect(f.socket.readyState).toBe(3);
        } else {
          expect(f.socket.readyState).toBe(1);
        }
      } finally {
        await f.close();
      }
    });
  }

  for (
    const quota of [
      "proofsPerContext",
      "principalsPerContext",
      "principalHistoryPerContext",
    ] as const
  ) {
    for (const limit of [1, null]) {
      it(`applies ${quota}=${limit} while validating signed proofs`, async () => {
        const f = await fixture("proof-quota", {
          limits: { ...disabled, [quota]: limit },
        });
        try {
          const proof = await f.proof(f.outsider);
          const admit = (bytes: Uint8Array) =>
            f.control(
              6,
              new RoutedWriter("mvp1").fixed(f.context).blob(f.flags).blob(
                bytes,
              )
                .bytes,
            );
          expect((await admit(proof)).status).toBe(limit === null ? 0 : 1);
          if (limit === null) {
            expect(
              (await f.control(
                4,
                new RoutedWriter("mrl1").fixed(f.context).text(f.outsider.did())
                  .bytes,
              )).status,
            ).toBe(0);
            expect((await admit(proof)).status).toBe(1);
          }
          expect(f.socket.readyState).toBe(3);
          expect(f.link.readyState).toBe(1);
        } finally {
          await f.close();
        }
      });
    }
  }

  for (const limit of [1, null]) {
    it(`applies context and ticket quotas set to ${limit} independently`, async () => {
      for (const quota of ["contextsPerLink", "tickets"] as const) {
        const f = await fixture("control-quota", {
          limits: { ...disabled, [quota]: limit },
        });
        try {
          const issue = (context: Uint8Array) =>
            f.control(
              1,
              new RoutedWriter("mat1").fixed(context).blob(f.flags)
                .text(f.space.did()).time(1).bytes,
            );
          if (quota === "tickets") {
            expect((await issue(f.context)).status).toBe(0);
          }
          expect(
            (await issue(
              quota === "tickets" ? f.context : new Uint8Array(16).fill(44),
            )).status,
          ).toBe(limit === null ? 0 : 1);
          expect(f.socket.readyState).toBe(1);
        } finally {
          await f.close();
        }
      }
    });
  }

  for (const op of [1, 5]) {
    for (const lifecycle of ["unopened", "closed"] as const) {
      it(`admits another space through control op ${op} with a ${lifecycle} session and disabled space quota`, async () => {
        const extra = await Identity.fromRaw(new Uint8Array(32).fill(150));
        const f = await fixture("independent-spaces", {
          limits: {
            ...disabled,
            sessionsPerContext: 1,
            spacesPerContext: null,
          },
          extraSpaces: [extra],
        });
        try {
          if (lifecycle === "closed") {
            const session = await f.open();
            expect(
              await f.request({
                type: "session.close",
                space: f.space.did(),
                sessionId: session.sessionId,
              }),
            ).toHaveProperty("ok");
          }
          const payload = new RoutedWriter(op === 1 ? "mat1" : "mas1")
            .fixed(f.context);
          if (op === 1) payload.blob(f.flags);
          expect(
            (await f.control(op, payload.text(extra.did()).time(1).bytes))
              .status,
          )
            .toBe(0);
          expect(
            await f.request({
              type: "session.open",
              space: extra.did(),
              principal: f.principal.did(),
              session: {},
            }),
          ).toHaveProperty("ok");
          expect(
            await f.request({
              type: "session.open",
              space: f.space.did(),
              principal: f.principal.did(),
              session: {},
            }),
          ).toMatchObject({ error: { retriable: true } });
          expect(f.socket.readyState).toBe(1);
        } finally {
          await f.close();
        }
      });
    }

    it(`enforces the lifetime space quota through control op ${op} independently of sessions`, async () => {
      const extra = await Identity.fromRaw(new Uint8Array(32).fill(150));
      const f = await fixture("finite-spaces", {
        limits: { ...disabled, sessionsPerContext: null, spacesPerContext: 1 },
        extraSpaces: [extra],
      });
      try {
        const session = await f.open();
        expect(
          await f.request({
            type: "session.close",
            space: f.space.did(),
            sessionId: session.sessionId,
          }),
        ).toHaveProperty("ok");
        const admit = (space: string) => {
          const payload = new RoutedWriter(op === 1 ? "mat1" : "mas1")
            .fixed(f.context);
          if (op === 1) payload.blob(f.flags);
          return f.control(op, payload.text(space).time(1).bytes);
        };
        expect((await admit(extra.did())).status).toBe(1);
        expect((await admit(f.space.did())).status).toBe(0);
        await f.open();
        await f.open();
        expect(f.socket.readyState).toBe(1);
      } finally {
        await f.close();
      }
    });
  }

  it("enforces socket capacity independently of context capacity", async () => {
    for (const limit of [2, null]) {
      const f = await fixture("socket-quota", {
        limits: { ...disabled, sockets: limit },
      });
      try {
        expect(f.host.acceptsPeer("127.0.0.1")).toBe(limit === null);
        expect(f.host.acceptsPeer("127.0.0.2")).toBe(false);
      } finally {
        await f.close();
      }
    }
  });
});

Deno.test("routed host limits are config over defaults, and must nest", () => {
  assertEquals(routedHostLimits(), DEFAULT_ROUTED_HOST_LIMITS);
  // A session's watch IDs are configuration, sized to fit one frame.
  assertEquals(routedHostLimits().watchesPerSession, 2048);
  assertEquals(
    routedHostLimits({ watchesPerSession: 40960 }).watchesPerSession,
    40960,
  );
  // The per-socket output bound is configuration too, capped at the 8 MiB
  // one message may occupy alone, which `null` leaves in force.
  assertEquals(routedHostLimits().outputBytesPerSocket, 4 * 1024 * 1024);
  assertEquals(
    routedHostLimits({ outputBytesPerSocket: ROUTED_RAW_LIMIT })
      .outputBytesPerSocket,
    ROUTED_RAW_LIMIT,
  );
  assertEquals(
    routedHostLimits({ outputBytesPerSocket: null }).outputBytesPerSocket,
    null,
  );
  // No code ceiling: far above the old 256 contexts and 64 sessions.
  assertEquals(
    routedHostLimitsFor({
      contextsPerLink: 100000,
      sockets: 100001,
      tickets: 100000,
    }, 1).contextsPerLink,
    100000,
  );
  for (
    const overrides of [
      { unknown: 1 } as unknown as Partial<RoutedHostLimits>,
      { sockets: 0 },
      { tickets: -1 },
      { watchesPerContext: 1.5 },
      { sessionsPerContext: 10000 },
      { sessionsPerRouter: 20000 },
      { holdingsPerPrincipal: 5000000 },
      // More watch IDs in one session than its context may hold.
      { watchesPerSession: 40961 },
      { principalsPerContext: 130, proofsPerContext: 300 },
      // No proof left for a remembered principal or an active one's renewal.
      { proofsPerContext: 143 },
      // A context with no ticket to open its first space with.
      { tickets: 511 },
      // A queue bound above what one message may occupy alone.
      { outputBytesPerSocket: ROUTED_RAW_LIMIT + 1 },
    ]
  ) {
    let refused = false;
    try {
      routedHostLimits(overrides);
    } catch {
      refused = true;
    }
    assert(refused, JSON.stringify(overrides));
  }
  // A limit that fails is named.
  for (
    const [overrides, field] of [
      [{ proofsPerContext: 143 }, "proofsPerContext"],
      [{ tickets: 511 }, "tickets"],
      [{ sessionsPerRouter: 20000 }, "sessionsPerRouter"],
      [{ watchesPerSession: 40961 }, "watchesPerSession"],
      [{ watchesPerContext: 2047 }, "watchesPerSession"],
      [{ outputBytesPerSocket: ROUTED_RAW_LIMIT + 1 }, "outputBytesPerSocket"],
      [{ unknownLimit: 1 }, "unknownLimit"],
    ] as [Partial<RoutedHostLimits>, string][]
  ) {
    let message = "";
    try {
      routedHostLimits(overrides);
    } catch (error) {
      message = (error as Error).message;
    }
    assertEquals(message, `invalid routed limit: ${field}`);
  }
  let named = "";
  try {
    routedHostLimitsFor({ sockets: 2 * 513 - 1 }, 2);
  } catch (error) {
    named = (error as Error).message;
  }
  assertEquals(named, "invalid routed limit: sockets");
  // The defaults fit three routers: their contexts' sockets, each link's own
  // included, and tickets at once.
  assertEquals(routedHostLimitsFor({}, 3), DEFAULT_ROUTED_HOST_LIMITS);
  for (
    const [overrides, routers] of [
      [{}, 4],
      [{}, 0],
      [{ sockets: 2 * 513 - 1 }, 2],
      [{ tickets: 2 * 512 - 1 }, 2],
    ] as [Partial<RoutedHostLimits>, number][]
  ) {
    let refused = false;
    try {
      routedHostLimitsFor(overrides, routers);
    } catch {
      refused = true;
    }
    assert(refused, JSON.stringify({ overrides, routers }));
  }
});

Deno.test("a request past a capacity limit is denied, and the context goes on", async () => {
  const watches = (prefix: string, length = 1024) =>
    Array.from(
      { length },
      (_, i) => ({ id: `${prefix}${i}`, kind: "graph", query: { roots: [] } }),
    );
  // The defaults admit more than the old 64 sessions and 1,024 watches.
  let f = await fixture("default-limits");
  try {
    const sessions = [];
    for (let i = 0; i < 70; i++) sessions.push(await f.open());
    for (const [i, session] of sessions.slice(0, 2).entries()) {
      const set = await f.request({
        type: "session.watch.set",
        space: f.space.did(),
        sessionId: session.sessionId,
        watches: watches(`w${i}-`),
      });
      assert(set.ok !== undefined, JSON.stringify(set));
    }
  } finally {
    await f.close();
  }
  f = await fixture("session-limit", { limits: { sessionsPerContext: 2 } });
  try {
    await f.open();
    await f.open();
    const third = await f.request({
      type: "session.open",
      space: f.space.did(),
      principal: f.principal.did(),
      session: {},
    });
    assertEquals(
      (third.error as { message?: string }).message,
      "Routed memory request denied",
    );
    // A capacity refusal passes, so the client holds the session.
    assertEquals((third.error as { retriable?: boolean }).retriable, true);
    // The refused request's credit comes back as an answered one's does.
    for (let i = 0; i < 100 && f.socket.credit !== ROUTER_REQUEST_WINDOW; i++) {
      await setImmediate();
    }
    assertEquals(f.socket.credit, ROUTER_REQUEST_WINDOW);
    assertEquals(f.socket.readyState, 1);
  } finally {
    await f.close();
  }
  f = await fixture("watch-limit", {
    limits: { watchesPerContext: 1500, watchesPerSession: 1500 },
  });
  try {
    const first = await f.open();
    const second = await f.open();
    assert(
      (await f.request({
        type: "session.watch.set",
        space: f.space.did(),
        sessionId: first.sessionId,
        watches: watches("a"),
      })).ok !== undefined,
    );
    assert(
      (await f.request({
        type: "session.watch.set",
        space: f.space.did(),
        sessionId: second.sessionId,
        watches: watches("b"),
      })).error !== undefined,
      "2,048 watches fit a context limited to 1,500",
    );
    // The refusal reserved nothing: 476 more still fit.
    assert(
      (await f.request({
        type: "session.watch.set",
        space: f.space.did(),
        sessionId: second.sessionId,
        watches: watches("c", 476),
      })).ok !== undefined,
    );
    assertEquals(f.socket.readyState, 1);
  } finally {
    await f.close();
  }
});

Deno.test("a request for a session revoked while it was in flight is denied, and the socket goes on", async () => {
  const f = await fixture("revoked-in-flight");
  try {
    const session = await f.open();
    // An ACL that omits the session's principal revokes the session, as a
    // genesis ACL omitting the creating key does. The router learns of it
    // from the notice, so a close it forwarded first reaches the toolshed
    // after the toolshed has dropped the session.
    const frames: Record<string, unknown>[] = [];
    const until = async (requestId: string) => {
      while (true) {
        const message =
          decodeRoutedFrame(await f.socket.take(), true, FRAME_SLOTS).body;
        frames.push(message);
        if (message.requestId === requestId) return message;
      }
    };
    f.socket.receive(
      encodeRoutedFrame(
        `fvj1:${
          JSON.stringify({
            type: "transact",
            requestId: "handover",
            space: f.space.did(),
            sessionId: session.sessionId,
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: `of:${f.space.did()}`,
                value: { value: { [f.outsider.did()]: "OWNER" } },
              }],
            },
          })
        }`,
        FRAME_SLOTS,
      ),
    );
    const committed = await until("handover");
    assert(committed.ok !== undefined, JSON.stringify(committed));
    f.socket.receive(
      encodeRoutedFrame(
        `fvj1:${
          JSON.stringify({
            type: "session.close",
            requestId: "close",
            space: f.space.did(),
            sessionId: session.sessionId,
          })
        }`,
        FRAME_SLOTS,
      ),
    );
    const closed = await until("close");
    assert(
      frames.some((frame) =>
        frame.type === "session/revoked" &&
        frame.sessionId === session.sessionId
      ),
      JSON.stringify(frames),
    );
    assertEquals(
      (closed.error as { message?: string }).message,
      "Routed memory request denied",
    );
    // The session is gone for good, so the denial is final.
    assertEquals(
      (closed.error as { retriable?: boolean }).retriable,
      undefined,
    );
    assertEquals(f.socket.readyState, 1);
    // The socket still opens sessions: the new owner's, once admitted.
    assertEquals(
      (await f.control(
        6,
        new RoutedWriter("mvp1").fixed(f.context).blob(f.flags).blob(
          await f.proof(f.outsider),
        ).bytes,
      )).status,
      0,
    );
    assert(
      (await f.request({
        type: "session.open",
        space: f.space.did(),
        principal: f.outsider.did(),
        session: {},
      })).ok !== undefined,
    );
  } finally {
    await f.close();
  }
});

Deno.test("more views than a session may hold are refused, and the socket goes on", async () => {
  setServerExecutionConfig(true);
  const f = await fixture("views");
  try {
    const session = await f.open();
    const view = (i: number) => ({
      id: `v${i}`,
      revision: 0,
      query: {
        roots: [{ id: "of:visible", selector: { path: [], schema: false } }],
      },
      mode: "speculate",
      componentContractVersion: "1",
    });
    const set = await f.request({
      type: "session.watch.set",
      space: f.space.did(),
      sessionId: session.sessionId,
      watches: [],
      views: Array.from({ length: 65 }, (_, i) => view(i)),
    });
    // A fixed bound on what a session holds: refused for good, the socket
    // open.
    assertEquals((set.error as { retriable?: boolean }).retriable, undefined);
    assertEquals(f.socket.readyState, 1);
    assert(
      (await f.request({
        type: "session.watch.set",
        space: f.space.did(),
        sessionId: session.sessionId,
        watches: [],
        views: Array.from({ length: 64 }, (_, i) => view(i)),
      })).ok !== undefined,
    );
  } finally {
    await f.close();
    resetServerExecutionConfig();
  }
});

Deno.test("a session's watch IDs are bounded by configuration, and a mutation past the bound is refused with the socket open", async (t) => {
  const watches = (prefix: string, length: number) =>
    Array.from(
      { length },
      (_, i) => ({ id: `${prefix}${i}`, kind: "graph", query: { roots: [] } }),
    );
  await t.step("the configured bound", async () => {
    const f = await fixture("watches-per-session", {
      limits: { watchesPerSession: 8 },
    });
    try {
      const session = await f.open();
      const mutate = (type: string, list: unknown[]) =>
        f.request({
          type,
          space: f.space.did(),
          sessionId: session.sessionId,
          watches: list,
        });
      assert((await mutate("session.watch.set", watches("a", 8))).ok);
      const reasons = await refusalReasons(async () => {
        // One more ID, added by a later request, and a replacement set that
        // names one more than a session may hold.
        for (
          const [type, list] of [
            ["session.watch.add", watches("b", 1)],
            ["session.watch.set", watches("c", 9)],
          ] as const
        ) {
          const refused = await mutate(type, list);
          assertEquals(
            (refused.error as { message?: string } | undefined)?.message,
            "Routed memory request denied",
            JSON.stringify(refused),
          );
          // Refused for good.
          assertEquals(
            (refused.error as { retriable?: boolean }).retriable,
            undefined,
          );
        }
      });
      assertEquals(reasons, ["frame-limit", "frame-limit"]);
      assertEquals(f.socket.readyState, 1);
      // The refusals changed nothing the session holds: an ID it already
      // has is still added, and a replacement set at the bound is taken.
      assert((await mutate("session.watch.add", watches("a", 1))).ok);
      assert((await mutate("session.watch.set", watches("d", 8))).ok);
      assertEquals(f.socket.readyState, 1);
    } finally {
      await f.close();
    }
  });
  await t.step("a removal frees room under the bound", async () => {
    const f = await fixture("watches-per-session-removal", {
      limits: { watchesPerSession: 8 },
    });
    try {
      const session = await f.open();
      const request = (type: string, fields: Record<string, unknown>) =>
        f.request({
          type,
          space: f.space.did(),
          sessionId: session.sessionId,
          ...fields,
        });
      assert(
        (await request("session.watch.set", { watches: watches("a", 8) })).ok,
      );
      const reasons = await refusalReasons(async () => {
        const refused = await request("session.watch.add", {
          watches: watches("b", 1),
        });
        assert(refused.error !== undefined, JSON.stringify(refused));
      });
      assertEquals(reasons, ["frame-limit"]);
      // Removing one ID the session holds and one it does not leaves room
      // for exactly one more.
      assert(
        (await request("session.watch.remove", { watchIds: ["a0", "z0"] })).ok,
      );
      assert(
        (await request("session.watch.add", { watches: watches("b", 1) })).ok,
      );
      const after = await refusalReasons(async () => {
        const refused = await request("session.watch.add", {
          watches: watches("c", 1),
        });
        assert(refused.error !== undefined, JSON.stringify(refused));
      });
      assertEquals(after, ["frame-limit"]);
      assertEquals(f.socket.readyState, 1);
    } finally {
      await f.close();
    }
  });
  await t.step("the default bound of 2,048, in one frame", async () => {
    const f = await fixture("watches-per-session-default");
    try {
      const session = await f.open();
      const mutate = (type: string, list: unknown[]) =>
        f.request({
          type,
          space: f.space.did(),
          sessionId: session.sessionId,
          watches: list,
        });
      // A frame's watches have no count bound of their own.
      assert((await mutate("session.watch.set", watches("a", 2048))).ok);
      const reasons = await refusalReasons(async () => {
        const refused = await mutate("session.watch.set", watches("b", 2049));
        assertEquals(
          (refused.error as { retriable?: boolean } | undefined)?.retriable,
          undefined,
          JSON.stringify(refused),
        );
        assert(refused.error !== undefined);
      });
      assertEquals(reasons, ["frame-limit"]);
      assertEquals(f.socket.readyState, 1);
    } finally {
      await f.close();
    }
  });
});

Deno.test("a session's watch mutations, resumptions and close are dispatched one at a time, each once the turn of the one before it has ended", async (t) => {
  const watches = (prefix: string, length: number) =>
    Array.from(
      { length },
      (_, i) => ({ id: `${prefix}${i}`, kind: "graph", query: { roots: [] } }),
    );
  const change = (
    f: Awaited<ReturnType<typeof fixture>>,
    session: { sessionId: string },
    type: string,
    fields: Record<string, unknown>,
  ) => ({
    type,
    space: f.space.did(),
    sessionId: session.sessionId,
    ...fields,
  });
  const admitted = (answers: Record<string, unknown>[]) =>
    answers.map((answer) => answer.error === undefined);
  await t.step("a session's changes sent together", async () => {
    // The session's own bound is the only quota, so the host keeps watch
    // mirrors and no aggregate usage.
    const f = await fixture("watches-sent-together", {
      limits: routedHostLimits({
        ...Object.fromEntries(
          Object.keys(DEFAULT_ROUTED_HOST_LIMITS).map((key) => [key, null]),
        ),
        watchesPerSession: 2,
      }),
    });
    try {
      using held = await heldTurns(f);
      const session = await held.open();
      const add = (prefix: string) =>
        change(f, session, "session.watch.add", {
          watches: watches(prefix, 1),
        });
      // All five are sent before the first is answered. Each is checked
      // against the IDs the ones before it left: the third would make three
      // and is refused, and the removal makes room for the fifth.
      let answers: Record<string, unknown>[] = [];
      const reasons = await refusalReasons(async () => {
        answers = await held.pipelined([
          add("a"),
          add("b"),
          add("c"),
          change(f, session, "session.watch.remove", { watchIds: ["a0"] }),
          add("c"),
        ]);
      });
      assertEquals(admitted(answers), [true, true, false, true, true]);
      assertEquals(reasons, ["frame-limit"]);
      // The session holds b0 and c0, as the server does.
      const after = await refusalReasons(async () => {
        assert((await held.request(add("d"))).error !== undefined);
      });
      assertEquals(after, ["frame-limit"]);
      assert((await held.request(add("b"))).ok);
    } finally {
      await f.close();
    }
  });
  await t.step(
    "a context's usage, with changes from two sessions",
    async () => {
      const f = await fixture("watches-context-sent-together", {
        limits: { watchesPerContext: 3, watchesPerSession: 2 },
      });
      try {
        using held = await heldTurns(f);
        const first = await held.open(), second = await held.open();
        const third = await held.open();
        const add = (session: { sessionId: string }, prefix: string) =>
          change(f, session, "session.watch.add", {
            watches: watches(prefix, 1),
          });
        const answered = async (bodies: Record<string, unknown>[]) => {
          let answers: Record<string, unknown>[] = [];
          const reasons = await refusalReasons(async () => {
            answers = await held.pipelined(bodies);
          });
          return { admitted: admitted(answers), reasons };
        };
        assertEquals(await answered([add(first, "a"), add(first, "b")]), {
          admitted: [true, true],
          reasons: [],
        });
        // y0 would make four in the context. Its refusal takes back its own
        // count and not x0's.
        assertEquals(await answered([add(second, "x"), add(second, "y")]), {
          admitted: [true, false],
          reasons: ["watch-limit"],
        });
        // The sessions hold a0, b0 and x0, which fill the context.
        assertEquals(await answered([add(third, "z")]), {
          admitted: [false],
          reasons: ["watch-limit"],
        });
        // Removing a0 makes room for c0 and no more.
        assertEquals(
          await answered([
            change(f, first, "session.watch.remove", { watchIds: ["a0"] }),
            add(first, "c"),
            add(second, "y"),
          ]),
          { admitted: [true, true, false], reasons: ["watch-limit"] },
        );
      } finally {
        await f.close();
      }
    },
  );
  await t.step("a resumption and a watch change on one session", async () => {
    const f = await fixture("watches-resumed", {
      limits: { watchesPerContext: 3, watchesPerSession: 2 },
    });
    try {
      using held = await heldTurns(f);
      const session = await held.open(), other = await held.open();
      const add = (target: { sessionId: string }, prefix: string) =>
        change(f, target, "session.watch.add", {
          watches: watches(prefix, 1),
        });
      const resume = (token: string) => ({
        type: "session.open",
        space: f.space.did(),
        principal: f.principal.did(),
        session: { sessionId: session.sessionId, sessionToken: token },
      });
      assert((await held.request(add(session, "x"))).ok);
      assert((await held.request(add(other, "o"))).ok);
      // The resumption waits for y0's answer, and so counts x0 and y0: the
      // context is then full.
      const [y, resumed] = held.send([
        add(session, "y"),
        resume(session.sessionToken),
      ]);
      assert(await held.dispatched(y));
      assert(!await held.dispatched(resumed));
      const [yAnswer, resumedAnswer] = await held.settle([y, resumed]);
      assert(yAnswer.ok, JSON.stringify(yAnswer));
      assert(resumedAnswer.ok, JSON.stringify(resumedAnswer));
      assertEquals(
        await refusalReasons(async () => {
          assert((await held.request(add(other, "w"))).error !== undefined);
        }),
        ["watch-limit"],
      );
      // A removal sent behind a second resumption waits for it, and then
      // leaves room for p0.
      const [again, removal] = held.send([
        resume((resumedAnswer.ok as { sessionToken: string }).sessionToken),
        change(f, session, "session.watch.remove", { watchIds: ["y0"] }),
      ]);
      assert(await held.dispatched(again));
      assert(!await held.dispatched(removal));
      const answers = await held.settle([again, removal]);
      assert(answers.every((answer) => answer.ok), JSON.stringify(answers));
      assert((await held.request(add(other, "p"))).ok);
    } finally {
      await f.close();
    }
  });
  await t.step("a failed resumption and a watch change behind it", async () => {
    const f = await fixture("watches-failed-resumption", {
      limits: { watchesPerContext: 3, watchesPerSession: 2 },
    });
    try {
      using held = await heldTurns(f);
      const session = await held.open(), other = await held.open();
      const add = (target: { sessionId: string }, prefix: string) =>
        change(f, target, "session.watch.add", {
          watches: watches(prefix, 1),
        });
      assert((await held.request(add(session, "x"))).ok);
      assert((await held.request(add(other, "o"))).ok);
      // The server refuses the resumption, whose token is not the session's,
      // and the session stays open. y0 waits for that refusal, so the usage
      // the refusal restores is not counted over y0's: the context is full.
      const [resumed, y] = held.send([
        {
          type: "session.open",
          space: f.space.did(),
          principal: f.principal.did(),
          session: {
            sessionId: session.sessionId,
            sessionToken: "invalid-resume-token",
          },
        },
        add(session, "y"),
      ]);
      assert(await held.dispatched(resumed));
      assert(!await held.dispatched(y));
      const [resumedAnswer, yAnswer] = await held.settle([resumed, y]);
      assert(resumedAnswer.error !== undefined, JSON.stringify(resumedAnswer));
      assert(yAnswer.ok, JSON.stringify(yAnswer));
      assertEquals(
        await refusalReasons(async () => {
          assert((await held.request(add(other, "w"))).error !== undefined);
        }),
        ["watch-limit"],
      );
    } finally {
      await f.close();
    }
  });
});

Deno.test("holdings and views named on a watch add leave a session's counted usage as it was", async () => {
  setServerExecutionConfig(true);
  // Two views and four holdings are all the context may hold of each.
  const f = await fixture("add-names-watches", {
    limits: {
      watchesPerContext: 2,
      watchesPerSession: 2,
      holdingsPerContext: 4,
    },
  });
  const view = (i: number) => ({
    id: `v${i}`,
    revision: 0,
    query: {
      roots: [{ id: "of:visible", selector: { path: [], schema: false } }],
    },
    mode: "speculate",
    componentContractVersion: "1",
  });
  const holdings = (length: number) =>
    Array.from({ length }, (_, i) => ({ id: `of:h${i}`, seq: 0 }));
  try {
    const space = f.space.did();
    const first = await f.open(), second = await f.open();
    const filled = await f.request({
      type: "session.watch.set",
      space,
      sessionId: first.sessionId,
      watches: [],
      views: [view(0), view(1)],
      holdings: holdings(4),
    });
    assert(filled.ok !== undefined, JSON.stringify(filled));
    // The Memory server reads only `watches` from an add, so this one
    // changes nothing the first session holds.
    const added = await f.request({
      type: "session.watch.add",
      space,
      sessionId: first.sessionId,
      watches: [],
      views: [],
      holdings: [],
    });
    assert(added.ok !== undefined, JSON.stringify(added));
    assertEquals(f.server.viewInterestsForSpace(space).length, 2);
    // The context is still full: the second session is refused one watch
    // and one holding.
    const reasons = await refusalReasons(async () => {
      for (
        const fields of [
          { watches: [{ id: "w", kind: "graph", query: { roots: [] } }] },
          { watches: [], holdings: holdings(1) },
        ]
      ) {
        const refused = await f.request({
          type: "session.watch.set",
          space,
          sessionId: second.sessionId,
          ...fields,
        });
        assertEquals(
          (refused.error as { retriable?: boolean } | undefined)?.retriable,
          true,
          JSON.stringify(refused),
        );
      }
    });
    assertEquals(reasons, ["watch-limit", "holdings-limit"]);
    assertEquals(f.socket.readyState, 1);
  } finally {
    await f.close();
    resetServerExecutionConfig();
  }
});

Deno.test("holdings and views are counted as lists, and anything else closes the socket", async (t) => {
  const holding = (i: number) => ({ id: `of:h${i}`, seq: 0 });
  const holdings = (length: number) =>
    Array.from({ length }, (_, i) => holding(i));
  const view = (i: number) => ({
    id: `v${i}`,
    revision: 0,
    query: {
      roots: [{ id: "of:visible", selector: { path: [], schema: false } }],
    },
    mode: "speculate",
    componentContractVersion: "1",
  });
  const limits = { holdingsPerContext: 4 };
  await t.step("a list over the context's holdings is refused", async () => {
    const f = await fixture("listed-holdings", { limits });
    try {
      const open = (list: unknown[]) =>
        f.request({
          type: "session.open",
          space: f.space.did(),
          principal: f.principal.did(),
          session: {},
          holdings: list,
        });
      const reasons = await refusalReasons(async () => {
        const refused = await open(holdings(5));
        assertEquals(
          (refused.error as { retriable?: boolean }).retriable,
          true,
        );
        const session = await f.open();
        const set = await f.request({
          type: "session.watch.set",
          space: f.space.did(),
          sessionId: session.sessionId,
          watches: [],
          holdings: holdings(5),
        });
        assertEquals((set.error as { retriable?: boolean }).retriable, true);
      });
      assertEquals(reasons, ["holdings-limit", "holdings-limit"]);
      // The refusals reserved nothing: four holdings still fit.
      assert((await open(holdings(4))).ok !== undefined);
      assertEquals(f.socket.readyState, 1);
    } finally {
      await f.close();
    }
  });
  // The frame parser admits a record under `holdings` and does not look at
  // `views`. The Memory server decodes a record tagged `/quote` into the
  // list it wraps, so a record's members are not what the server would
  // count; a record has no `length`, and one read as a list made the
  // toolshed's totals NaN, which no limit compares against.
  for (
    const [name, type, fields] of [
      ["a record of holdings on an open", "session.open", {
        holdings: { a: holding(0), b: holding(1) },
      }],
      ["a quoted list of holdings on a watch set", "session.watch.set", {
        holdings: { "/quote": holdings(5) },
      }],
      ["a record with a length on a watch set", "session.watch.set", {
        holdings: { length: -5 },
      }],
      ["a quoted list of views on a watch set", "session.watch.set", {
        views: { "/quote": Array.from({ length: 65 }, (_, i) => view(i)) },
      }],
      ["a number for views on a watch add", "session.watch.add", {
        views: 3,
      }],
    ] as const
  ) {
    await t.step(`${name} closes the socket`, async () => {
      const f = await fixture("not-a-list", { limits });
      try {
        const session = await f.open();
        f.socket.receive(
          encodeRoutedFrame(
            `fvj1:${
              JSON.stringify({
                type,
                requestId: "not-a-list",
                space: f.space.did(),
                ...(type === "session.open"
                  ? { principal: f.principal.did(), session: {} }
                  : { sessionId: session.sessionId, watches: [] }),
                ...fields,
              })
            }`,
            FRAME_SLOTS,
          ),
        );
        assertEquals(await frameOrClose(f.socket), "closed");
        assertEquals(f.link.readyState, 1);
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test("the toolshed admits a frame at its configured slot cap and closes on one more", async () => {
  // The hello, flags included, and a session.open are well under 64 slots.
  const f = await fixture("frame-slots", { limits: { frameSlots: 64 } });
  try {
    const session = await f.open();
    // One slot per value, keys free, as the router counts.
    const countValues = (value: unknown): number =>
      1 +
      (value !== null && typeof value === "object"
        ? Object.values(value).reduce(
          (total: number, member) => total + countValues(member),
          0,
        )
        : 0);
    const transact = (requestId: string, slots: number) => {
      const body = {
        type: "transact",
        requestId,
        space: f.space.did(),
        sessionId: session.sessionId,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: `of:pad-${requestId}`,
            value: { value: [] as number[] },
          }],
        },
      };
      body.commit.operations[0].value.value = Array(slots - countValues(body))
        .fill(0);
      assertEquals(countValues(body), slots);
      return encodeRoutedFrame(`fvj1:${JSON.stringify(body)}`, FRAME_SLOTS);
    };
    // At the cap the request is answered, whatever its verdict, and the
    // socket stays open.
    f.socket.receive(transact("exact", 64));
    while (true) {
      const message =
        decodeRoutedFrame(await f.socket.take(), true, FRAME_SLOTS)
          .body;
      if (message.requestId === "exact") break;
    }
    assertEquals(f.socket.readyState, 1);
    // One value more closes the socket, as the router closes on a frame over
    // its `max_frame_slots`; the link is untouched.
    f.socket.receive(transact("over", 65));
    await f.socket.closed.promise;
    assertEquals(f.link.readyState, 1);
  } finally {
    await f.close();
  }
});

Deno.test("the toolshed accepts and acknowledges a large commit with a null slot cap", async () => {
  const f = await fixture("disabled-frame-slots", {
    limits: { frameSlots: null },
  });
  try {
    const session = await f.open();
    const values = Array.from({ length: 160_000 }, (_, index) => index);
    const payload = `fvj1:${
      JSON.stringify({
        type: "transact",
        requestId: "large-commit",
        space: f.space.did(),
        sessionId: session.sessionId,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "set", id: "of:large", value: { value: values } }],
        },
      })
    }`;
    expect(() => decodeRoutedFrame(payload, false, FRAME_SLOTS)).toThrow();
    const records = routerRecords(
      routerRoute(decodeRoutedFrame(payload, false, null).body),
      payload,
    );
    await f.socket.header(decodeRouterHeader(records.next().value!));
    for (const record of records) f.socket.deliver(record);
    for (;;) {
      const response =
        decodeRoutedFrame(await f.socket.take(), true, null).body;
      if (response.requestId !== "large-commit") continue;
      expect(response.error).toBeUndefined();
      expect(response.ok).toMatchObject({
        revisions: [{ id: "of:large", document: { value: values } }],
      });
      break;
    }
    expect(f.socket.readyState).toBe(1);
    expect(f.link.readyState).toBe(1);
  } finally {
    await f.close();
  }
});

Deno.test("a refusal that cannot be answered closes only its socket", async () => {
  const f = await fixture("refusal-output-bound");
  try {
    await f.open();
    // The output queue is full, so the answer to a refused close cannot be
    // queued: the socket closes, and nothing escapes as an unhandled error.
    f.socket.bufferedAmount = 4 * 1024 * 1024;
    f.socket.receive(
      encodeRoutedFrame(
        `fvj1:${
          JSON.stringify({
            type: "session.close",
            requestId: "gone",
            space: f.space.did(),
            sessionId: "no-such-session",
          })
        }`,
        FRAME_SLOTS,
      ),
    );
    await f.socket.closed.promise;
    assertEquals(f.link.readyState, 1);
  } finally {
    await f.close();
  }
});

Deno.test("an open whose grant expired in flight is refused for now, a released principal's for good", async () => {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const f = await fixture("grant-crossed", { clock });
  try {
    const open = () =>
      f.request({
        type: "session.open",
        space: f.space.did(),
        principal: f.principal.did(),
        session: {},
      });
    clock.now += 601;
    // Another principal's proof prunes the context's history; the expired
    // principal was not released, so it stays, and its open waits for a new
    // signature instead of being refused for good.
    assertEquals(
      (await f.control(
        6,
        new RoutedWriter("mvp1").fixed(f.context).blob(f.flags).blob(
          await f.proof(f.outsider),
        ).bytes,
      )).status,
      0,
    );
    const expired = await open();
    assertEquals((expired.error as { retriable?: boolean }).retriable, true);
    assertEquals(f.socket.readyState, 1);
    // Signed again, the principal opens on the same socket.
    assertEquals(
      (await f.control(
        6,
        new RoutedWriter("mvp1").fixed(f.context).blob(f.flags).blob(
          await f.proof(f.principal),
        ).bytes,
      )).status,
      0,
    );
    assert((await open()).ok !== undefined);
    assertEquals(
      (await f.control(
        4,
        new RoutedWriter("mrl1").fixed(f.context).text(f.principal.did()).bytes,
      )).status,
      0,
    );
    const released = await open();
    assert(released.error !== undefined);
    assertEquals(
      (released.error as { retriable?: boolean }).retriable,
      undefined,
    );
    assertEquals(f.socket.readyState, 1);
  } finally {
    await f.close();
  }
});

Deno.test("a principal's session limit refuses one open and undoes its reservation", async () => {
  const f = await fixture("principal-sessions", {
    limits: { sessionsPerPrincipal: 2 },
  });
  try {
    const first = await f.open();
    await f.open();
    const third = await f.request({
      type: "session.open",
      space: f.space.did(),
      principal: f.principal.did(),
      session: {},
    });
    assertEquals((third.error as { retriable?: boolean }).retriable, true);
    // The refused open reserved nothing: once one session closes, another
    // fits.
    assert(
      (await f.request({
        type: "session.close",
        space: f.space.did(),
        sessionId: first.sessionId,
      })).ok !== undefined,
    );
    await f.open();
    assertEquals(f.socket.readyState, 1);
  } finally {
    await f.close();
  }
});

Deno.test("a released principal leaves the history once its statement expires", async () => {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const f = await fixture("released-history", {
    clock,
    limits: {
      principalsPerContext: 2,
      principalHistoryPerContext: 2,
      proofsPerContext: 4,
    },
  });
  try {
    const admit = async (signer: Identity, seconds = 600) =>
      (await f.control(
        6,
        new RoutedWriter("mvp1").fixed(f.context).blob(f.flags).blob(
          await f.proof(signer, seconds),
        ).bytes,
      )).status;
    // The fixture's principal is released; the outsider fills the history.
    assertEquals(
      (await f.control(
        4,
        new RoutedWriter("mrl1").fixed(f.context).text(f.principal.did()).bytes,
      )).status,
      0,
    );
    // The outsider's statement outlives the released principal's.
    clock.now += 300;
    assertEquals(await admit(f.outsider), 0);
    // Once the released principal's statement expires, it no longer counts.
    clock.now += 301;
    assertEquals(await admit(f.space), 0);
  } finally {
    await f.close();
  }
});

Deno.test("a closed context's tickets leave with it", async () => {
  // Two tickets in all, and the fixture's own was redeemed, so the third
  // passing context is issued one only if the toolshed removed the tickets
  // of the two before it.
  const f = await fixture("ticket-close", {
    limits: { contextsPerLink: 2, sockets: 3, tickets: 2 },
  });
  try {
    for (let i = 0; i < 4; i++) {
      const ctx = new Uint8Array(16).fill(80 + i);
      assertEquals(
        (await f.control(
          1,
          new RoutedWriter("mat1").fixed(ctx).blob(f.flags).text(f.space.did())
            .time(1).bytes,
        )).status,
        0,
        `ticket ${i}`,
      );
      assertEquals((await f.control(3, ctx)).status, 0);
    }
  } finally {
    await f.close();
  }
});

Deno.test("a redeemed ticket no longer counts against the ticket limit, however many data sockets a context opens", async () => {
  // Two tickets in all. The fixture's context redeemed one for its first
  // data socket, and redeems one more for each socket that replaces it.
  const f = await fixture("ticket-redeem", {
    limits: { contextsPerLink: 2, tickets: 2 },
  });
  try {
    let socket = f.socket;
    for (let i = 0; i < 5; i++) {
      const next = await f.dataSocket(await f.issueTicket());
      assertEquals(await frameOrClose(next), "hello.ok");
      // The new socket replaced the one before it.
      await socket.closed.promise;
      socket = next;
    }
    assertEquals(f.link.readyState, 1);
  } finally {
    await f.close();
  }
});

Deno.test("two sockets presenting one ticket at once redeem it once", async () => {
  const f = await fixture("ticket-race");
  try {
    const ticket = await f.issueTicket();
    const first = await f.socketBeforeHello(ticket),
      second = await f.socketBeforeHello(ticket);
    // Both hellos are checked before either binding's signature is
    // verified, so both find the ticket live; only one may consume it.
    first.socket.receive(first.hello);
    second.socket.receive(second.hello);
    const outcomes = await Promise.all([
      frameOrClose(first.socket),
      frameOrClose(second.socket),
    ]);
    assertEquals(outcomes.toSorted(), ["closed", "hello.ok"]);
    const winner = outcomes[0] === "hello.ok" ? first.socket : second.socket;
    assertEquals(winner.readyState, 1);
    // Redeemed, the ticket admits no proof and no third socket.
    assertEquals(
      (await f.control(
        2,
        new RoutedWriter("map1").fixed(ticket).blob(f.evidence).bytes,
      )).status,
      1,
    );
    assertEquals(await frameOrClose(await f.dataSocket(ticket)), "closed");
    assertEquals(winner.readyState, 1);
  } finally {
    await f.close();
  }
});

Deno.test("connections that come and go cannot fill the ledger or refuse a live context's proofs", async () => {
  // Before a context's proofs left with it, each passing context's stayed
  // in the ledger until they expired, so cycling connections filled it.
  const f = await fixture("cycling", {
    limits: { contextsPerLink: 2, sockets: 3, tickets: 2 },
  });
  try {
    const ledger = `${f.root}/ledger`, size = Deno.statSync(ledger).size;
    for (let i = 0; i < 200; i++) {
      const ctx = new Uint8Array(16);
      ctx[0] = 60, ctx[1] = i;
      assertEquals(
        (await f.control(
          6,
          new RoutedWriter("mvp1").fixed(ctx).blob(f.flags).blob(
            await f.proof(f.outsider, 600, ctx),
          ).bytes,
        )).status,
        0,
      );
      assertEquals((await f.control(3, ctx)).status, 0);
    }
    // Nothing a context accepts is written down.
    assertEquals(Deno.statSync(ledger).size, size);
    assertEquals(
      (await f.control(
        6,
        new RoutedWriter("mvp1").fixed(f.context).blob(f.flags).blob(
          await f.proof(f.principal),
        ).bytes,
      )).status,
      0,
    );
    assertEquals(f.socket.readyState, 1);
  } finally {
    await f.close();
  }
});

Deno.test("a statement serves one live context; after it closes, the router may present it again within its lease, by design", async () => {
  const f = await fixture("one-live-context");
  try {
    const admit = async (ctx: Uint8Array<ArrayBuffer>, statement: Uint8Array) =>
      (await f.control(
        6,
        new RoutedWriter("mvp1").fixed(ctx).blob(f.flags).blob(
          await f.attest(statement, ctx),
        ).bytes,
      )).status;
    const first = new Uint8Array(16).fill(61),
      second = new Uint8Array(16).fill(62),
      third = new Uint8Array(16).fill(63);
    const proof = readRoutedProof(await f.proof(f.outsider, 600, first));
    assertEquals(await admit(first, proof.statement), 0);
    // While the first context lives, no other context may hold it.
    assertEquals(await admit(second, proof.statement), 1);
    assertEquals(await admit(first, proof.statement), 0);
    // Once it closes its statements leave with it, so a new context may be
    // given the same statement until it expires. A compromised router could
    // keep the first context open for that long anyway.
    assertEquals((await f.control(3, first)).status, 0);
    assertEquals(await admit(third, proof.statement), 0);
  } finally {
    await f.close();
  }
});

Deno.test("a released principal's statement cannot admit it again while its context lives", async () => {
  const f = await fixture("released-statement");
  try {
    const ctx = new Uint8Array(16).fill(64);
    const proof = await f.proof(f.outsider, 600, ctx);
    const admit = async () =>
      (await f.control(
        6,
        new RoutedWriter("mvp1").fixed(ctx).blob(f.flags).blob(proof).bytes,
      )).status;
    assertEquals(await admit(), 0);
    assertEquals(
      (await f.control(
        4,
        new RoutedWriter("mrl1").fixed(ctx).text(f.outsider.did()).bytes,
      )).status,
      0,
    );
    assertEquals(await admit(), 1);
  } finally {
    await f.close();
  }
});
Deno.test("one context holds at most its quota of unexpired proofs", async () => {
  const f = await fixture("proof-quota", {
    limits: {
      principalsPerContext: 2,
      principalHistoryPerContext: 2,
      proofsPerContext: 4,
      contextsPerLink: 2,
      sockets: 3,
    },
  });
  try {
    const admit = (proof: Uint8Array) =>
      new RoutedWriter("mvp1").fixed(f.context).blob(f.flags).blob(proof).bytes;
    // The fixture's own proof is the first; a second principal and a renewal
    // of each fill the context's four.
    for (const signer of [f.outsider, f.principal, f.outsider]) {
      assertEquals(
        (await f.control(6, admit(await f.proof(signer)))).status,
        0,
      );
    }
    assertEquals(
      (await f.control(6, admit(await f.proof(f.principal)))).status,
      1,
      "a fifth proof exceeded the context's four",
    );
  } finally {
    await f.close();
  }
});

Deno.test("a routed toolshed serves either cell representation, and refuses a client at the other", async () => {
  for (const modernCellRep of [false, true]) {
    for (const clientModernCellRep of [false, true]) {
      const f = await fixture(
        `cell-rep-${modernCellRep}-${clientModernCellRep}`,
        {
          modernCellRep,
          clientModernCellRep,
        },
      );
      try {
        if (modernCellRep === clientModernCellRep) {
          await f.open();
          continue;
        }
        expect(f.socket.readyState).toBe(WebSocket.CLOSED);
        expect(f.greeted.type).toBe("closed");
        expect(f.link.readyState).toBe(WebSocket.OPEN);
      } finally {
        await f.close();
      }
    }
  }
  setModernCellRepConfig(true);
});

Deno.test("a client without stableExpressionResultIds reaches a data socket, and the toolshed refuses each of its session opens for good", async () => {
  // The router no longer refuses the flag's absence: the context, its ticket
  // and the data socket are all granted, and the toolshed answers every
  // `session.open` with the final refusal, which the SDK treats as terminal
  // for the session (04-protocol.md, routed-mode-a.md).
  const f = await fixture("stable-ids-absent", {
    clientFlags: { stableExpressionResultIds: undefined },
  });
  try {
    expect(Object.hasOwn(f.encodingFlags, "stableExpressionResultIds")).toBe(
      false,
    );
    expect(f.greeted.type).toBe("hello.ok");
    for (let attempt = 0; attempt < 2; attempt++) {
      const message = await f.request({
        type: "session.open",
        space: f.space.did(),
        principal: f.principal.did(),
        session: {},
      });
      expect(message.ok).toBeUndefined();
      expect(message.error).toMatchObject({
        name: "SessionRevokedError",
        message: expect.stringContaining(
          "incompatible expression result identities",
        ),
      });
    }
    expect(f.socket.readyState).toBe(WebSocket.OPEN);
    expect(f.link.readyState).toBe(WebSocket.OPEN);
  } finally {
    await f.close();
  }
});

Deno.test("a routed connection is not sent session/admissible when a grant admits a refused principal", async () => {
  const f = await fixture("admission-notice");
  try {
    // Both peers advertise the capability, so only the routed connection
    // keeps the server from recording the refusal.
    assertEquals(f.server.memoryProtocolFlags().admissionNotice, true);
    const session = await f.open();
    const admit = (proof: Uint8Array) =>
      new RoutedWriter("mvp1").fixed(f.context).blob(f.flags).blob(proof).bytes;
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
    const frames: Record<string, unknown>[] = [];
    const until = async (requestId: string) => {
      while (true) {
        const message =
          decodeRoutedFrame(await f.socket.take(), true, FRAME_SLOTS).body;
        frames.push(message);
        if (message.requestId === requestId) return message;
      }
    };
    f.socket.receive(
      encodeRoutedFrame(
        `fvj1:${
          JSON.stringify({
            type: "transact",
            requestId: "grant",
            space: f.space.did(),
            sessionId: session.sessionId,
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: `of:${f.space.did()}`,
                value: {
                  value: {
                    [f.principal.did()]: "OWNER",
                    [f.outsider.did()]: "READ",
                  },
                },
              }],
            },
          })
        }`,
        FRAME_SLOTS,
      ),
    );
    const granted = await until("grant");
    assert(granted.ok !== undefined, JSON.stringify(granted));
    // A later request's response follows anything the grant sent.
    f.socket.receive(
      encodeRoutedFrame(
        `fvj1:${
          JSON.stringify({
            type: "memory.compression",
            requestId: "after",
            enabled: false,
          })
        }`,
        FRAME_SLOTS,
      ),
    );
    await until("after");
    assertEquals(
      frames.filter((frame) => frame.type === "session/admissible"),
      [],
    );
    // The grant took effect: the outsider now opens through ordinary
    // admission, which is how a routed client learns of it.
    assert(
      (await f.request({
        type: "session.open",
        space: f.space.did(),
        principal: f.outsider.did(),
        session: {},
      })).ok !== undefined,
    );
  } finally {
    await f.close();
  }
});

Deno.test("omitted views retain their quota across watch replacements and resume", async () => {
  setServerExecutionConfig(true);
  // Sixteen sessions of 64 views fill a context limited to 1,024 watches.
  const f = await fixture("retained-views", {
    limits: { watchesPerContext: 1024, watchesPerSession: 1024 },
  });
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
          session: { ...session, sessionToken: "invalid-resume-token" },
        })).error !== undefined,
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
    // The retained views fill the context's watches, so one more set of
    // them is denied while the socket and link go on.
    const overflow = await f.open();
    assert(
      (await f.request({
        type: "session.watch.set",
        space: f.space.did(),
        sessionId: overflow.sessionId,
        watches: [],
        views,
      })).error !== undefined,
    );
    assertEquals(f.socket.readyState, 1);
    assertEquals(f.link.readyState, 1);
  } finally {
    await f.close();
    resetServerExecutionConfig();
  }
});

Deno.test("rejected view mutations leave no persistent quota reservation", async () => {
  setServerExecutionConfig(true);
  const f = await fixture("rejected-views");
  try {
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
    // Reject after wire parsing, so the backend responds to the actual request.
    setServerExecutionConfig(false);
    for (let i = 0; i < 16; i++) {
      const session = await f.open();
      assert(
        (await f.request({
          type: "session.watch.set",
          space: f.space.did(),
          sessionId: session.sessionId,
          watches: [],
          views,
        })).error !== undefined,
      );
    }
    assertEquals(f.server.viewInterestsForSpace(f.space.did()), []);
    const session = await f.open();
    setServerExecutionConfig(true);
    assert(
      (await f.request({
        type: "session.watch.set",
        space: f.space.did(),
        sessionId: session.sessionId,
        watches: [],
        views,
      })).ok !== undefined,
    );
    assertEquals(f.server.viewInterestsForSpace(f.space.did()).length, 64);
  } finally {
    await f.close();
    resetServerExecutionConfig();
  }
});

Deno.test("revocation before a failed resume response cannot restore phantom quotas", async () => {
  setServerExecutionConfig(true);
  const f = await fixture("revoked-resume");
  try {
    const session = await f.open();
    assert(
      (await f.request({
        type: "session.watch.set",
        space: f.space.did(),
        sessionId: session.sessionId,
        watches: [],
        views: Array.from(
          { length: 64 },
          (_, i) => ({
            id: `v${i}`,
            revision: 0,
            query: {
              roots: [{
                id: "of:visible",
                selector: { path: [], schema: false },
              }],
            },
            mode: "speculate",
            componentContractVersion: "1",
          }),
        ),
      })).ok !== undefined,
    );
    // Force the backend's lifecycle push before its refused resume verdict.
    {
      using _open = stub(f.server, "openSession", (request, connection) => {
        connection.revokeSession(
          f.space.did(),
          session.sessionId,
          "unauthorized",
        );
        return Promise.resolve({
          type: "response",
          requestId: request.requestId,
          error: {
            name: "SessionRevokedError",
            message: "Revoked while opening",
          },
        });
      });
      assert(
        (await f.request({
          type: "session.open",
          space: f.space.did(),
          principal: f.principal.did(),
          session,
        })).error !== undefined,
      );
    }
    const fresh = await f.open();
    assert(
      (await f.request({
        type: "session.watch.set",
        space: f.space.did(),
        sessionId: fresh.sessionId,
        watches: Array.from(
          { length: 1024 },
          (_, i) => ({ id: `fresh${i}`, kind: "graph", query: { roots: [] } }),
        ),
      })).ok !== undefined,
    );
    assertEquals(f.socket.readyState, 1);
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

describe("private routed stream admission", () => {
  for (
    const field of [
      "type",
      "requestId",
      "space",
      "principal",
      "session",
      "sessionId",
    ]
  ) {
    it(`closes a mismatched \`${field}\` header without opening a backend session`, async () => {
      const f = await fixture(`header-mismatch-${field}`);
      using opened = spy(f.server, "openSession");
      try {
        const session = await f.open();
        expect(opened.calls).toHaveLength(1);
        const body = {
          type: "session.open",
          requestId: "mismatch",
          space: f.space.did(),
          principal: f.principal.did(),
          session,
        };
        const route = routerRoute(body);
        route[field] = field === "type"
          ? "session.close"
          : field === "space" || field === "principal"
          ? f.outsider.did()
          : field === "session"
          ? { sessionId: "other-session" }
          : "other-request";
        const records = routerRecords(route, `fvj1:${JSON.stringify(body)}`);
        await f.socket.header(decodeRouterHeader(records.next().value!));
        for (const record of records) {
          f.socket.deliver(record);
        }
        await f.socket.closed.promise;
        expect(opened.calls).toHaveLength(1);
        expect(f.link.readyState).toBe(1);
      } finally {
        await f.close();
      }
    });
  }

  for (const ending of ["short-body", "missing-end"] as const) {
    it(`leaves the backend untouched after a \`${ending}\` transaction stream`, async () => {
      const f = await fixture(`truncated-${ending}`);
      using transacted = spy(f.server, "transact");
      try {
        const session = await f.open();
        const body = {
          type: "transact",
          space: f.space.did(),
          sessionId: session.sessionId,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:streamed-transaction",
              value: { value: "complete" },
            }],
          },
        };
        expect(await f.request(body)).toHaveProperty("ok");
        expect(transacted.calls).toHaveLength(1);
        const incomplete = {
          ...body,
          requestId: "incomplete",
          commit: {
            ...body.commit,
            localSeq: 2,
            operations: [{
              op: "set",
              id: "of:streamed-transaction",
              value: { value: "incomplete" },
            }],
          },
        };
        const bytes = new TextEncoder().encode(
          `fvj1:${JSON.stringify(incomplete)}`,
        );
        await f.socket.header({
          route: routerRoute(incomplete),
          bytes: bytes.length,
          binary: false,
        });
        f.socket.deliver(routerRecord(
          1,
          ending === "short-body" ? bytes.subarray(0, -1) : bytes,
        ));
        // A task boundary drains the host's promise chain before close can
        // cancel an incorrectly delivered request.
        await new Promise<void>((resolve) => {
          const { port1, port2 } = new MessageChannel();
          port1.onmessage = () => {
            port1.close();
            port2.close();
            resolve();
          };
          port2.postMessage(null);
        });
        expect(transacted.calls).toHaveLength(1);
        if (ending === "short-body") f.socket.deliver(routerRecord(2));
        else f.socket.close();
        await f.socket.closed.promise;
        await f.server.idle();
        expect(transacted.calls).toHaveLength(1);
        expect(f.link.readyState).toBe(1);
      } finally {
        await f.close();
      }
    });
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

/** A response whose encoded frame is exactly `bytes` long. */
function sizedResponse(requestId: string, bytes: number): ServerMessage {
  const base = encodeMemoryBoundary({ type: "response", requestId, ok: "" });
  return {
    type: "response",
    requestId,
    ok: "x".repeat(bytes - new TextEncoder().encode(base).length),
  };
}

/** Creates a routed connection whose request producer is controlled by a test. */
async function routedRequestFixture(
  name: string,
  handle: (
    requestId: string,
    send: (message: ServerMessage) => void,
  ) => void | Promise<void>,
  limits?: Partial<RoutedHostLimits>,
) {
  const f = await fixture(name, { limits });
  const disposables = new DisposableStack();
  const handled: string[] = [];
  const connect = f.server.connectRouted.bind(f.server);
  try {
    disposables.use(stub(f.server, "connectRouted", (send, ...args) => {
      const backend = connect(send, ...args);
      const receive = backend.receive.bind(backend);
      disposables.use(stub(backend, "receive", async (payload) => {
        const body = decodeRoutedFrame(payload, true, FRAME_SLOTS).body;
        if (body.type === "hello") {
          await receive(payload);
          return;
        }
        assert(typeof body.requestId === "string");
        handled.push(body.requestId);
        await handle(body.requestId, send);
      }));
      return backend;
    }));
    const socket = await f.dataSocket(await f.issueTicket());
    await socket.take();
    const request = (requestId: string) =>
      encodeMemoryBoundary({
        type: "session.open",
        requestId,
        space: f.space.did(),
        principal: f.principal.did(),
        session: {},
      });
    return {
      ...f,
      socket,
      handled,
      request,
      close: async () => {
        try {
          await f.close();
        } finally {
          disposables.dispose();
        }
      },
    };
  } catch (error) {
    await f.close();
    disposables.dispose();
    throw error;
  }
}

describe("routed encoding handshake", () => {
  it("accepts two bounded descriptors whose combined value count exceeds 256", async () => {
    const futureSets = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        `futureSet${i}`,
        [..."abcdefghijklmnop"],
      ]),
    );
    const f = await fixture("encoding-many-values", {
      serverFlags: { syncLabelTableV1: true, ...futureSets },
    });
    try {
      expect(f.encodingFlags).toMatchObject(futureSets);
      expect(f.greeted.type).toBe("hello.ok");
      expect(f.flags.byteLength).toBeLessThanOrEqual(2048);
      expect(routedFlags(f.encodingFlags).byteLength).toBeLessThanOrEqual(2048);
      await f.open();
    } finally {
      await f.close();
    }
  });

  for (const enabled of [false, true]) {
    it(`uses the effective label-table capability \`${enabled}\` with an originally capable client`, async () => {
      const f = await fixture(`encoding-labels-${enabled}`, {
        serverFlags: { syncLabelTableV1: true },
        negotiatedFlags: {
          syncLabelTableV1: enabled,
          syncSchemaTableV2: false,
        },
      });
      try {
        expect(JSON.parse(new TextDecoder().decode(f.flags)).syncLabelTableV1)
          .toBe(true);
        expect(f.encodingFlags.syncLabelTableV1).toBe(enabled);
        const session = await f.open();
        const doc = {
          value: { flavor: "chocolate" },
          cfc: {
            version: 1,
            schemaHash: taggedHashStringOf(true),
            labelMap: {
              version: 1,
              entries: Array.from({ length: 17 }, (_, i) => ({
                path: ["flavor", "ingredients", "chocolate", String(i % 2)],
                label: {
                  confidentiality: ["donut-secret", "chocolate-recipe"],
                  integrity: [],
                },
              })),
            },
          },
        };
        const written = await f.request({
          type: "transact",
          space: f.space.did(),
          sessionId: session.sessionId,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "set", id: "of:donuts", value: doc }, {
              op: "set",
              id: `cid:${taggedHashStringOf(true)}`,
              value: { value: true },
            }],
          },
        });
        expect(written.error).toBeUndefined();
        expect(written).toHaveProperty("ok");
        const response = await f.request({
          type: "session.watch.add",
          space: f.space.did(),
          sessionId: session.sessionId,
          watches: [{
            id: "donuts",
            kind: "graph",
            query: {
              roots: [{
                id: "of:donuts",
                selector: { path: [], schema: true },
              }],
            },
          }],
        });
        const ok = routedObject(response.ok);
        const sync = routedObject(ok.sync);
        expect(Object.hasOwn(sync, "labelTable")).toBe(enabled);
        expect(Object.hasOwn(sync, "labelPathTable")).toBe(enabled);
        assert(Array.isArray(sync.upserts));
        const entry = sync.upserts.find((entry) =>
          routedObject(entry).id === "of:donuts"
        );
        assert(entry);
        const received = routedObject(routedObject(entry).doc);
        if (enabled) {
          expect(sync.labelTable).toEqual([doc.cfc.labelMap.entries[0].label]);
        } else {
          expect(received).toEqual(doc);
        }
        // Control proofs continue to carry the original client descriptor.
        expect(
          (await f.control(
            6,
            new RoutedWriter("mvp1").fixed(f.context).blob(f.flags)
              .blob(await f.proof()).bytes,
          )).status,
        ).toBe(0);
      } finally {
        await f.close();
      }
    });
  }

  for (
    const invalid of [
      "missing-descriptor",
      "missing-binding-hash",
      "changed-descriptor",
      "original-hash",
      "original-flags",
      "mode",
      "missing-mode",
      "private-support",
      "execution-posture",
      "boolean-superset",
      "codec-superset",
      "missing-auth",
      "label-table-type",
      "operation-codecs-type",
    ] as const
  ) {
    it(`rejects \`${invalid}\` before consuming the ticket or replacing the existing backend`, async () => {
      const f = await fixture(`encoding-reject-${invalid}`);
      try {
        const session = await f.open();
        const ticket = await f.issueTicket();
        const selected = { ...f.encodingFlags };
        switch (invalid) {
          case "mode":
            selected.modernCellRep = false;
            break;
          case "missing-mode":
            delete selected.modernCellRep;
            break;
          case "private-support":
            selected.routerEncodingNegotiation = false;
            break;
          case "execution-posture":
            selected.serverExecution = false;
            break;
          case "boolean-superset":
            selected.unknownCapability = true;
            break;
          case "codec-superset":
            selected.operationCodecs = ["unavailable-codec@1"];
            break;
          case "label-table-type":
            selected.syncLabelTableV1 = [];
            break;
          case "operation-codecs-type":
            selected.operationCodecs = false;
            break;
        }
        const candidate = await f.socketBeforeHello(ticket, selected);
        const hello = JSON.parse(candidate.hello.slice(5));
        switch (invalid) {
          case "missing-descriptor":
            delete hello.negotiatedMemoryFlags;
            break;
          case "missing-auth":
            delete hello.negotiatedMemoryFlags.connectionAuth;
            break;
          case "changed-descriptor":
            hello.negotiatedMemoryFlags.syncLabelTableV1 = false;
            break;
          case "original-flags":
            hello.flags.syncLabelTableV1 = false;
            break;
          case "original-hash":
          case "missing-binding-hash": {
            let payload = readRoutedBase64(hello.routerBinding).slice(0, -64);
            if (invalid === "original-hash") payload[payload.length - 64] ^= 1;
            else payload = payload.slice(0, -32);
            hello.routerBinding = routedBase64(
              await new RoutedWriter("rdb1").fixed(payload.subarray(4)).sign(
                f.router,
              ),
            );
            break;
          }
        }
        using connected = spy(f.server, "connectRouted");
        candidate.socket.receive(`fvj1:${JSON.stringify(hello)}`);
        await candidate.socket.closed.promise;
        expect(connected.calls).toHaveLength(0);
        expect(f.socket.readyState).toBe(WebSocket.OPEN);
        expect(
          await f.request({
            type: "session.watch.set",
            space: f.space.did(),
            sessionId: session.sessionId,
            watches: [],
          }),
        ).toHaveProperty("ok");
        const replacement = await f.dataSocket(ticket);
        expect(await frameOrClose(replacement)).toBe("hello.ok");
        expect(connected.calls).toHaveLength(1);
      } finally {
        await f.close();
      }
    });
  }

  it("gates compressed input on the effective descriptor", async () => {
    const f = await fixture("encoding-compression-off", {
      negotiatedFlags: { messageCompressionV1: false },
    });
    try {
      expect(JSON.parse(new TextDecoder().decode(f.flags)).messageCompressionV1)
        .toBe(true);
      const session = await f.open();
      const payload = encodeMemoryBoundary({
        type: "session.watch.set",
        requestId: "compressed",
        space: f.space.did(),
        sessionId: session.sessionId,
        watches: Array.from({ length: 40 }, (_, i) => ({
          id: `compressed-watch-${i}`,
          kind: "graph",
          query: { roots: [] },
        })),
      });
      const compressed = encodeRoutedFrame(payload, FRAME_SLOTS);
      expect(compressed).toBeInstanceOf(Uint8Array);
      f.socket.receive(compressed);
      await f.socket.closed.promise;
      expect(f.link.readyState).toBe(WebSocket.OPEN);
    } finally {
      await f.close();
    }
  });

  it("sends a client that negotiated end-to-end compression its large bodies as the routed envelope, until it asks for text", async () => {
    for (
      const [name, negotiated, options] of [
        ["both", true, {}],
        // An SDK that predates `routedCompressionV1`: binary bodies would read
        // as router credit to it, so it gets text.
        ["older-client", false, {
          clientFlags: { routedCompressionV1: false },
        }],
        ["no-message-compression", false, {
          negotiatedFlags: { messageCompressionV1: false },
        }],
      ] as const
    ) {
      const f = await fixture(`encoding-compressed-output-${name}`, options);
      try {
        const session = await f.open();
        const value = Array.from({ length: 400 }, (_, i) => `entry ${i}`)
          .join(" ");
        const transact = (requestId: string, localSeq: number) =>
          encodeMemoryBoundary({
            type: "transact",
            requestId,
            space: f.space.did(),
            sessionId: session.sessionId,
            commit: {
              localSeq,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: `of:${requestId}`,
                value: { value },
              }],
            },
          });
        const reply = async (requestId: string) => {
          for (;;) {
            const frame = await f.socket.take();
            const body = decodeRoutedFrame(frame, true, FRAME_SLOTS).body;
            if (body.requestId === requestId) return { frame, body };
          }
        };
        // A compressed upload where compression is negotiated, and a reply
        // carrying the document.
        f.socket.receive(
          negotiated
            ? encodeRoutedFrame(transact("large", 1), FRAME_SLOTS)
            : transact("large", 1),
        );
        const large = await reply("large");
        expect(large.body.ok).toBeDefined();
        expect(large.frame instanceof Uint8Array).toBe(negotiated);
        if (!negotiated) continue;
        // A small reply stays text; after the client asks for text, so does
        // a large one.
        const off = encodeMemoryBoundary({
          type: "memory.compression",
          requestId: "off",
          enabled: false,
        });
        f.socket.receive(off);
        const small = await reply("off");
        expect(typeof small.frame).toBe("string");
        expect(small.body.enabled).toBe(false);
        f.socket.receive(transact("after", 2));
        const after = await reply("after");
        expect(after.body.ok).toBeDefined();
        expect(typeof after.frame).toBe("string");
        expect(f.socket.readyState).toBe(WebSocket.OPEN);
      } finally {
        await f.close();
      }
    }
  });

  it("authenticates and echoes an omitted legacy mode without inserting a default", async () => {
    const f = await fixture("encoding-omitted-legacy-mode", {
      modernCellRep: false,
    });
    try {
      const selected = { ...f.encodingFlags };
      delete selected.modernCellRep;
      const ticket = await f.issueTicket();
      const candidate = await f.socketBeforeHello(ticket, selected);
      candidate.socket.receive(candidate.hello);
      // The fixture requires an exact descriptor echo, including omitted keys.
      expect(await frameOrClose(candidate.socket)).toBe("hello.ok");
      candidate.socket.receive(encodeMemoryBoundary({
        type: "session.open",
        requestId: "legacy-open",
        space: f.space.did(),
        principal: f.principal.did(),
        session: {},
      }));
      const opened = decodeRoutedFrame(
        await candidate.socket.take(),
        true,
        FRAME_SLOTS,
      ).body;
      expect(opened.requestId).toBe("legacy-open");
      expect(opened.error).toBeUndefined();
      expect(opened).toHaveProperty("ok");
    } finally {
      await f.close();
      setModernCellRepConfig(true);
    }
  });
});

describe("routed encoding capability validation", () => {
  const required = {
    modernCellRep: true,
    connectionAuth: true,
    routedAuthV1: true,
  };

  it("uses sorted ASCII keys and unchanged set order for the Rust signed descriptor bytes", () => {
    const descriptor = {
      routedAuthV1: true,
      operationCodecs: ["z@1", "a/2@2"],
      modernCellRep: false,
      connectionAuth: true,
    };
    expect(new TextDecoder().decode(validatedRoutedEncodingFlags(
      descriptor,
      descriptor,
      descriptor,
      ["routerEncodingNegotiation"],
    ))).toBe(
      '{"connectionAuth":true,"modernCellRep":false,"operationCodecs":["z@1","a/2@2"],"routedAuthV1":true}',
    );
  });

  it("accepts disabled generic intersections across missing or different value kinds", () => {
    const effective = { ...required, futureBoolean: false, futureCodecs: [] };
    expect(validatedRoutedEncodingFlags(
      effective,
      { ...required, futureBoolean: [], futureCodecs: false },
      required,
      [],
    )).toEqual(routedFlags(effective));
  });

  it("retains effective narrowing without changing the original flag bytes", () => {
    const original = Object.freeze({
      ...required,
      syncLabelTableV1: true,
      futureBoolean: true,
      futureCodecs: Object.freeze(["codec-a", "codec-b"]),
    });
    const supported = {
      ...required,
      syncLabelTableV1: true,
      futureBoolean: true,
      futureCodecs: ["codec-b", "codec-c"],
      serverExecution: true,
    };
    const effective = {
      ...required,
      syncLabelTableV1: false,
      futureBoolean: true,
      futureCodecs: ["codec-b"],
      absentBoolean: false,
      absentCodecs: [],
    };
    const originalBytes = routedFlags(original);
    expect(validatedRoutedEncodingFlags(effective, original, supported, []))
      .toEqual(routedFlags(effective));
    expect(routedFlags(original)).toEqual(originalBytes);
    expect(sha256(routedFlags(effective))).not.toEqual(sha256(originalBytes));
  });

  for (const side of ["client", "endpoint"] as const) {
    for (const available of [false, undefined]) {
      it(`throws when a selected boolean lacks ${side} support (${available})`, () => {
        const offered = { ...required, futureBoolean: true };
        const limited = available === undefined
          ? required
          : { ...required, futureBoolean: available };
        expect(() =>
          validatedRoutedEncodingFlags(
            offered,
            side === "client" ? limited : offered,
            side === "endpoint" ? limited : offered,
            [],
          )
        ).toThrow();
      });
    }

    it(`throws when a selected codec lacks ${side} support`, () => {
      const offered = { ...required, futureCodecs: ["a", "b"] };
      const limited = { ...required, futureCodecs: ["a"] };
      expect(() =>
        validatedRoutedEncodingFlags(
          { ...required, futureCodecs: ["b"] },
          side === "client" ? limited : offered,
          side === "endpoint" ? limited : offered,
          [],
        )
      ).toThrow();
    });
  }

  for (const mode of [false, true]) {
    it(`requires exact wire mode when the client uses \`${mode}\``, () => {
      const descriptor = { ...required, modernCellRep: mode };
      const mismatch = { ...required, modernCellRep: !mode };
      expect(
        validatedRoutedEncodingFlags(descriptor, descriptor, descriptor, []),
      )
        .toEqual(routedFlags(descriptor));
      expect(() =>
        validatedRoutedEncodingFlags(mismatch, descriptor, descriptor, [])
      )
        .toThrow();
      expect(() =>
        validatedRoutedEncodingFlags(descriptor, mismatch, descriptor, [])
      )
        .toThrow();
      expect(() =>
        validatedRoutedEncodingFlags(descriptor, descriptor, mismatch, [])
      )
        .toThrow();
    });
  }

  it("throws for private metadata even when its value is false", () => {
    for (const key of ["serverExecution", "testPrivateSupport"]) {
      for (const value of [false, true]) {
        const descriptor = { ...required, [key]: value };
        expect(() =>
          validatedRoutedEncodingFlags(
            descriptor,
            descriptor,
            descriptor,
            ["testPrivateSupport"],
          )
        ).toThrow();
      }
    }
  });

  it("throws for missing authentication or wire mode", () => {
    // This connection requires modern mode, so omission (legacy) mismatches it.
    for (const key of Object.keys(required)) {
      const incomplete = Object.fromEntries(
        Object.entries(required).filter(([name]) => name !== key),
      );
      expect(() =>
        validatedRoutedEncodingFlags(incomplete, required, required, [])
      )
        .toThrow();
    }
    for (const key of ["connectionAuth", "routedAuthV1"]) {
      const descriptor = { ...required, [key]: false };
      expect(() =>
        validatedRoutedEncodingFlags(descriptor, descriptor, descriptor, [])
      )
        .toThrow();
    }
  });

  it("preserves an omitted mode only when both peers use the legacy representation", () => {
    const omitted = { connectionAuth: true, routedAuthV1: true };
    const legacy = { ...omitted, modernCellRep: false };
    for (const client of [omitted, legacy]) {
      for (const endpoint of [omitted, legacy]) {
        expect(validatedRoutedEncodingFlags(omitted, client, endpoint, []))
          .toEqual(routedFlags(omitted));
      }
    }
    expect(() => validatedRoutedEncodingFlags(omitted, required, legacy, []))
      .toThrow();
    expect(() => validatedRoutedEncodingFlags(omitted, legacy, required, []))
      .toThrow();
    expect(() =>
      validatedRoutedEncodingFlags(
        { ...omitted, modernCellRep: [] },
        legacy,
        legacy,
        [],
      )
    ).toThrow();
  });

  it("throws for disabled known capabilities with the wrong Memory protocol type", () => {
    for (
      const fields of [
        { syncLabelTableV1: [] },
        { operationCodecs: false },
        { syncSchemaTableV2: [] },
      ]
    ) {
      expect(() =>
        validatedRoutedEncodingFlags(
          { ...required, ...fields },
          required,
          required,
          [],
        )
      ).toThrow();
    }
  });

  it("throws for malformed descriptors and bounded-field overflows", () => {
    const invalid: unknown[] = [
      undefined,
      null,
      [],
      { ...required, futureBoolean: "true" },
      { ...required, futureCodecs: ["a", "a"] },
      { ...required, futureCodecs: [1] },
      { ...required, futureCodecs: ["x".repeat(129)] },
      {
        ...required,
        futureCodecs: Array.from({ length: 17 }, (_, i) => `c${i}`),
      },
      { ...required, nested: { enabled: true } },
      { ...required, "bad key": true },
      {
        ...required,
        ...Object.fromEntries(
          Array.from({ length: 65 }, (_, i) => [`k${i}`, false]),
        ),
      },
      {
        ...required,
        largeCodecs: Array.from(
          { length: 16 },
          (_, i) => `${i}${"x".repeat(125)}`,
        ),
      },
    ];
    for (const descriptor of invalid) {
      expect(() =>
        validatedRoutedEncodingFlags(descriptor, required, required, [])
      )
        .toThrow();
    }
  });

  it("throws when a codec set and boolean use the same capability name", () => {
    const boolean = { ...required, futureCapability: true };
    const codecs = { ...required, futureCapability: ["a"] };
    expect(() => validatedRoutedEncodingFlags(boolean, codecs, boolean, []))
      .toThrow();
    expect(() => validatedRoutedEncodingFlags(codecs, boolean, codecs, []))
      .toThrow();
  });

  it("supports independent endpoint capability stubs without a global flag", async () => {
    const first = await fixture("encoding-support-off", {
      serverFlags: { syncLabelTableV1: false },
    });
    try {
      const second = await fixture("encoding-support-on", {
        serverFlags: { syncLabelTableV1: true },
      });
      try {
        for (const [f, enabled] of [[first, false], [second, true]] as const) {
          const socket = await f.dataSocket(await f.issueTicket());
          const hello =
            decodeRoutedFrame(await socket.take(), true, FRAME_SLOTS).body;
          expect(hello.type).toBe("hello.ok");
          expect(hello.flags).toMatchObject({ syncLabelTableV1: enabled });
          expect(f.server.memoryProtocolFlags().syncLabelTableV1).toBe(enabled);
        }
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });
});

describe("routed control progress", () => {
  it("reports queue, handler, and write delays with a bounded metadata history", () => {
    const records: Record<string, unknown>[] = [];
    let now = 0;
    const progress = new RoutedControlDiagnostics(
      (record) => records.push(record),
      () => now,
      () => 1234,
    );
    for (let sequence = 1; sequence <= 20; sequence++) {
      const entry = progress.receive(sequence, 3, "01".repeat(16));
      progress.start(entry);
      progress.handled(entry);
      progress.writing(entry);
      progress.completion(entry)();
    }
    expect(records).toHaveLength(0);
    const entry = progress.receive(21, 3, "02".repeat(16));
    now = 501;
    progress.start(entry);
    now = 1002;
    progress.handled(entry);
    progress.writing(entry);
    now = 1503;
    progress.completion(entry)();
    expect(records.map((record) => record.phase)).toEqual([
      "queue",
      "handle",
      "write",
    ]);
    for (const record of records) {
      expect(record.elapsedMs).toBe(501);
      expect(record.history).toHaveLength(16);
    }
    progress.close();
    const closed = records.at(-1)!;
    expect(closed).toMatchObject({ phase: "close", active: 0 });
    expect(closed.history).toEqual(expect.arrayContaining([{
      sequence: 21,
      opcode: 3,
      context: "02".repeat(16),
      receivedWallMs: 1234,
      receivedAt: 0,
      startedAt: 501,
      handledAt: 1002,
      writeStartedAt: 1002,
      writtenAt: 1503,
      finished: true,
      failed: false,
    }]));
    expect(closed.history).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ sequence: 5 })]),
    );
  });

  it("records one actual event-loop delay per backlog and cancels the pending marker at close", async () => {
    let now = 10;
    const records: Record<string, unknown>[] = [];
    const progress = new RoutedControlDiagnostics(
      (record) => records.push(record),
      () => now,
    );
    const first = progress.receive(1, 3);
    const handle = progress.accessForTestingOnly.turn;
    const second = progress.receive(2, 3);
    expect(progress.accessForTestingOnly.turn).toBe(handle);
    now = 25;
    await setImmediate();
    expect(progress.accessForTestingOnly.turn).toBeUndefined();
    progress.finish(first);
    progress.finish(second);
    progress.close();
    expect(records[0]).toMatchObject({
      opportunity: { scheduledAt: 10, executedAt: 25, delayMs: 15 },
    });

    const canceled = new RoutedControlDiagnostics(() => {
      throw new Error("sink");
    });
    const pending = canceled.receive(1, 3);
    const immediate = canceled.accessForTestingOnly.turn!;
    expect(immediate.hasRef()).toBe(true);
    expect(() => canceled.close()).not.toThrow();
    expect(immediate.hasRef()).toBe(false);
    canceled.completion(pending)();
    expect(pending.writtenAt).toBeUndefined();
  });

  it("records control write completion separately from handling and ignores callbacks after local close", async () => {
    const f = await fixture("control-progress");
    const lines: string[] = [];
    using _info = stub(
      console,
      "info",
      (line: unknown) => lines.push(String(line)),
    );
    let callback: ((error?: Error) => void) | undefined;
    const send = f.link.send.bind(f.link);
    using _send = stub(f.link, "send", (bytes, done) => {
      callback = done;
      send(bytes);
    });
    try {
      expect((await f.control(3, f.context)).status).toBe(0);
      f.host.close();
      const records = lines.map((line) => JSON.parse(line)).filter((record) =>
        record.event === "routed-control-progress"
      );
      expect(records).toHaveLength(1);
      const last = records[0].history.at(-1);
      expect(last).toMatchObject({ opcode: 3, context: routedHex(f.context) });
      expect(last.receivedWallMs).toBeGreaterThan(0);
      expect(last.handledAt).toBeGreaterThanOrEqual(last.startedAt);
      expect(last.writeStartedAt).toBeGreaterThanOrEqual(last.handledAt);
      expect(last.writtenAt).toBeUndefined();
      assert(callback);
      const count = lines.length;
      callback();
      expect(lines).toHaveLength(count);
    } finally {
      await f.close();
    }
  });
});

describe("private request credits", () => {
  /** Waits, a bounded number of turns, for the router peer's credit. */
  const creditReaches = async (socket: FramedSocket, credit: number) => {
    for (let i = 0; i < 100 && socket.credit !== credit; i++) {
      await setImmediate();
    }
    expect(socket.credit).toBe(credit);
  };

  it("grants the whole input budget once ready and returns each request's declared bytes as its turn ends", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const f = await routedRequestFixture("credit-window", async (id) => {
      if (id === "first") {
        entered.resolve();
        await release.promise;
      } else second.resolve();
    });
    try {
      const state = f.host.accessForTestingOnly.dataSocket(
        f.socket as unknown as WebSocket,
      )!;
      await creditReaches(f.socket, ROUTER_REQUEST_WINDOW);
      const first = f.request("first");
      const firstBytes = new TextEncoder().encode(first).length;
      f.socket.receive(first);
      await entered.promise;
      expect(state.pendingBytes).toBe(firstBytes);
      expect(f.socket.credit).toBe(ROUTER_REQUEST_WINDOW - firstBytes);
      // The next request goes, header and body, while the first's turn is
      // open: no round trip per request.
      f.socket.receive(f.request("second"));
      await second.promise;
      expect(f.handled).toEqual(["first", "second"]);
      // Its turn has ended and its bytes are back; the first's are not.
      await creditReaches(f.socket, ROUTER_REQUEST_WINDOW - firstBytes);
      release.resolve();
      await state.settled;
      await creditReaches(f.socket, ROUTER_REQUEST_WINDOW);
      expect(state.pendingBytes).toBe(0);
      expect(f.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      release.resolve();
      await f.close();
    }
  });

  /** Waits for the toolshed to close `socket`, failing after five seconds. */
  const closes = async (socket: FramedSocket) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        socket.closed.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("the socket stayed open")),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  /** Hex digits, which gzip compresses about twice: inside the ratio bound. */
  const hex = (length: number, seed: number) => {
    const words: string[] = [];
    for (let i = 0; i < length; i += 8) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      words.push((seed >>> 0).toString(16).padStart(8, "0"));
    }
    return words.join("").slice(0, length);
  };

  it("expands a compressed body only while the expanded bodies in their turns fit the input budget", async () => {
    const release = Promise.withResolvers<void>();
    const f = await routedRequestFixture("credit-expanded", async () => {
      await release.promise;
    });
    try {
      const state = f.host.accessForTestingOnly.dataSocket(
        f.socket as unknown as WebSocket,
      )!;
      await creditReaches(f.socket, ROUTER_REQUEST_WINDOW);
      const payloads = Array.from(
        { length: 10 },
        (_, i) =>
          encodeMemoryBoundary({
            type: "session.open",
            requestId: `expanded-${i}`,
            space: f.space.did(),
            principal: f.principal.did(),
            session: {},
            padding: hex(500 * 1024, i + 1),
          }),
      );
      const sizes = payloads.map((payload) =>
        new TextEncoder().encode(payload).length
      );
      // The bodies that fit the budget expanded, in order.
      let fits = 0;
      for (let total = sizes[0]; total <= ROUTER_REQUEST_WINDOW;) {
        total += sizes[++fits] ?? Infinity;
      }
      expect(fits).toBe(8);
      let sent = 0;
      for (const payload of payloads) {
        const frame = encodeRoutedFrame(payload, FRAME_SLOTS);
        assert(frame instanceof Uint8Array);
        sent += frame.length;
        f.socket.receive(frame);
      }
      // All ten fit the credit as sent.
      expect(sent).toBeLessThan(ROUTER_REQUEST_WINDOW);
      for (let i = 0; i < 1000 && f.handled.length < fits; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(f.handled.length).toBe(fits);
      expect(state.expandedBytes).toBe(
        sizes.slice(0, fits).reduce((a, b) => a + b),
      );
      expect(state.pendingBytes).toBe(sent);
      release.resolve();
      await state.settled;
      expect(f.handled.length).toBe(10);
      expect(state.expandedBytes).toBe(0);
      expect(state.pendingBytes).toBe(0);
      await creditReaches(f.socket, ROUTER_REQUEST_WINDOW);
      expect(f.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      release.resolve();
      await f.close();
    }
  });

  it("refuses a compressed body that alone expands past the input budget", async () => {
    const f = await routedRequestFixture("credit-expanded-over", () => {});
    try {
      const frame = encodeRoutedFrame(
        encodeMemoryBoundary({
          type: "session.open",
          requestId: "over",
          space: f.space.did(),
          principal: f.principal.did(),
          session: {},
          padding: hex(ROUTER_REQUEST_WINDOW, 7),
        }),
        FRAME_SLOTS,
      );
      assert(frame instanceof Uint8Array);
      expect(frame.length).toBeLessThan(ROUTER_REQUEST_WINDOW);
      f.socket.receive(frame);
      await closes(f.socket);
      expect(f.handled).toEqual([]);
      expect(f.link.readyState).toBe(WebSocket.OPEN);
    } finally {
      await f.close();
    }
  });

  it("refuses a header past the credit the router has received, though the budget has room", async () => {
    const f = await routedRequestFixture(
      "credit-unsent",
      (requestId, send) => {
        send({ type: "response", requestId, ok: "x".repeat(300000) });
      },
    );
    const send = f.socket.send.bind(f.socket);
    // The peer assembles the response but acknowledges none of it, so the
    // send window stays full and returned credit waits behind it.
    using _send = stubOutput(f.socket, (bytes, done) => {
      assert(done);
      send(bytes);
    });
    try {
      const state = f.host.accessForTestingOnly.dataSocket(
        f.socket as unknown as WebSocket,
      )!;
      await creditReaches(f.socket, ROUTER_REQUEST_WINDOW);
      const request = f.request("first");
      const requestBytes = new TextEncoder().encode(request).length;
      f.socket.receive(request);
      await state.settled;
      expect(state.pendingBytes).toBe(0);
      expect(f.socket.credit).toBe(ROUTER_REQUEST_WINDOW - requestBytes);
      // A router that spends the credit it has not received: the input
      // budget has room for it, the credit does not.
      f.socket.deliver(encodeRouterHeader({
        route: { type: "transact", requestId: "over" },
        bytes: ROUTER_REQUEST_WINDOW - requestBytes + 1,
        binary: false,
        requestOrdinal: f.socket.requestOrdinal + 1,
      }));
      await closes(f.socket);
      expect(f.handled).toEqual(["first"]);
      expect(f.link.readyState).toBe(WebSocket.OPEN);
    } finally {
      await f.close();
    }
  });

  it("closes the socket and returns no credit when a turn handed to the connection fails", async () => {
    const f = await routedRequestFixture("credit-turn-failure", () => {
      throw new Error("backend failed");
    });
    try {
      await creditReaches(f.socket, ROUTER_REQUEST_WINDOW);
      const request = f.request("failing");
      f.socket.receive(request);
      await closes(f.socket);
      expect(f.handled).toEqual(["failing"]);
      expect(f.socket.credit).toBe(
        ROUTER_REQUEST_WINDOW - new TextEncoder().encode(request).length,
      );
      expect(f.link.readyState).toBe(WebSocket.OPEN);
    } finally {
      await f.close();
    }
  });

  it("refuses a header past the credit it granted", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await routedRequestFixture("credit-overspend", async () => {
      entered.resolve();
      await release.promise;
    });
    try {
      const state = f.host.accessForTestingOnly.dataSocket(
        f.socket as unknown as WebSocket,
      )!;
      const body = {
        ...decodeRoutedFrame(f.request("first"), true, FRAME_SLOTS).body,
        padding: "x".repeat(3 * 1024 * 1024),
      };
      f.socket.receive(encodeMemoryBoundary(body));
      await entered.promise;
      // A router that ignores its credit: two more MiB pass the 4 MiB budget.
      f.socket.deliver(encodeRouterHeader({
        route: { type: "transact", requestId: "over" },
        bytes: 2 * 1024 * 1024,
        binary: false,
        requestOrdinal: f.socket.requestOrdinal + 1,
      }));
      await f.socket.closed.promise;
      expect(f.handled).toEqual(["first"]);
      release.resolve();
      await state.settled;
      expect(state.pendingBytes).toBe(0);
      expect(f.link.readyState).toBe(WebSocket.OPEN);
    } finally {
      release.resolve();
      await f.close();
    }
  });

  for (const capability of [undefined, false]) {
    it(`rejects private hello request-credit capability \`${capability}\` before replacing the live socket or consuming its ticket`, async () => {
      const f = await fixture(`hello-admission-${capability}`);
      try {
        const ticket = await f.issueTicket();
        const pending = await f.socketBeforeHello(ticket);
        const hello = decodeRoutedFrame(pending.hello, true, FRAME_SLOTS).body;
        pending.socket.deliver(JSON.stringify({
          type: "router.hello",
          version: 1,
          memoryFlags: hello.flags,
          negotiatedMemoryFlags: hello.negotiatedMemoryFlags,
          routerTicket: hello.routerTicket,
          routerBinding: hello.routerBinding,
          ...(capability === undefined
            ? {}
            : { routerRequestCredit: capability }),
        }));
        await pending.socket.closed.promise;
        expect(f.socket.readyState).toBe(WebSocket.OPEN);
        const replacement = await f.dataSocket(ticket);
        await replacement.take();
        expect(replacement.readyState).toBe(WebSocket.OPEN);
        replacement.close();
      } finally {
        await f.close();
      }
    });
  }

  for (
    const ending of [
      "premature-end",
      "header-inside-body",
      "local-close",
      "peer-close",
    ] as const
  ) {
    it(`releases an incomplete body's reservation on \`${ending}\``, async () => {
      const f = await routedRequestFixture(`input-${ending}`, () => {});
      try {
        const state = f.host.accessForTestingOnly.dataSocket(
          f.socket as unknown as WebSocket,
        )!;
        await state.settled;
        await f.socket.header({
          route: { type: "transact", requestId: "pending" },
          bytes: 4 * 1024 * 1024,
          binary: true,
        });
        f.socket.deliver(routerRecord(1, new Uint8Array(1)));
        expect(state.pendingBytes).toBe(4 * 1024 * 1024);
        expect(state.assemblingBytes).toBe(4 * 1024 * 1024);
        if (ending === "local-close") f.host.close();
        else if (ending === "peer-close") f.socket.close();
        else {
          f.socket.deliver(
            ending === "premature-end" ? routerRecord(2) : encodeRouterHeader({
              route: { type: "transact", requestId: "inside" },
              bytes: 1,
              binary: false,
              requestOrdinal: f.socket.requestOrdinal + 1,
            }),
          );
        }
        await f.socket.closed.promise;
        expect(state.pendingBytes).toBe(0);
        expect(state.assemblingBytes).toBe(0);
        expect(f.handled).toEqual([]);
      } finally {
        await f.close();
      }
    });
  }

  for (const ordinal of [undefined, 1, 3, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects a second equal-sized request with ordinal \`${ordinal}\``, async () => {
      const f = await routedRequestFixture(
        `input-ordinal-${ordinal}`,
        () => {},
      );
      try {
        const payload = f.request("first");
        await f.socket.receive(payload);
        const state = f.host.accessForTestingOnly.dataSocket(
          f.socket as unknown as WebSocket,
        )!;
        await state.settled;
        const header = {
          bytes: new TextEncoder().encode(payload).length,
          binary: false,
          route: { type: "session.open", requestId: "second" },
          ...(ordinal === undefined ? {} : { requestOrdinal: ordinal }),
        };
        f.socket.deliver(
          routerRecord(0, new TextEncoder().encode(JSON.stringify(header))),
        );
        await f.socket.closed.promise;
        expect(f.handled).toEqual(["first"]);
        expect(state.pendingBytes).toBe(0);
      } finally {
        await f.close();
      }
    });
  }
});

describe("routed output high and low marks", () => {
  /** The output bound these tests configure; the marks are half and a quarter of it. */
  const BOUND = 256 * 1024;
  const HIGH = BOUND / 2;
  const LOW = HIGH / 2;

  it("decodes and dispatches the next request while a large response to the previous one is still draining", async () => {
    const second = Promise.withResolvers<void>();
    const f = await routedRequestFixture("flow-duplex", (requestId, send) => {
      send({ type: "response", requestId, ok: "x".repeat(150000) });
      if (requestId === "second") second.resolve();
    });
    const callbacks: (() => void)[] = [];
    const send = f.socket.send.bind(f.socket);
    using _send = stubOutput(f.socket, (bytes, done) => {
      assert(done);
      // The peer assembles the records but acknowledges none of them.
      send(bytes);
      callbacks.push(done);
    });
    try {
      const state = f.host.accessForTestingOnly.dataSocket(
        f.socket as unknown as WebSocket,
      )!;
      f.socket.receive(f.request("first"));
      f.socket.receive(f.request("second"));
      await second.promise;
      expect(f.handled).toEqual(["first", "second"]);
      expect(f.socket.isPaused).toBe(false);
      expect(state.outputPaused).toBe(false);
      expect(state.outputBytes).toBeGreaterThan(2 * 150000);
      // Both responses exceed the send window together; acknowledging the
      // records passes the rest on, in order.
      while (callbacks.length) callbacks.shift()!();
      expect(state.outputBytes).toBe(0);
      for (const requestId of ["first", "second"]) {
        expect(
          decodeRoutedFrame(await f.socket.take(), true, FRAME_SLOTS).body
            .requestId,
        ).toBe(requestId);
      }
      expect(f.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      await f.close();
    }
  });

  it("hands a request to the connection while the one before it is still in its turn, and releases each budget when its own turn ends", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const f = await routedRequestFixture(
      "flow-handoff",
      async (requestId, send) => {
        if (requestId === "first") {
          entered.resolve();
          await release.promise;
        }
        send({ type: "response", requestId, ok: requestId });
        if (requestId === "second") second.resolve();
      },
    );
    try {
      const state = f.host.accessForTestingOnly.dataSocket(
        f.socket as unknown as WebSocket,
      )!;
      f.socket.receive(f.request("first"));
      await entered.promise;
      const firstBytes = state.pendingBytes;
      expect(firstBytes).toBeGreaterThan(0);
      f.socket.receive(f.request("second"));
      // The connection receives the second request while the first turn is
      // still open; the connection, not the host, orders turns per space.
      await second.promise;
      expect(f.handled).toEqual(["first", "second"]);
      expect(
        decodeRoutedFrame(await f.socket.take(), true, FRAME_SLOTS).body
          .requestId,
      ).toBe("second");
      // The second turn ended with its response; the first request's
      // reservation stays until its own turn ends.
      while (state.pendingBytes !== firstBytes) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      release.resolve();
      expect(
        decodeRoutedFrame(await f.socket.take(), true, FRAME_SLOTS).body
          .requestId,
      ).toBe("first");
      await state.settled;
      expect(state.pendingBytes).toBe(0);
      expect(f.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      release.resolve();
      await f.close();
    }
  });

  it("pauses reads and dispatch at the high mark, not below it, and resumes both below the low mark", async () => {
    const f = await routedRequestFixture(
      "flow-watermarks",
      (requestId, send) => {
        send(sizedResponse(requestId, HIGH / 4));
      },
      { outputBytesPerSocket: BOUND },
    );
    const callbacks: (() => void)[] = [];
    using _send = stubOutput(f.socket, (_bytes, done) => {
      assert(done);
      callbacks.push(done);
    });
    try {
      const state = f.host.accessForTestingOnly.dataSocket(
        f.socket as unknown as WebSocket,
      )!;
      /** Acknowledges records until one more body has been released. */
      const completeBody = () => {
        const before = state.outputBytes;
        while (state.outputBytes === before) callbacks.shift()!();
      };
      for (let i = 0; i < 3; i++) await f.socket.receive(f.request(`r${i}`));
      await state.settled;
      expect(f.handled).toEqual(["r0", "r1", "r2"]);
      expect(state.outputBytes).toBe(3 * HIGH / 4);
      expect(state.outputPaused).toBe(false);
      expect(f.socket.isPaused).toBe(false);
      await f.socket.receive(f.request("r3"));
      await state.settled;
      expect(f.handled).toEqual(["r0", "r1", "r2", "r3"]);
      expect(state.outputBytes).toBe(HIGH);
      expect(state.outputPaused).toBe(true);
      expect(f.socket.isPaused).toBe(true);
      // A request the peer had already sent is read but held.
      await f.socket.receive(f.request("r4"));
      await setImmediate();
      expect(f.handled).toHaveLength(4);
      completeBody();
      await setImmediate();
      expect(state.outputBytes).toBe(3 * HIGH / 4);
      expect(state.outputPaused).toBe(true);
      expect(f.socket.isPaused).toBe(true);
      expect(f.handled).toHaveLength(4);
      completeBody();
      await setImmediate();
      // At the low mark the hold remains; below it both are released.
      expect(state.outputBytes).toBe(LOW);
      expect(state.outputPaused).toBe(true);
      expect(f.socket.isPaused).toBe(true);
      expect(f.handled).toHaveLength(4);
      completeBody();
      await state.settled;
      expect(state.outputPaused).toBe(false);
      expect(f.socket.isPaused).toBe(false);
      expect(f.handled).toEqual(["r0", "r1", "r2", "r3", "r4"]);
      expect(state.outputBytes).toBe(LOW);
      while (callbacks.length) callbacks.shift()!();
      expect(state.outputBytes).toBe(0);
      expect(f.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      await f.close();
    }
  });

  it("pauses a stalled reader at half the bound and refuses only a message that would take retained output past the bound", async () => {
    const f = await routedRequestFixture(
      "flow-slow-reader",
      (requestId, send) => {
        send(
          sizedResponse(requestId, requestId === "r3" ? 220 * 1024 : 48 * 1024),
        );
      },
      { outputBytesPerSocket: BOUND },
    );
    const lines: string[] = [];
    using _info = stub(console, "info", (line: unknown) => {
      lines.push(String(line));
    });
    const callbacks: (() => void)[] = [];
    using _send = stubOutput(f.socket, (_bytes, done) => {
      assert(done);
      callbacks.push(done);
    });
    try {
      const state = f.host.accessForTestingOnly.dataSocket(
        f.socket as unknown as WebSocket,
      )!;
      /** Acknowledges records until one more body has been released. */
      const completeBody = () => {
        const before = state.outputBytes;
        while (state.outputBytes === before) callbacks.shift()!();
      };
      // Three 48 KiB responses reach the 128 KiB high mark while the reader
      // acknowledges nothing: the fourth request is read but held, nothing is
      // refused, and the socket stays open with its output bounded.
      for (let i = 0; i < 4; i++) await f.socket.receive(f.request(`r${i}`));
      await setImmediate();
      expect(f.handled).toEqual(["r0", "r1", "r2"]);
      expect(state.outputBytes).toBe(144 * 1024);
      expect(state.outputPaused).toBe(true);
      expect(f.socket.isPaused).toBe(true);
      expect(f.socket.readyState).toBe(WebSocket.OPEN);
      // The reader takes two bodies; retained output falls below the low mark
      // and the held request is dispatched. Its 220 KiB response would take
      // retained output past the 256 KiB bound, and that is what is refused.
      completeBody();
      completeBody();
      await f.socket.closed.promise;
      expect(f.handled).toEqual(["r0", "r1", "r2", "r3"]);
      const closed = lines.map((line) => JSON.parse(line)).filter((entry) =>
        entry.verdict === "context-closed"
      );
      expect(closed).toHaveLength(1);
      expect(closed[0].reason).toBe("output-limit");
      expect(closed[0].outputLimit).toMatchObject({
        frameBytes: 220 * 1024,
        bufferedBytes: 48 * 1024,
        limitBytes: BOUND,
        endpoint: "data",
        classification: "queued-output",
      });
      // The control link, and with it every other connection, goes on.
      expect(f.link.readyState).toBe(WebSocket.OPEN);
    } finally {
      await f.close();
    }
  });

  it("returns a finished request's credit between the records of its draining response", async () => {
    const produced = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const f = await routedRequestFixture("flow-credit", (requestId, send) => {
      send({ type: "response", requestId, ok: "x".repeat(1024 * 1024) });
      (requestId === "first" ? produced : second).resolve();
    });
    const order: string[] = [];
    const callbacks: (() => void)[] = [];
    const send = f.socket.send.bind(f.socket);
    using _send = stub(f.socket, "send", (bytes, done) => {
      assert(bytes instanceof Uint8Array && done);
      if (isRouterRequestCredit(bytes)) {
        order.push("credit");
        send(bytes, done);
        return;
      }
      order.push(String(decodeRouterRecord(bytes).kind));
      callbacks.push(done);
    });
    try {
      const first = f.request("first");
      f.socket.receive(first);
      await produced.promise;
      // Let the turn end: its credit then waits behind the full send window.
      await setImmediate();
      // The response fills the send window; the turn has ended, so its
      // credit waits at the head of what remains.
      const pipelined = callbacks.length;
      expect(order).toEqual(["0", ...Array<string>(pipelined - 1).fill("1")]);
      // The header's callback frees too little of the window; the first
      // chunk's frees a record's worth, and the credit goes first.
      callbacks.shift()!();
      expect(order).toHaveLength(pipelined);
      callbacks.shift()!();
      expect(order[pipelined]).toBe("credit");
      expect(order.slice(pipelined + 1)).not.toContain("2");
      // The next request did not wait for that credit: the window held room.
      f.socket.receive(f.request("second"));
      await second.promise;
      expect(f.handled).toEqual(["first", "second"]);
      // Once the second turn ends, its credit follows too.
      await setImmediate();
      while (callbacks.length) callbacks.shift()!();
      expect(order.filter((kind) => kind === "2")).toHaveLength(2);
      expect(order.filter((kind) => kind === "credit")).toHaveLength(2);
      expect(f.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      await f.close();
    }
  });

  it("finishes an admitted partial input body before pausing at its boundary", async () => {
    const entered = Promise.withResolvers<void>();
    const produce = Promise.withResolvers<void>();
    const produced = Promise.withResolvers<void>();
    const f = await routedRequestFixture(
      "flow-partial",
      async (requestId, send) => {
        entered.resolve();
        await produce.promise;
        send(sizedResponse(requestId, HIGH));
        produced.resolve();
      },
      { outputBytesPerSocket: BOUND },
    );
    using _send = stubOutput(f.socket, () => {});
    try {
      f.socket.receive(f.request("first"));
      await entered.promise;
      const payload = f.request("second");
      const route = decodeRoutedFrame(payload, true, FRAME_SLOTS).body;
      const records = [...routerRecords(routerRoute(route), payload)];
      await f.socket.header(decodeRouterHeader(records[0]));
      produce.resolve();
      await produced.promise;
      expect(f.socket.isPaused).toBe(false);
      f.socket.deliver(records[1]);
      expect(f.socket.isPaused).toBe(false);
      f.socket.deliver(records[2]);
      expect(f.socket.isPaused).toBe(true);
      await setImmediate();
      expect(f.handled).toEqual(["first"]);
    } finally {
      produce.resolve();
      await f.close();
    }
  });

  it("dispatches a burst of microtask-only requests without an event-loop turn between them", async () => {
    const last = Promise.withResolvers<void>();
    const f = await routedRequestFixture(
      "flow-burst",
      async (requestId, send) => {
        await Promise.resolve();
        send({ type: "response", requestId, ok: {} });
        if (requestId === "31") last.resolve();
      },
    );
    try {
      for (let i = 0; i < 32; i++) f.socket.receive(f.request(String(i)));
      // Every request is admitted, dispatched and answered before the next
      // event-loop turn; no turn separates them.
      expect(
        await Promise.race([
          last.promise.then(() => true),
          setImmediate().then(() => false),
        ]),
      ).toBe(true);
      expect(f.handled).toHaveLength(32);
      expect(f.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      await f.close();
    }
  });

  it("resumes a buffered header arriving after pause and dispatches its body once below the low mark", async () => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const f = await routedRequestFixture(
      "flow-buffered-header",
      (requestId, send) => {
        send(sizedResponse(requestId, HIGH));
        (requestId === "first" ? first : second).resolve();
      },
      { outputBytesPerSocket: BOUND },
    );
    const callbacks: (() => void)[] = [];
    using _send = stubOutput(f.socket, (_bytes, done) => {
      assert(done);
      callbacks.push(done);
    });
    using resume = spy(f.socket, "resume");
    using pause = spy(f.socket, "pause");
    try {
      f.socket.receive(f.request("first"));
      await first.promise;
      expect(f.socket.isPaused).toBe(true);
      const resumed = resume.calls.length;
      const paused = pause.calls.length;
      const payload = f.request("second");
      const route = decodeRoutedFrame(payload, true, FRAME_SLOTS).body;
      const records = [...routerRecords(routerRoute(route), payload)];
      // Within credit the header is sent at once, and reads resume to take
      // its body before pausing again at the body's boundary.
      await f.socket.header(decodeRouterHeader(records[0]));
      expect(resume.calls).toHaveLength(resumed + 1);
      expect(f.socket.isPaused).toBe(false);
      f.socket.deliver(records[1]);
      expect(f.socket.isPaused).toBe(false);
      f.socket.deliver(records[2]);
      expect(f.socket.isPaused).toBe(true);
      expect(pause.calls).toHaveLength(paused + 1);
      await setImmediate();
      expect(f.handled).toEqual(["first"]);
      while (callbacks.length) callbacks.shift()!();
      await second.promise;
      expect(f.handled).toEqual(["first", "second"]);
      while (callbacks.length) callbacks.shift()!();
      const state = f.host.accessForTestingOnly.dataSocket(
        f.socket as unknown as WebSocket,
      );
      assert(state);
      await state.settled;
      expect(f.handled).toEqual(["first", "second"]);
      expect(state.pendingBytes).toBe(0);
      expect(f.socket.isPaused).toBe(false);
      expect(f.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      await f.close();
    }
  });

  for (
    const closing of [
      "shutdown",
      "ownership",
      "context",
      "replacement",
    ] as const
  ) {
    it(`releases the output hold and input reservations on local \`${closing}\` while the socket remains closing`, async () => {
      const produce = Promise.withResolvers<void>();
      const f = await routedRequestFixture(
        `flow-local-${closing}`,
        async (requestId, send) => {
          await produce.promise;
          send(sizedResponse(requestId, HIGH));
        },
        { outputBytesPerSocket: BOUND },
      );
      let done: (() => void) | undefined;
      using _send = stubOutput(
        f.socket,
        (_bytes, callback) => done = callback,
      );
      const finishClose = f.socket.close.bind(f.socket);
      using _close = stub(f.socket, "close", () => {
        f.socket.readyState = WebSocket.CLOSING;
      });
      try {
        const state = f.host.accessForTestingOnly.dataSocket(
          f.socket as unknown as WebSocket,
        );
        assert(state);
        f.socket.receive(f.request("first"));
        await f.socket.receive(f.request("second"));
        await f.socket.header({
          route: { type: "transact", requestId: "partial" },
          bytes: 100,
          binary: true,
        });
        produce.resolve();
        await setImmediate();
        expect(f.handled).toEqual(["first"]);
        expect(state.outputBytes).toBe(HIGH);
        expect(state.outputPaused).toBe(true);
        const queuedBytes = state.pendingBytes - 100;
        expect(queuedBytes).toBeGreaterThan(0);
        expect(state.assemblingBytes).toBe(100);
        expect(state.pendingBytes).toBe(queuedBytes + 100);
        const settled = state.settled;
        switch (closing) {
          case "shutdown":
            f.host.close();
            break;
          case "ownership":
            f.advanceOwnership();
            f.host.fenceOwnership();
            break;
          case "context":
            expect((await f.control(3, f.context)).status).toBe(0);
            break;
          case "replacement": {
            const replacement = await f.dataSocket(await f.issueTicket());
            expect(
              decodeRoutedFrame(await replacement.take(), true, FRAME_SLOTS)
                .body.type,
            )
              .toBe("hello.ok");
            expect(replacement.readyState).toBe(WebSocket.OPEN);
            break;
          }
        }
        expect(f.socket.readyState).toBe(WebSocket.CLOSING);
        expect(state.assemblingBytes).toBe(0);
        expect(state.outputBytes).toBe(0);
        expect(state.outputPaused).toBe(false);
        // Cancellation must also resolve the promise owning the queued
        // requests. A later event-loop opportunity is a progress barrier,
        // not a time bound.
        expect(
          await Promise.race([
            settled.then(() => true),
            setImmediate().then(() => false),
          ]),
        ).toBe(true);
        expect(state.pendingBytes).toBe(0);
        done!();
        expect(state.pendingBytes).toBe(0);
        expect(f.handled).toEqual(["first"]);
        expect(f.socket.readyState).toBe(WebSocket.CLOSING);
      } finally {
        produce.resolve();
        finishClose();
        await f.close();
      }
    });
  }

  for (const ending of ["close", "error", "callback-error"] as const) {
    it(`cancels request dispatch held at the high mark on \`${ending}\``, async () => {
      const produced = Promise.withResolvers<void>();
      const produce = Promise.withResolvers<void>();
      const f = await routedRequestFixture(
        `flow-${ending}`,
        async (requestId, send) => {
          await produce.promise;
          send(sizedResponse(requestId, HIGH));
          produced.resolve();
        },
        { outputBytesPerSocket: BOUND },
      );
      let callback: ((error?: Error) => void) | undefined;
      using _send = stubOutput(f.socket, (_bytes, done) => callback = done);
      using resume = spy(f.socket, "resume");
      try {
        const state = f.host.accessForTestingOnly.dataSocket(
          f.socket as unknown as WebSocket,
        )!;
        f.socket.receive(f.request("first"));
        await f.socket.receive(f.request("second"));
        const resumed = resume.calls.length;
        produce.resolve();
        await produced.promise;
        await setImmediate();
        expect(state.outputPaused).toBe(true);
        expect(f.socket.isPaused).toBe(true);
        if (ending === "close") f.socket.close();
        else if (ending === "error") f.socket.dispatchEvent(new Event("error"));
        else callback!(new Error("write failed"));
        await f.socket.closed.promise;
        callback!();
        await setImmediate();
        expect(f.handled).toEqual(["first"]);
        expect(resume.calls).toHaveLength(resumed);
      } finally {
        produce.resolve();
        await f.close();
      }
    });
  }

  it("holds malformed input decoding while output is at the high mark", async () => {
    const produced = Promise.withResolvers<void>();
    const produce = Promise.withResolvers<void>();
    const f = await routedRequestFixture(
      "flow-decode",
      async (requestId, send) => {
        await produce.promise;
        send(sizedResponse(requestId, HIGH));
        produced.resolve();
      },
      { outputBytesPerSocket: BOUND },
    );
    const callbacks: (() => void)[] = [];
    using _send = stubOutput(f.socket, (_bytes, done) => {
      assert(done);
      callbacks.push(done);
    });
    try {
      await f.socket.receive(f.request("first"));
      const records = routerRecords({ type: "transact" }, "invalid");
      await f.socket.header(decodeRouterHeader(records.next().value!));
      for (const record of records) {
        f.socket.deliver(record);
      }
      produce.resolve();
      await produced.promise;
      await setImmediate();
      expect(f.socket.readyState).toBe(WebSocket.OPEN);
      while (callbacks.length) callbacks.shift()!();
      await f.socket.closed.promise;
      expect(f.handled).toEqual(["first"]);
    } finally {
      produce.resolve();
      await f.close();
    }
  });

  it("resumes paused reads for the closing handshake without dispatching queued requests", async () => {
    const produced = Promise.withResolvers<void>();
    const f = await routedRequestFixture("flow-closing", (requestId, send) => {
      send(sizedResponse(requestId, HIGH));
      produced.resolve();
    }, { outputBytesPerSocket: BOUND });
    using _send = stubOutput(f.socket, () => {});
    const finishClose = f.socket.close.bind(f.socket);
    using _close = stub(f.socket, "close", () => {
      f.socket.readyState = WebSocket.CLOSING;
    });
    try {
      f.socket.receive(f.request("first"));
      f.socket.receive(f.request("second"));
      await produced.promise;
      await setImmediate();
      expect(f.socket.isPaused).toBe(true);
      f.host.close();
      expect(f.socket.readyState).toBe(WebSocket.CLOSING);
      expect(f.socket.isPaused).toBe(false);
      finishClose();
      await setImmediate();
      expect(f.handled).toEqual(["first"]);
    } finally {
      finishClose();
      await f.close();
    }
  });

  it("holds a host authorization refusal while output is at the high mark", async () => {
    const produced = Promise.withResolvers<void>();
    const f = await routedRequestFixture("flow-refusal", (requestId, send) => {
      send(sizedResponse(requestId, HIGH));
      produced.resolve();
    }, { outputBytesPerSocket: BOUND });
    const callbacks: (() => void)[] = [];
    let hold = true;
    const send = f.socket.send.bind(f.socket);
    using _send = stubOutput(f.socket, (bytes, done) => {
      assert(done);
      if (hold) {
        send(bytes);
        callbacks.push(done);
      } else send(bytes, done);
    });
    try {
      f.socket.receive(f.request("first"));
      f.socket.receive(encodeMemoryBoundary({
        type: "session.open",
        requestId: "refused",
        space: f.space.did(),
        principal: f.outsider.did(),
        session: {},
      }));
      await produced.promise;
      await setImmediate();
      // The first response has been passed to the socket whole; the refusal
      // has not.
      expect(f.socket.output).toHaveLength(1);
      expect(f.handled).toEqual(["first"]);
      hold = false;
      while (callbacks.length) callbacks.shift()!();
      await f.socket.take();
      const refusal =
        decodeRoutedFrame(await f.socket.take(), true, FRAME_SLOTS)
          .body;
      expect(refusal.requestId).toBe("refused");
      expect(refusal.error).toMatchObject({ name: "AuthorizationError" });
      expect(f.handled).toEqual(["first"]);
      expect(f.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      await f.close();
    }
  });

  it("keeps the hard input reservation bound for requests arriving after pause", async () => {
    const produced = Promise.withResolvers<void>();
    // A lone response at the bound, wider than the send window, reaches the
    // high mark and holds dispatch.
    const bound = 2 * ROUTER_SEND_WINDOW_BYTES;
    const f = await routedRequestFixture(
      "flow-input-limit",
      (requestId, send) => {
        send(sizedResponse(requestId, bound));
        produced.resolve();
      },
      { outputBytesPerSocket: bound },
    );
    using _send = stubOutput(f.socket, () => {});
    try {
      f.socket.receive(f.request("first"));
      await produced.promise;
      await setImmediate();
      expect(f.socket.isPaused).toBe(true);
      const state = f.host.accessForTestingOnly.dataSocket(
        f.socket as unknown as WebSocket,
      )!;
      // A body already buffered above the socket completes and keeps its
      // reservation while dispatch is held.
      await f.socket.header({
        route: { type: "transact", requestId: "buffered" },
        bytes: 3 * 1024 * 1024,
        binary: true,
      });
      for (let i = 0; i < 96; i++) {
        f.socket.deliver(routerRecord(1, new Uint8Array(32 * 1024)));
      }
      f.socket.deliver(routerRecord(2));
      expect(state.pendingBytes).toBe(3 * 1024 * 1024);
      expect(state.assemblingBytes).toBe(0);
      // One more request past the 4 MiB budget is refused, credit or not.
      f.socket.deliver(encodeRouterHeader({
        route: { type: "transact", requestId: "over" },
        bytes: 2 * 1024 * 1024,
        binary: true,
        requestOrdinal: f.socket.requestOrdinal + 1,
      }));
      await f.socket.closed.promise;
      expect(f.handled).toEqual(["first"]);
      expect(f.link.readyState).toBe(WebSocket.OPEN);
    } finally {
      await f.close();
    }
  });
});

describe("routed close diagnostics", () => {
  for (const classification of ["single-message", "queued-output"] as const) {
    it(`records the pre-close output operands for \`${classification}\``, async () => {
      const f = await fixture(`output-${classification}`);
      const lines: string[] = [];
      using _info = stub(console, "info", (line: unknown) => {
        lines.push(String(line));
      });
      const connect = f.server.connectRouted.bind(f.server);
      let send: ((message: ServerMessage) => void) | undefined;
      using _connect = stub(f.server, "connectRouted", (sender, ...args) => {
        send = sender;
        return connect(sender, ...args);
      });
      try {
        const socket = await f.dataSocket(await f.issueTicket());
        await socket.take();
        assert(send);
        // A message is refused alone only past the 8 MiB ceiling; behind
        // retained output the 4 MiB queue bound applies.
        const limitBytes = classification === "single-message"
          ? ROUTED_RAW_LIMIT
          : ROUTED_QUEUE_LIMIT;
        const secret = "private-output-payload";
        const message: ServerMessage = {
          type: "response",
          requestId: "diagnostic-request",
          ok: secret + "é".repeat(
            classification === "single-message" ? ROUTED_RAW_LIMIT / 2 : 8,
          ),
        };
        const encoded = encodeMemoryBoundary(message);
        const frameBytes = new TextEncoder().encode(encoded).length;
        expect(frameBytes > ROUTED_RAW_LIMIT).toBe(
          classification === "single-message",
        );
        const bufferedBytes = classification === "single-message"
          ? 0
          : limitBytes - frameBytes + 1;
        if (classification === "queued-output") {
          // Equality is admitted; one more outstanding byte exhausts the budget.
          socket.bufferedAmount = bufferedBytes - 1;
          send(message);
          expect(await socket.take()).toBe(encoded);
          expect(socket.readyState).toBe(1);
        }
        socket.bufferedAmount = bufferedBytes;
        const close = socket.close.bind(socket);
        using _close = stub(socket, "close", () => {
          // Change the live counter during close to test snapshot retention.
          socket.bufferedAmount = 0;
          close();
        });
        expect(() => send!(message)).toThrow("Routed memory output limit");
        await socket.closed.promise;
        expect(socket.output).toHaveLength(0);
        expect(f.link.readyState).toBe(1);
        f.host.close();
        const closed = lines.map((line) => JSON.parse(line)).filter((entry) =>
          entry.verdict === "context-closed"
        );
        expect(closed).toHaveLength(1);
        expect(closed[0]).toMatchObject({
          event: "routed-memory-verdict",
          router: f.router.did(),
          context: routedHex(f.context),
          toolshed: f.toolshed.did(),
          verdict: "context-closed",
          reason: "output-limit",
          outputLimit: {
            frameBytes,
            bufferedBytes,
            limitBytes,
            endpoint: "data",
            classification,
            messageType: "response",
          },
        });
        expect(closed[0].outputLimit.diagnostics).toMatchObject({
          socketBytes: bufferedBytes,
          attemptedSource: {
            kind: "unattributed-response",
            messageType: "response",
            requestId: "diagnostic-request",
          },
          messageSizes: {
            status: classification === "single-message"
              ? "frame-too-large"
              : "measured",
          },
        });
        expect(lines.join("\n")).not.toContain(secret);
      } finally {
        await f.close();
      }
    });
  }

  /** Captures the data-socket sender and opens a data socket for output tests. */
  async function outputFixture(
    name: string,
    limits?: Partial<RoutedHostLimits>,
  ) {
    const f = await fixture(name, { limits });
    const lines: string[] = [];
    const info = stub(console, "info", (line: unknown) => {
      lines.push(String(line));
    });
    const connect = f.server.connectRouted.bind(f.server);
    let send: ((message: ServerMessage) => void) | undefined;
    const connected = stub(f.server, "connectRouted", (sender, ...args) => {
      send = sender;
      return connect(sender, ...args);
    });
    const socket = await f.dataSocket(await f.issueTicket());
    await socket.take();
    assert(send);
    const response = (bytes: number): ServerMessage => ({
      type: "response",
      requestId: "large-sync",
      ok: "x".repeat(bytes),
    });
    const closedVerdicts = () =>
      lines.map((line) => JSON.parse(line)).filter((entry) =>
        entry.verdict === "context-closed"
      );
    return {
      f,
      socket,
      send,
      response,
      closedVerdicts,
      close: async () => {
        info.restore();
        connected.restore();
        await f.close();
      },
    };
  }

  it("delivers a lone 5 MiB response as records and refuses one over 8 MiB as a single message", async () => {
    const o = await outputFixture("output-lone-large");
    try {
      // Nothing is queued on the socket, so the response is admitted past
      // the 4 MiB queue bound, written as 32 KiB records, and reassembled
      // by the SDK's assembler and frame decoder.
      const message = o.response(5 * 1024 * 1024);
      const encoded = encodeMemoryBoundary(message);
      o.send(message);
      const delivered = await o.socket.take();
      expect(delivered).toBe(encoded);
      expect(decodeRoutedFrame(delivered, true, FRAME_SLOTS).body).toEqual(
        message,
      );
      expect(o.socket.readyState).toBe(WebSocket.OPEN);
      // The 8 MiB ceiling is the router's and the SDK's frame limit: no
      // message past it is sent, queued or alone.
      const oversized = o.response(ROUTED_RAW_LIMIT);
      expect(() => o.send(oversized)).toThrow("Routed memory output limit");
      await o.socket.closed.promise;
      o.f.host.close();
      const closed = o.closedVerdicts();
      expect(closed).toHaveLength(1);
      expect(closed[0].outputLimit).toMatchObject({
        frameBytes: new TextEncoder().encode(encodeMemoryBoundary(oversized))
          .length,
        bufferedBytes: 0,
        limitBytes: ROUTED_RAW_LIMIT,
        classification: "single-message",
      });
    } finally {
      await o.close();
    }
  });

  it("refuses a 5 MiB response queued behind retained output over the bound as queued output", async () => {
    const o = await outputFixture("output-queued-large");
    try {
      o.socket.bufferedAmount = 1;
      const message = o.response(5 * 1024 * 1024);
      expect(() => o.send(message)).toThrow("Routed memory output limit");
      await o.socket.closed.promise;
      o.f.host.close();
      const closed = o.closedVerdicts();
      expect(closed).toHaveLength(1);
      expect(closed[0].outputLimit).toMatchObject({
        frameBytes: new TextEncoder().encode(encodeMemoryBoundary(message))
          .length,
        bufferedBytes: 1,
        limitBytes: ROUTED_QUEUE_LIMIT,
        classification: "queued-output",
      });
    } finally {
      await o.close();
    }
  });

  it("admits queued output of any size under a null bound and still refuses one message over 8 MiB", async () => {
    const o = await outputFixture("output-null-bound", {
      outputBytesPerSocket: null,
    });
    try {
      o.socket.bufferedAmount = ROUTED_QUEUE_LIMIT;
      const message = o.response(5 * 1024 * 1024);
      o.send(message);
      expect(await o.socket.take()).toBe(encodeMemoryBoundary(message));
      expect(o.socket.readyState).toBe(WebSocket.OPEN);
      expect(() => o.send(o.response(ROUTED_RAW_LIMIT))).toThrow(
        "Routed memory output limit",
      );
      await o.socket.closed.promise;
      o.f.host.close();
      expect(o.closedVerdicts()[0].outputLimit).toMatchObject({
        limitBytes: ROUTED_RAW_LIMIT,
        classification: "single-message",
      });
    } finally {
      await o.close();
    }
  });

  for (const opportunity of ["pending", "executed", "recovered"] as const) {
    it(`records bounded logical queue history with event-loop marker \`${opportunity}\``, async () => {
      const f = await fixture(`output-marker-${opportunity}`);
      const lines: string[] = [];
      using _info = stub(console, "info", (line: unknown) => {
        lines.push(String(line));
      });
      const connect = f.server.connectRouted.bind(f.server);
      let send: ((message: ServerMessage) => void) | undefined;
      using _connect = stub(f.server, "connectRouted", (sender, ...args) => {
        send = sender;
        return connect(sender, ...args);
      });
      try {
        const socket = await f.dataSocket(await f.issueTicket());
        await socket.take();
        assert(send);
        const writes: Uint8Array[] = [];
        const callbacks: ((error?: Error) => void)[] = [];
        using _send = stubOutput(socket, (bytes, done) => {
          assert(bytes instanceof Uint8Array && done);
          writes.push(bytes);
          callbacks.push(done);
        });
        const secret = "private-diagnostic-payload";
        let admittedBytes = 0;
        for (let i = 0; i < 24; i++) {
          const message: ServerMessage = {
            type: "response",
            requestId: `queued-${i}`,
            ok: secret + "x".repeat(164474),
          };
          admittedBytes +=
            new TextEncoder().encode(encodeMemoryBoundary(message))
              .length;
          send(message);
        }
        // Records are in flight up to the send window and no further.
        const inFlight = writes.reduce(
          (total, record) => total + record.length,
          0,
        );
        expect(inFlight).toBeGreaterThanOrEqual(ROUTER_SEND_WINDOW_BYTES);
        expect(inFlight - writes.at(-1)!.length).toBeLessThan(
          ROUTER_SEND_WINDOW_BYTES,
        );
        if (opportunity === "recovered") {
          while (callbacks.length) callbacks.shift()!();
          await setImmediate();
          socket.bufferedAmount = 4 * 1024 * 1024;
        } else if (opportunity === "executed") {
          await setImmediate();
        }
        const message: ServerMessage = {
          type: "presence/remove",
          space: f.space.did(),
          sessionId: "push-session",
          room: secret + "x".repeat(300000),
          participantId: "participant",
        };
        expect(() => send!(message)).toThrow("Routed memory output limit");
        await socket.closed.promise;
        const closed = lines.map((line) => JSON.parse(line)).filter((entry) =>
          entry.verdict === "context-closed" && entry.reason === "output-limit"
        );
        expect(closed).toHaveLength(1);
        const diagnostics = closed[0].outputLimit.diagnostics;
        expect(diagnostics.attemptedSource).toEqual({
          kind: "push",
          messageType: "presence/remove",
          space: f.space.did(),
          sessionId: "push-session",
        });
        expect(diagnostics.history).toHaveLength(16);
        expect(diagnostics.sender).toMatchObject({
          admittedBodies: 24,
          admittedBytes,
          retainedBytes: opportunity === "recovered" ? 0 : admittedBytes,
          queuedBodies: opportunity === "recovered" ? 0 : 24,
          completedBodies: opportunity === "recovered" ? 24 : 0,
          completedBytes: opportunity === "recovered" ? admittedBytes : 0,
        });
        if (opportunity === "recovered") {
          expect(diagnostics.eventLoop).toBeNull();
          expect(diagnostics.sender.pendingCallbackAgeMs).toBeNull();
          expect(diagnostics.sender.lastCallbackAgeMs).toBeGreaterThanOrEqual(
            0,
          );
          expect(
            diagnostics.history.some((entry: { event: string }) =>
              entry.event === "recovered"
            ),
          ).toBe(true);
          expect(
            diagnostics.history.some((entry: { event: string }) =>
              entry.event === "event-loop"
            ),
          ).toBe(false);
        } else {
          expect(diagnostics.socketBytes).toBe(0);
          expect(diagnostics.sender.pendingRecordKind).toBe(0);
          expect(diagnostics.sender.pendingCallbackAgeMs)
            .toBeGreaterThanOrEqual(0);
          expect(diagnostics.sender.oldestQueuedAgeMs).toBeGreaterThanOrEqual(
            0,
          );
          // Only the socket's initial request credit has been written.
          expect(diagnostics.sender.completedRecords).toBe(1);
          expect(diagnostics.sender.lastCallbackAgeMs).toBeGreaterThanOrEqual(
            0,
          );
          expect(diagnostics.eventLoop.executed).toBe(
            opportunity === "executed",
          );
          expect(diagnostics.eventLoop.ageMs).toBeGreaterThanOrEqual(0);
          if (opportunity === "pending") {
            expect(diagnostics.eventLoop.executedAfterMs).toBeNull();
          } else {
            expect(diagnostics.eventLoop.executedAfterMs)
              .toBeGreaterThanOrEqual(0);
          }
          expect(
            diagnostics.history.some((
              entry: { source?: { requestId: string } },
            ) => entry.source?.requestId === "queued-23"),
          ).toBe(true);
        }
        expect(JSON.stringify(diagnostics)).not.toContain(secret);
      } finally {
        await f.close();
      }
    });
  }

  it("attributes a refused response to its dispatched request before pending cleanup", async () => {
    const f = await fixture("output-request-source");
    const lines: string[] = [];
    using _info = stub(console, "info", (line: unknown) => {
      lines.push(String(line));
    });
    try {
      const session = await f.open();
      f.socket.bufferedAmount = 4 * 1024 * 1024;
      f.socket.receive(encodeMemoryBoundary({
        type: "session.watch.set",
        requestId: "originating-request",
        space: f.space.did(),
        sessionId: session.sessionId,
        watches: [],
      }));
      await f.socket.closed.promise;
      const closed = lines.map((line) => JSON.parse(line)).filter((entry) =>
        entry.verdict === "context-closed"
      );
      expect(closed).toHaveLength(1);
      expect(closed[0].outputLimit.diagnostics.attemptedSource).toEqual({
        kind: "request",
        messageType: "response",
        requestType: "session.watch.set",
        requestId: "originating-request",
        space: f.space.did(),
        sessionId: session.sessionId,
      });
    } finally {
      await f.close();
    }
  });

  for (const count of [12, 300]) {
    it(`measures bounded canonical field and sync sizes across \`${count}\` documents`, async () => {
      // Diagnostics keep their scan bound even with value counting disabled.
      const f = await fixture(`output-sizes-${count}`, {
        limits: { frameSlots: count === 300 ? null : FRAME_SLOTS },
      });
      const lines: string[] = [];
      using _info = stub(console, "info", (line: unknown) => {
        lines.push(String(line));
      });
      const connect = f.server.connectRouted.bind(f.server);
      let send: ((message: ServerMessage) => void) | undefined;
      using _connect = stub(f.server, "connectRouted", (sender, ...args) => {
        send = sender;
        return connect(sender, ...args);
      });
      try {
        const socket = await f.dataSocket(await f.issueTicket());
        await socket.take();
        assert(send);
        const secret = "private-canonical-size-payload";
        const upserts = Array.from({ length: count }, (_, index) => ({
          id: `of:document-${index}`,
          doc: { value: NaN, text: secret + "x".repeat(index * 10) },
        }));
        const schemaTable = Object.fromEntries(
          Array.from({ length: 12 }, (_, index) => [
            `schema-${index}`,
            { description: secret + "x".repeat(index * 10) },
          ]),
        );
        socket.bufferedAmount = 4 * 1024 * 1024;
        expect(() =>
          send!({
            type: "response",
            requestId: "size-request",
            ok: { sync: { upserts, schemaTable }, special: NaN },
          })
        ).toThrow("Routed memory output limit");
        await socket.closed.promise;
        const closed = lines.map((line) => JSON.parse(line)).find((entry) =>
          entry.reason === "output-limit"
        );
        expect(closed).toBeDefined();
        const sizes = closed.outputLimit.diagnostics.messageSizes;
        expect(sizes.status).toBe("measured");
        expect(sizes.fields).toContainEqual({
          path: "ok.special",
          encodedBytes:
            new TextEncoder().encode(encodeMemoryBoundary(NaN)).length,
        });
        expect(sizes.documents).toHaveLength(8);
        const last = count === 12 ? 11 : 253;
        expect(sizes.documents[0]).toEqual({
          path: `ok.sync.upserts.${last}.doc`,
          id: `of:document-${last}`,
          encodedBytes: new TextEncoder().encode(
            encodeMemoryBoundary(upserts[last].doc),
          ).length,
        });
        expect(sizes.truncated).toBe(count === 300);
        expect(sizes.scannedEntries).toBe(count === 12 ? 26 : 256);
        if (count === 12) {
          expect(sizes.schemas).toHaveLength(8);
          expect(sizes.schemas[0]).toEqual({
            path: "ok.sync.schemaTable.schema-11",
            encodedBytes: new TextEncoder().encode(
              encodeMemoryBoundary(schemaTable["schema-11"]),
            ).length,
          });
        } else {
          expect(sizes.schemas).toEqual([]);
        }
        expect(JSON.stringify(closed)).not.toContain(secret);
      } finally {
        await f.close();
      }
    });
  }

  it("carries control output operands into the context close audit", async () => {
    const f = await fixture("control-output-operands");
    const lines: string[] = [];
    using _info = stub(console, "info", (line: unknown) => {
      lines.push(String(line));
    });
    try {
      const limitBytes = 4 * 1024 * 1024;
      f.link.bufferedAmount = limitBytes;
      const close = f.link.close.bind(f.link);
      using _close = stub(f.link, "close", () => {
        f.link.bufferedAmount = 0;
        close();
      });
      // The fixture has completed two control requests. An unknown operation
      // produces a refusal response while retaining its context until send.
      f.link.receive(
        new RoutedWriter("mlq1").time(3).fixed(new Uint8Array([255]))
          .blob(new Uint8Array()).bytes,
      );
      await f.socket.closed.promise;
      f.host.close();
      const closed = lines.map((line) => JSON.parse(line)).filter((entry) =>
        entry.verdict === "context-closed"
      );
      expect(closed).toHaveLength(1);
      expect(closed[0].reason).toBe("output-limit");
      expect(closed[0].outputLimit).toEqual({
        frameBytes: new RoutedWriter("mls1").time(3).fixed(new Uint8Array([1]))
          .blob(new Uint8Array()).bytes.length,
        bufferedBytes: limitBytes,
        limitBytes,
        endpoint: "control",
        classification: "queued-output",
      });
    } finally {
      await f.close();
    }
  });

  it("retains an earlier socket failure without attaching later output operands", async () => {
    const f = await fixture("output-after-socket-error");
    const lines: string[] = [];
    using _info = stub(console, "info", (line: unknown) => {
      lines.push(String(line));
    });
    try {
      f.socket.dispatchEvent(new Event("error"));
      f.socket.bufferedAmount = 4 * 1024 * 1024;
      f.socket.receive(`fvj1:${
        JSON.stringify({
          type: "session.open",
          requestId: "after-error",
          space: f.space.did(),
          principal: f.principal.did(),
          session: {},
        })
      }`);
      await f.socket.closed.promise;
      const closed = lines.map((line) => JSON.parse(line)).filter((entry) =>
        entry.verdict === "context-closed"
      );
      expect(closed).toHaveLength(1);
      expect(closed[0].reason).toBe("data-socket-error");
      expect(closed[0]).not.toHaveProperty("outputLimit");
    } finally {
      await f.close();
    }
  });

  it("keeps a replacement socket's failure reason independent", async () => {
    const f = await fixture("close-replacement");
    const lines: string[] = [];
    using _info = stub(console, "info", (line: unknown) => {
      lines.push(String(line));
    });
    const close = f.socket.close.bind(f.socket);
    using _close = stub(f.socket, "close", () => {
      // The displaced transport reports an error while its close is in flight.
      f.socket.readyState = WebSocket.CLOSING;
      f.socket.dispatchEvent(new Event("error"));
      close();
    });
    try {
      const replacement = await f.dataSocket(await f.issueTicket());
      await replacement.take();
      replacement.close();
      const closed = lines.map((line) => JSON.parse(line)).filter((entry) =>
        entry.verdict === "context-closed"
      );
      expect(closed).toHaveLength(1);
      expect(closed[0].reason).toBe("data-peer-close");
    } finally {
      await f.close();
    }
  });

  for (
    const reason of [
      "data-peer-close",
      "data-socket-error",
      "data-queue-limit",
      "data-protocol",
      "output-limit",
      "socket-send-failure",
      "control-peer-close",
      "control-socket-error",
      "control-frame-invalid",
      "control-queue-limit",
      "control-protocol",
    ] as const
  ) {
    it(`audits \`${reason}\` once without payload or error text`, async () => {
      const f = await fixture(`close-${reason}`);
      const lines: string[] = [];
      using _info = stub(console, "info", (line: unknown) => {
        lines.push(String(line));
      });
      using disposables = new DisposableStack();
      const secret = "private-diagnostic-payload";
      try {
        switch (reason) {
          case "data-peer-close":
            f.socket.close();
            break;
          case "data-socket-error":
            f.socket.dispatchEvent(
              new ErrorEvent("error", { message: secret }),
            );
            f.host.close();
            break;
          case "data-queue-limit":
            f.socket.deliver(
              encodeRouterHeader({
                route: { type: "transact", requestId: "overflow" },
                bytes: 4 * 1024 * 1024 + 1,
                binary: false,
                requestOrdinal: ++f.socket.requestOrdinal,
              }),
            );
            break;
          case "data-protocol":
            f.socket.receive(secret);
            break;
          case "output-limit":
          case "socket-send-failure":
            if (reason === "output-limit") {
              f.socket.bufferedAmount = 4 * 1024 * 1024;
            } else {
              disposables.use(stub(f.socket, "send", () => {
                throw new Error(secret);
              }));
            }
            f.socket.receive(`fvj1:${
              JSON.stringify({
                type: "session.open",
                requestId: "close-diagnostic-request",
                space: f.space.did(),
                principal: f.principal.did(),
                session: {},
              })
            }`);
            break;
          case "control-peer-close":
            f.link.close();
            break;
          case "control-socket-error":
            f.link.dispatchEvent(new ErrorEvent("error", { message: secret }));
            f.host.close();
            break;
          case "control-frame-invalid":
            f.link.receive(new Uint8Array(4097));
            break;
          case "control-queue-limit":
            for (let i = 0; i < 33; i++) f.link.receive(new Uint8Array([0]));
            break;
          case "control-protocol":
            f.link.receive(new Uint8Array([0]));
            break;
        }
        await f.socket.closed.promise;
        // Administrative cleanup must not add an event or replace the cause.
        f.host.close();
        const closed = lines.map((line) => JSON.parse(line)).filter((entry) =>
          entry.verdict === "context-closed"
        );
        expect(closed).toHaveLength(1);
        expect(closed[0].reason).toBe(reason);
        expect(lines.join("\n")).not.toContain(secret);
      } finally {
        await f.close();
      }
    });
  }

  for (
    const reason of [
      "backend-failure",
      "request-cap",
      "duplicate-request",
    ] as const
  ) {
    it(`retains \`${reason}\` through backend and close callbacks`, async () => {
      const f = await fixture(`close-${reason}`, {
        limits: { requestsPerContext: 1 },
      });
      const lines: string[] = [];
      using _info = stub(console, "info", (line: unknown) => {
        lines.push(String(line));
      });
      using disposables = new DisposableStack();
      const secret = "private-backend-error";
      try {
        const connect = f.server.connectRouted.bind(f.server);
        disposables.use(stub(f.server, "connectRouted", (...args) => {
          const backend = connect(...args);
          const receive = backend.receive.bind(backend);
          let hello = true;
          disposables.use(stub(backend, "receive", (payload) => {
            if (reason === "backend-failure") {
              return Promise.reject(new Error(secret));
            }
            if (hello) {
              hello = false;
              return receive(payload);
            }
            // A received request with no response retains its in-flight slot.
            return Promise.resolve();
          }));
          return backend;
        }));
        const socket = await f.dataSocket(await f.issueTicket());
        if (reason !== "backend-failure") {
          await socket.take();
          for (
            const requestId of [
              "first",
              reason === "duplicate-request" ? "first" : "second",
            ]
          ) {
            socket.receive(`fvj1:${
              JSON.stringify({
                type: "session.open",
                requestId,
                space: f.space.did(),
                principal: f.principal.did(),
                session: {},
              })
            }`);
          }
        }
        await socket.closed.promise;
        expect(f.link.readyState).toBe(1);
        const closed = lines.map((line) => JSON.parse(line)).filter((entry) =>
          entry.verdict === "context-closed"
        );
        expect(closed).toHaveLength(1);
        expect(closed[0].reason).toBe(reason);
        expect(lines.join("\n")).not.toContain(secret);
      } finally {
        await f.close();
      }
    });
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
      const hello = decodeRoutedFrame(payload, false, FRAME_SLOTS).body;
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

Deno.test("SDK pins router metadata across toolshed responses and signs pushed renewals", async () => {
  const f = await fixture("sdk-renewal");
  const now = Math.floor(Date.now() / 1000);
  let receiver: ((payload: string) => void) | undefined;
  let challengeNumber = 100, signatures = 0, codec = false;
  const renewed = Promise.withResolvers<void>();
  const challenge = () => ({
    value: routedHex(new Uint8Array(32).fill(++challengeNumber)),
    expiresAt: now + 60,
  });
  const respond = (body: Record<string, unknown>) =>
    receiver!(`fvj1:${JSON.stringify(body)}`);
  const transport: Transport = {
    setReceiver: (callback) => {
      receiver = callback;
    },
    setRoutedMessagesEnabled: (enabled) => {
      codec = enabled;
    },
    close: () => Promise.resolve(),
    send: async (payload) => {
      const body = decodeRoutedFrame(payload, false, FRAME_SLOTS).body;
      if (body.type === "hello") {
        assertEquals(
          (body.flags as Record<string, unknown>).routedAuthV1,
          true,
        );
        respond({
          type: "hello.ok",
          protocol: "memory",
          flags: JSON.parse(new TextDecoder().decode(f.flags)),
          sessionOpen: {
            audience: f.router.did(),
            deployment: "fixture",
            challenge: challenge(),
          },
        });
      } else if (body.type === "connection.challenge") {
        respond({
          type: "response",
          requestId: body.requestId,
          ok: { challenge: challenge() },
        });
      } else if (body.type === "connection.auth") {
        const statement = readRoutedBase64(body.statement);
        const signed = await readRoutedStatement(statement);
        assertEquals(signed.router, f.router.did());
        assertEquals(signed.deployment, "fixture");
        const proof = await f.attest(statement);
        assertEquals(
          (await f.control(
            6,
            new RoutedWriter("mvp1").fixed(f.context).blob(f.flags).blob(proof)
              .bytes,
          )).status,
          0,
        );
        respond({
          type: "response",
          requestId: body.requestId,
          ok: { principal: signed.principal, expiresAt: signed.exp },
        });
        if (++signatures === 3) renewed.resolve();
      } else {
        const response = await f.request(body);
        respond({ ...response, requestId: body.requestId });
      }
    },
  };
  const client = await connect({ transport });
  const signer = (identity: Identity) => ({
    did: identity.did(),
    authorizeSessionOpen: () => {
      throw new Error("Routed opens must use connection auth");
    },
    authorizeConnection: async (
      context: {
        audience: string;
        deployment?: string;
        challenge: { value: string };
      },
    ) => {
      assertEquals(context.audience, f.router.did());
      assertEquals(context.deployment, "fixture");
      return {
        statement: routedBase64(
          await routedStatementPayload({
            principal: identity.did(),
            router: context.audience,
            deployment: context.deployment!,
            challenge: readRoutedHex(context.challenge.value, 32),
            iat: now,
            exp: now + 600,
          }).sign(identity),
        ),
      };
    },
  });
  try {
    assert(codec);
    const session = await client.mount(f.space.did(), {}, signer(f.principal));
    await assertRejects(() =>
      client.mount(f.space.did(), {}, signer(f.outsider))
    );
    assertEquals(signatures, 2);
    respond({
      type: "connection/challenge",
      principal: f.principal.did(),
      challenge: challenge(),
    });
    await renewed.promise;
    await session.watchSet([]);
    const view = await session.watchAdd([{
      id: "sdk-acl",
      kind: "graph",
      query: {
        roots: [{
          id: `of:${f.space.did()}`,
          selector: { path: [], schema: false },
        }],
      },
    }]);
    assertEquals(view.entities.length, 1);
    assertEquals(signatures, 3);
  } finally {
    await client.close();
    await f.close();
  }
});

Deno.test("a release needs no durable record, and a proof without the ledger closes the host", async () => {
  const f = await fixture("failed-release");
  try {
    await f.open();
    f.epochs.close();
    // A release lasts only as long as its context, so it records nothing.
    assertEquals(
      (await f.control(
        4,
        new RoutedWriter("mrl1").fixed(f.context).text(f.principal.did()).bytes,
      )).status,
      0,
    );
    // An admission still fails closed once the ledger is gone.
    await assertRejects(async () =>
      f.control(
        6,
        new RoutedWriter("mvp1").fixed(f.context).blob(f.flags).blob(
          await f.proof(f.outsider),
        ).bytes,
      )
    );
    assertEquals(f.socket.readyState, 3);
    assertEquals(f.link.readyState, 3);
  } finally {
    await f.close();
  }
});

Deno.test("toolshed space control and revocation deny stale ownership and close failed durable custody", async () => {
  const f = await fixture("space-control");
  try {
    assertEquals(
      (await f.control(
        5,
        new RoutedWriter("mas1").fixed(f.context).text(f.space.did()).time(1)
          .bytes,
      )).status,
      0,
    );
    assertEquals(
      (await f.control(
        4,
        new RoutedWriter("mrl1").fixed(f.context).text(f.outsider.did()).bytes,
      )).status,
      0,
    );
    const session = await f.open();
    const watch = {
      id: "added",
      kind: "graph",
      query: {
        roots: [{ id: "of:visible", selector: { path: [], schema: false } }],
      },
    };
    assert(
      (await f.request({
        type: "session.watch.add",
        space: f.space.did(),
        sessionId: session.sessionId,
        watches: [watch],
      })).ok !== undefined,
    );
    f.advanceOwnership();
    assertEquals(
      (await f.control(
        5,
        new RoutedWriter("mas1").fixed(f.context).text(f.space.did()).time(2)
          .bytes,
      )).status,
      1,
    );
    f.epochs.close();
    f.host.close();
    assertEquals(f.socket.readyState, 3);
    assertEquals(f.link.readyState, 3);
  } finally {
    await f.close();
  }
});

Deno.test("invalid private endpoints and frame types have no authority; revocation fails closed without a ledger", async () => {
  const f = await fixture("private-admission");
  try {
    for (
      const [path, peer] of [["/api/storage/memory", "127.0.0.1"], [
        "/memory/router-link",
        "127.0.0.2",
      ]]
    ) {
      const socket = new FramedSocket();
      f.host.accept(socket as unknown as WebSocket, path, peer);
      assertEquals(socket.readyState, 3);
    }
    const untrusted = new FramedSocket();
    f.host.accept(
      untrusted as unknown as WebSocket,
      "/memory/router-link",
      "127.0.0.1",
    );
    await untrusted.bytes();
    untrusted.receive("text-not-binary-link");
    await untrusted.closed.promise;
    assertEquals(f.link.readyState, 1);
    f.epochs.close();
    let refused = false;
    try {
      f.host.revokeRouter(f.router.did());
    } catch {
      refused = true;
    }
    assert(refused);
    assertEquals(f.socket.readyState, 3);
    assertEquals(f.host.acceptsPeer("127.0.0.1"), false);
  } finally {
    await f.close();
  }
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
    const parsed = new RoutedReader(greeting.slice(0, -64), "rph1");
    assertEquals(parsed.text(), f.toolshed.did());
    const closed = new Promise<void>((resolve) => link.once("close", resolve));
    link.send(new Uint8Array([1, 2, 3]));
    await closed;
    assertEquals(f.socket.readyState, 1);

    const ticket = await f.issueTicket();
    const data = socket("/memory/router-data");
    const dataGreeting = await new Promise<Uint8Array>((resolve) =>
      data.once(
        "message",
        (bytes) => resolve(new Uint8Array(bytes as ArrayBuffer)),
      )
    );
    const reader = new RoutedReader(dataGreeting.slice(0, -64), "rdh1");
    expect(reader.text()).toBe(f.toolshed.did());
    const nonce = reader.fixed(32), issued = reader.time();
    reader.end();
    const binding = await new RoutedWriter("rdb1")
      .text(f.router.did()).text("fixture").text(f.toolshed.did())
      .fixed(new Uint8Array(16).fill(11)).fixed(f.context).fixed(ticket)
      .fixed(nonce).time(issued).fixed(sha256(f.flags))
      .fixed(sha256(routedFlags(f.encodingFlags))).sign(f.router);
    // The toolshed's ready and its first credit can arrive in one read, so
    // one listener takes both, in order.
    const ready = Promise.withResolvers<string>();
    const credits: number[] = [];
    const granted = Promise.withResolvers<void>();
    const assembler = new RouterAssembler();
    const responses: ((body: Record<string, unknown>) => void)[] = [];
    data.on("message", (bytes, binary) => {
      if (!binary) {
        ready.resolve(bytes.toString());
        return;
      }
      const record = new Uint8Array(bytes as ArrayBuffer);
      if (isRouterRequestCredit(record)) {
        credits.push(decodeRouterRequestCredit(record));
        granted.resolve();
        return;
      }
      const complete = assembler.receive(record);
      if (complete !== undefined) {
        const body =
          decodeRoutedFrame(complete.payload, true, FRAME_SLOTS).body;
        expect(complete.header.route).toEqual(routerRoute(body));
        responses.shift()?.(body);
      }
    });
    data.send(JSON.stringify({
      type: "router.hello",
      version: 1,
      memoryFlags: JSON.parse(new TextDecoder().decode(f.flags)),
      negotiatedMemoryFlags: f.encodingFlags,
      routerRequestCredit: true,
      routerTicket: routedHex(ticket),
      routerBinding: routedBase64(binding),
    }));
    expect(JSON.parse(await ready.promise)).toMatchObject({
      type: "router.ready",
      version: 1,
      memoryFlags: { routedAuthV1: true },
      routerEncodingNegotiation: true,
      routerRequestCredit: true,
      negotiatedMemoryFlags: f.encodingFlags,
    });
    const opened = new Promise<Record<string, unknown>>((resolve) =>
      responses.push(resolve)
    );
    const open = {
      type: "session.open",
      requestId: "tls-open",
      space: f.space.did(),
      principal: f.principal.did(),
      session: {},
    };
    const records = routerRecords(
      routerRoute(open),
      `fvj1:${JSON.stringify(open)}`,
      1,
    );
    // The toolshed grants its whole window once ready; the request goes
    // header and body together within it.
    await granted.promise;
    expect(credits).toEqual([ROUTER_REQUEST_WINDOW]);
    const header = records.next().value!;
    data.send(header);
    for (const record of records) {
      data.send(record);
    }
    expect(await opened).toMatchObject({
      type: "response",
      requestId: "tls-open",
      ok: { sessionId: expect.any(String) },
    });
  } finally {
    for (const socket of sockets) socket.terminate();
    client.close();
    await listener.close();
    await f.close();
  }
});

Deno.test("quota totals return to zero after sessions, watches and refusals come and go", async () => {
  const watches = (prefix: string, length: number) =>
    Array.from(
      { length },
      (_, i) => ({ id: `${prefix}${i}`, kind: "graph", query: { roots: [] } }),
    );
  const f = await fixture("quota-churn", {
    limits: {
      sessionsPerContext: 3,
      sessionsPerRouter: 3,
      sessionsPerToolshed: 3,
      sessionsPerPrincipal: 3,
      watchesPerContext: 10,
      watchesPerSession: 10,
      watchesPerRouter: 10,
      watchesPerToolshed: 10,
      watchesPerPrincipal: 10,
    },
  });
  try {
    const space = f.space.did();
    const openRaw = () =>
      f.request({
        type: "session.open",
        space,
        principal: f.principal.did(),
        session: {},
      });
    for (let round = 0; round < 5; round++) {
      const a = await f.open(), b = await f.open(), c = await f.open();
      // A fourth is refused at every scope's limit.
      assert((await openRaw()).error !== undefined);
      assert(
        (await f.request({
          type: "session.watch.set",
          space,
          sessionId: a.sessionId,
          watches: watches(`a${round}-`, 6),
        })).ok !== undefined,
      );
      // Refused: 6 + 5 > 10.
      assert(
        (await f.request({
          type: "session.watch.set",
          space,
          sessionId: b.sessionId,
          watches: watches(`b${round}-`, 5),
        })).error !== undefined,
      );
      assert(
        (await f.request({
          type: "session.watch.add",
          space,
          sessionId: b.sessionId,
          watches: watches(`c${round}-`, 4),
        })).ok !== undefined,
      );
      // Resume an existing session (reservation on its own key).
      const resumed = await f.request({
        type: "session.open",
        space,
        principal: f.principal.did(),
        session: { sessionId: c.sessionId, sessionToken: c.sessionToken },
      });
      assertEquals(resumed.type, "response");
      for (const s of [a, b, c]) {
        const closed = await f.request({
          type: "session.close",
          space,
          sessionId: s.sessionId,
        });
        assert(closed.ok !== undefined, JSON.stringify(closed));
      }
    }
    // Back to zero: exactly three sessions and ten watches fit again.
    const a = await f.open(), b = await f.open(), c = await f.open();
    assert(
      (await openRaw()).error !== undefined,
      "a leak would refuse earlier; a negative total admits a fourth",
    );
    assert(
      (await f.request({
        type: "session.watch.set",
        space,
        sessionId: a.sessionId,
        watches: watches("z", 10),
      })).ok !== undefined,
      "watches leaked",
    );
    assert(
      (await f.request({
        type: "session.watch.set",
        space,
        sessionId: b.sessionId,
        watches: watches("y", 1),
      })).error !== undefined,
      "watch total went negative",
    );
    void c;
    assertEquals(f.socket.readyState, 1);
  } finally {
    await f.close();
  }
});

Deno.test("quota totals return to zero across socket replacement and context close", async () => {
  const f = await fixture("quota-churn-close", {
    limits: {
      sessionsPerContext: 3,
      sessionsPerRouter: 3,
      sessionsPerToolshed: 3,
      sessionsPerPrincipal: 3,
      watchesPerContext: 10,
      watchesPerSession: 10,
      watchesPerRouter: 10,
      watchesPerToolshed: 10,
      watchesPerPrincipal: 10,
    },
  });
  const space = f.space.did();
  const watches = (prefix: string, length: number) =>
    Array.from(
      { length },
      (_, i) => ({ id: `${prefix}${i}`, kind: "graph", query: { roots: [] } }),
    );
  const flagObject = {
    ...f.server.memoryProtocolFlags(),
    routedCompressionV1: true,
    modernCellRep: true,
    connectionAuth: true,
    routedAuthV1: true,
  };
  const epoch = new Uint8Array(16).fill(11);
  async function socketFor(ctx: Uint8Array, ticket: Uint8Array) {
    const socket = new FramedSocket();
    f.host.accept(
      socket as unknown as WebSocket,
      "/memory/router-data",
      "127.0.0.1",
    );
    const greeting = new RoutedReader(
      (await socket.bytes()).slice(0, -64),
      "rdh1",
    );
    greeting.text();
    const nonce = greeting.fixed(32), issued = greeting.time();
    greeting.end();
    const binding = await new RoutedWriter("rdb1").text(f.router.did()).text(
      "fixture",
    )
      .text(f.toolshed.did()).fixed(epoch).fixed(ctx).fixed(ticket).fixed(nonce)
      .time(issued).fixed(sha256(f.flags))
      .fixed(sha256(routedFlags(f.encodingFlags))).sign(f.router);
    socket.receive(`fvj1:${
      JSON.stringify({
        type: "hello",
        protocol: "memory",
        flags: flagObject,
        negotiatedMemoryFlags: f.encodingFlags,
        routerTicket: routedHex(ticket),
        routerBinding: routedBase64(binding),
      })
    }`);
    assertEquals(
      decodeRoutedFrame(await socket.take(), true, FRAME_SLOTS).body.type,
      "hello.ok",
    );
    let n = 0;
    const request = async (body: Record<string, unknown>) => {
      const requestId = `q${++n}`;
      socket.receive(
        encodeRoutedFrame(
          `fvj1:${JSON.stringify({ ...body, requestId })}`,
          FRAME_SLOTS,
        ),
      );
      while (true) {
        const m =
          decodeRoutedFrame(await socket.take(), true, FRAME_SLOTS).body;
        if (m.requestId === requestId) return m;
      }
    };
    return { socket, request };
  }
  const ticketFor = async (ctx: Uint8Array) => {
    const issued = await f.control(
      1,
      new RoutedWriter("mat1").fixed(ctx).blob(f.flags).text(space).time(1)
        .bytes,
    );
    assertEquals(issued.status, 0);
    return issued.bytes;
  };
  type Req = (b: Record<string, unknown>) => Promise<Record<string, unknown>>;
  const open = (request: Req) =>
    request({
      type: "session.open",
      space,
      principal: f.principal.did(),
      session: {},
    });
  async function fill(request: Req) {
    const ok = [];
    for (let i = 0; i < 4; i++) ok.push((await open(request)).ok !== undefined);
    return ok;
  }
  try {
    // Socket 1 holds three sessions with watches, then is replaced.
    const s1 = [await f.open(), await f.open(), await f.open()];
    assert(
      (await f.request({
        type: "session.watch.set",
        space,
        sessionId: s1[0].sessionId,
        watches: watches("a", 9),
      })).ok !== undefined,
    );
    const t2 = await ticketFor(f.context);
    const second = await socketFor(f.context, t2);
    assertEquals(await fill(second.request), [true, true, true, false]);
    const sid = await second.request({
      type: "session.open",
      space,
      principal: f.principal.did(),
      session: {},
    });
    void sid;
    // Close the context; a new one starts from zero at every shared scope.
    assertEquals((await f.control(3, f.context)).status, 0);
    const ctx2 = new Uint8Array(16).fill(90);
    const t3 = await ticketFor(ctx2);
    assertEquals(
      (await f.control(
        2,
        new RoutedWriter("map1").fixed(t3).blob(
          await f.proof(f.principal, 600, ctx2),
        ).bytes,
      )).status,
      0,
    );
    const third = await socketFor(ctx2, t3);
    assertEquals(await fill(third.request), [true, true, true, false]);
  } finally {
    await f.close();
  }
});
