/** Real toolshed authority behind an in-process framed router peer. */
// @ts-types="@types/ws"
import WebSocket from "ws";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { toFileUrl } from "@std/path";
import { stub } from "@std/testing/mock";
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
import {
  DEFAULT_ROUTED_HOST_LIMITS,
  type RoutedHostLimits,
  routedHostLimits,
  routedHostLimitsFor,
  RoutedMemoryHost,
} from "../v2/routed-host.ts";
import { listenRoutedMemory } from "../v2/routed-listener.ts";
import {
  decodeRoutedFrame,
  encodeRoutedFrame,
  routedFlags,
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
} from "../v2/routed-wire.ts";
import { Server } from "../v2/server.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";

/** The frame cap the test's router peer and clients apply, the toolshed's default. */
const FRAME_SLOTS = DEFAULT_ROUTED_HOST_LIMITS.frameSlots;

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
      const timeout = setTimeout(
        () =>
          this.changed.reject(new Error("Framed test peer response deadline")),
        5000,
      );
      try {
        await this.changed.promise;
      } finally {
        clearTimeout(timeout);
      }
    }
    return this.output.shift()!;
  }
  async bytes(): Promise<Uint8Array> {
    const bytes = await this.take();
    assert(bytes instanceof Uint8Array);
    return bytes;
  }
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
  }: {
    modernCellRep?: boolean;
    clientModernCellRep?: boolean;
    limits?: Partial<RoutedHostLimits>;
    /** The toolshed's time and the time proofs are made at, if not now. */
    clock?: { now: number };
    /** Routers the toolshed also allows, which never link. */
    otherRouters?: number;
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
  const at = () => clock?.now ?? Math.floor(Date.now() / 1000);
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
  const flagObject = {
    ...server.memoryProtocolFlags(),
    modernCellRep: clientModernCellRep,
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
  async function socketBeforeHello(presented = ticket) {
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
      .text(toolshed.did()).fixed(epoch).fixed(context).fixed(presented).fixed(
        nonce,
      )
      .time(issued).fixed(sha256(flags)).sign(router);
    const hello = `fvj1:${
      JSON.stringify({
        type: "hello",
        protocol: "memory",
        flags: flagObject,
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
  const greeted =
    decodeRoutedFrame(await socket.take(), true, FRAME_SLOTS).body;
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

Deno.test("routed host limits are config over defaults, and must nest", () => {
  assertEquals(routedHostLimits(), DEFAULT_ROUTED_HOST_LIMITS);
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
      { principalsPerContext: 130, proofsPerContext: 300 },
      // No proof left for a remembered principal or an active one's renewal.
      { proofsPerContext: 143 },
      // A context with no ticket to open its first space with.
      { tickets: 511 },
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
    assertEquals(f.socket.readyState, 1);
  } finally {
    await f.close();
  }
  f = await fixture("watch-limit", { limits: { watchesPerContext: 1500 } });
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

Deno.test("watch IDs added past a session's bound are refused, and the socket stays open", async () => {
  const f = await fixture("watch-add-bound");
  const watches = (prefix: string, length: number) =>
    Array.from(
      { length },
      (_, i) => ({ id: `${prefix}${i}`, kind: "graph", query: { roots: [] } }),
    );
  try {
    const session = await f.open();
    const mutate = (type: string, list: unknown[]) =>
      f.request({
        type,
        space: f.space.did(),
        sessionId: session.sessionId,
        watches: list,
      });
    // One request names at most 1,024 watch IDs, and the session holds them.
    assert((await mutate("session.watch.set", watches("a", 1024))).ok);
    // One more ID, added by a later request, is within that request's bound
    // and would leave the session with more than its own.
    const reasons = await refusalReasons(async () => {
      const added = await mutate("session.watch.add", watches("b", 1));
      assertEquals(
        (added.error as { message?: string }).message,
        "Routed memory request denied",
      );
      // A fixed bound: refused for good.
      assertEquals(
        (added.error as { retriable?: boolean }).retriable,
        undefined,
      );
    });
    assertEquals(reasons, ["frame-limit"]);
    assertEquals(f.socket.readyState, 1);
    // The refusal changed nothing the session holds: an ID it already has
    // is still added, and a replacement set at the bound is still taken.
    assert((await mutate("session.watch.add", watches("a", 1))).ok);
    assert((await mutate("session.watch.set", watches("c", 1024))).ok);
    assertEquals(f.socket.readyState, 1);
  } finally {
    await f.close();
  }
});

Deno.test("holdings and views named on a watch add leave a session's counted usage as it was", async () => {
  setServerExecutionConfig(true);
  // Two views and four holdings are all the context may hold of each.
  const f = await fixture("add-names-watches", {
    limits: { watchesPerContext: 2, holdingsPerContext: 4 },
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
      const f = await fixture("unlisted", { limits });
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error("a frame over the slot cap left the socket open")),
        5000,
      );
    });
    try {
      await Promise.race([f.socket.closed.promise, deadline]);
    } finally {
      clearTimeout(timer);
    }
    assertEquals(f.link.readyState, 1);
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
    await new Promise((resolve) => setTimeout(resolve, 50));
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
        // The router binds the client's own flags to the ticket, so the
        // toolshed's handshake sees the disagreement and admits nothing after.
        assertEquals(f.greeted.type, "response");
        const refusal = f.greeted.error as { name: string; message: string };
        assertEquals(refusal.name, "ProtocolError");
        assert(refusal.message.includes("memory flag mismatch"));
        f.socket.receive(
          encodeRoutedFrame(
            `fvj1:${
              JSON.stringify({
                type: "session.open",
                requestId: "after-refusal",
                space: f.space.did(),
                principal: f.principal.did(),
                session: {},
              })
            }`,
            FRAME_SLOTS,
          ),
        );
        const after =
          decodeRoutedFrame(await f.socket.take(), true, FRAME_SLOTS).body;
        assertEquals(after.ok, undefined);
        assertEquals(
          (after.error as { name: string }).name,
          "ProtocolError",
        );
      } finally {
        await f.close();
      }
    }
  }
  setModernCellRepConfig(true);
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
    limits: { watchesPerContext: 1024 },
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
      "mdh1",
    );
    greeting.text();
    const nonce = greeting.fixed(32), issued = greeting.time();
    greeting.end();
    const binding = await new RoutedWriter("mdb1").text(f.router.did()).text(
      "fixture",
    )
      .text(f.toolshed.did()).fixed(epoch).fixed(ctx).fixed(ticket).fixed(nonce)
      .time(issued).fixed(sha256(f.flags)).sign(f.router);
    socket.receive(`fvj1:${
      JSON.stringify({
        type: "hello",
        protocol: "memory",
        flags: flagObject,
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
