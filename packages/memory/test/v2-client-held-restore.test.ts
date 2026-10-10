/**
 * A retriable reopen denial on a connection-authenticated session holds that
 * session alone: the router sends one while a space's toolshed is down, and
 * the connection's other spaces must keep working meanwhile.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { setModernCellRepConfig } from "@commonfabric/data-model/cell-rep";
import { getMemoryProtocolFlags } from "../v2.ts";
import {
  connect,
  RESTORE_CONCURRENCY,
  type SessionPrincipal,
  settleBounded,
  type SpaceSession,
  type Transport,
} from "../v2/client.ts";
import {
  readRoutedHex,
  routedBase64,
  routedStatementPayload,
} from "../v2/routed-wire.ts";

setModernCellRepConfig(true);
const identity = await Identity.fromRaw(new Uint8Array(32).fill(161));
const SPACE_A = "did:key:z6Mk-held-restore-a";
const SPACE_B = "did:key:z6Mk-held-restore-b";
const SPACE_C = "did:key:z6Mk-held-restore-c";
/** How long the peer's challenges last, in seconds. */
let challengeLife = 60;
const challenge = () => ({
  value: "22".repeat(32),
  expiresAt: Math.floor(Date.now() / 1000) + challengeLife,
});
/** A direct peer's session-open metadata names no deployment. */
const sessionOpen = (direct = false) => ({
  audience: identity.did(),
  ...(direct ? {} : { deployment: "held-restore" }),
  challenge: challenge(),
});

/**
 * How the peer answers an open or a watch set: as the session resumed, as a
 * new server session, with a retriable or permanent denial, with a
 * SessionError, or not until the test releases it with an answer.
 */
type Reply =
  | "ok"
  | "new"
  | "retriable"
  | "permanent"
  | "session-error"
  | "hold";

/**
 * A routed peer that can drop its connection. Each space's opens and watch
 * sets are numbered from 1, the mount's, and the script decides each answer.
 */
class RoutedPeer implements Transport {
  readonly opens = new Map<string, number>();
  readonly watchSets = new Map<string, number>();
  readonly transacts = new Map<string, number>();
  readonly held: ((answer?: Reply) => void)[] = [];
  hellos = 0;
  /** How often the client discarded the connection. */
  resets = 0;
  /** While set, `hello` is answered only once it settles. */
  helloGate: Promise<void> | undefined;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #seq = 0;

  constructor(
    readonly reply: (space: string, open: number) => Reply,
    readonly watchSet: (space: string, n: number) => Reply = () => "ok",
    resettable = true,
    readonly options: {
      /** Answer as a direct peer, which signs each open. */
      direct?: boolean;
      /** Drop the connection just after each retriable open denial. */
      dropOnDenial?: boolean;
    } = {},
  ) {
    if (!resettable) this.reset = undefined;
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  setRoutedMessagesEnabled(): void {}

  reset?(): void {
    this.resets++;
  }

  drop(): void {
    this.#closeReceiver(new Error("connection dropped"));
  }

  push(body: Record<string, unknown>): void {
    this.#receiver(`fvj1:${JSON.stringify(body)}`);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  #count(map: Map<string, number>, space: string): number {
    const n = (map.get(space) ?? 0) + 1;
    map.set(space, n);
    return n;
  }

  #error(reply: Reply) {
    return reply === "session-error"
      ? { name: "SessionError", message: "Session restore failed" }
      : {
        name: "AuthorizationError",
        message: "Routed memory request denied",
        ...(reply === "retriable" ? { retriable: true } : {}),
      };
  }

  send(payload: string): Promise<void> {
    const body = JSON.parse(payload.slice(5));
    const respond = (result: Record<string, unknown>) =>
      this.push({ type: "response", requestId: body.requestId, ...result });
    switch (body.type) {
      case "hello": {
        this.hellos++;
        const answer = () =>
          this.push({
            type: "hello.ok",
            protocol: "memory",
            flags: {
              ...getMemoryProtocolFlags(),
              modernCellRep: true,
              connectionAuth: !this.options.direct,
              routedAuthV1: !this.options.direct,
            },
            sessionOpen: sessionOpen(this.options.direct),
          });
        if (this.helloGate === undefined) answer();
        else void this.helloGate.then(answer);
        break;
      }
      case "connection.challenge":
        respond({ ok: { challenge: challenge() } });
        break;
      case "connection.auth":
        respond({
          ok: {
            principal: identity.did(),
            expiresAt: Math.floor(Date.now() / 1000) + 600,
          },
        });
        break;
      case "session.open": {
        const open = this.#count(this.opens, body.space);
        const ok = (resumed: boolean) =>
          respond({
            ok: {
              sessionId: resumed
                ? body.session.sessionId ?? `session:${body.space}`
                : `session:${body.space}:${open}`,
              sessionToken: "token",
              serverSeq: this.#seq,
              resumed,
              sessionOpen: sessionOpen(this.options.direct),
            },
          });
        const answer = (reply: Reply) => {
          if (reply === "ok") ok(open > 1);
          else if (reply === "new") ok(false);
          else if (reply === "hold") {
            this.held.push((then = "ok") => answer(then));
          } else {
            respond({ error: this.#error(reply) });
            if (reply === "retriable" && this.options.dropOnDenial) {
              setTimeout(() => this.drop(), 1);
            }
          }
        };
        answer(this.reply(body.space, open));
        break;
      }
      case "session.watch.add":
        respond({ ok: { serverSeq: this.#seq, sync: emptySync() } });
        break;
      case "session.watch.set": {
        const answer = (reply: Reply) => {
          if (reply === "ok") {
            respond({ ok: { serverSeq: this.#seq, sync: emptySync() } });
          } else if (reply === "hold") {
            this.held.push((then = "ok") => answer(then));
          } else respond({ error: this.#error(reply) });
        };
        answer(this.watchSet(
          body.space,
          this.#count(this.watchSets, body.space),
        ));
        break;
      }
      case "transact":
        this.#count(this.transacts, body.space);
        respond({ ok: { seq: ++this.#seq, branch: "", revisions: [] } });
        break;
      default:
        respond({ ok: {} });
    }
    return Promise.resolve();
  }
}

const emptySync = () => ({
  type: "sync",
  fromSeq: 0,
  toSeq: 0,
  upserts: [],
  removes: [],
});

function principal(): SessionPrincipal {
  return {
    did: identity.did(),
    authorizeSessionOpen: () => {
      throw new Error("Routed session uses connection authority");
    },
    authorizeConnection: async (context) => ({
      statement: routedBase64(
        await routedStatementPayload({
          principal: identity.did(),
          router: context.audience,
          deployment: context.deployment!,
          challenge: readRoutedHex(context.challenge.value, 32),
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 600,
        }).sign(identity),
      ),
    }),
  };
}

/** A principal that also signs each open, as against a direct peer. */
function signingPrincipal(): SessionPrincipal {
  return { ...principal(), authorizeSessionOpen: () => undefined };
}

/** Records when each handshake is sent. */
function recordHellos(peer: RoutedPeer): number[] {
  const at: number[] = [];
  const send = peer.send.bind(peer);
  peer.send = (payload: string) => {
    if (payload.includes('"type":"hello"')) at.push(Date.now());
    return send(payload);
  };
  return at;
}

const commit = (localSeq: number) => ({
  localSeq,
  reads: { confirmed: [], pending: [] },
  operations: [{
    op: "set" as const,
    id: `of:held-restore-${localSeq}`,
    value: { value: localSeq },
  }],
});

/** Waits until `ready` holds, polling the event loop. */
async function until(ready: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rejects if `promise` has not settled within `ms`. */
const within = <T>(promise: Promise<T>, ms = 5000) =>
  Promise.race([
    promise,
    pause(ms).then(() => {
      throw new Error("did not settle in time");
    }),
  ]);

/**
 * Counts the timers still pending, since Deno's test sanitizer does not
 * report a timer left behind. `short()` counts those under a minute, which
 * leaves out a principal's renewal.
 */
function trackTimers() {
  const live = new Map<ReturnType<typeof setTimeout>, number>();
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  globalThis.setTimeout = ((
    run: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    const id = set(() => {
      live.delete(id);
      run(...args);
    }, ms);
    live.set(id, ms ?? 0);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
    if (id !== undefined) live.delete(id);
    clear(id);
  }) as typeof clearTimeout;
  return {
    live: () => live.size,
    short: () => [...live.values()].filter((ms) => ms < 60_000).length,
    restore() {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
    },
  };
}

const settled = (promise: Promise<unknown>) => {
  let done = false;
  promise.then(() => done = true, () => done = true);
  return () => done;
};

Deno.test("a retriable reopen denial holds only that session on a shared connection", async () => {
  // After the drop, A's reopens are denied twice, as while its toolshed is
  // down, and then succeed.
  const peer = new RoutedPeer((space, open) =>
    space === SPACE_A && (open === 2 || open === 3) ? "retriable" : "ok"
  );
  const client = await connect({ transport: peer });
  try {
    const a: SpaceSession = await client.mount(SPACE_A, {}, principal());
    const b: SpaceSession = await client.mount(SPACE_B, {}, principal());
    peer.drop();
    await until(() => (peer.opens.get(SPACE_A) ?? 0) >= 2);
    const pendingA = a.transact(commit(1));
    const doneA = settled(pendingA);
    // B restores and commits while A is held, and a new mount proceeds.
    await client.restoreConnection();
    assertEquals((await b.transact(commit(1))).seq > 0, true);
    await client.mount(SPACE_C, {}, principal());
    assertEquals(doneA(), false);
    // A's held reopen succeeds on the same connection, and its commit lands.
    assert((await pendingA).seq > 0);
    assertEquals(a.held, false);
    assertEquals(peer.opens.get(SPACE_A), 4);
    assertEquals(peer.opens.get(SPACE_B), 2);
    assertEquals(peer.hellos, 2);
  } finally {
    await client.close();
  }
});

Deno.test("a reconnect reopens a bounded number of sessions at once", async () => {
  // A router counts each open in flight against the connection; all of a
  // large connection's reopens at once would meet its limit.
  const peer = new RoutedPeer((_space, open) => open === 1 ? "ok" : "hold");
  const client = await connect({ transport: peer });
  try {
    const spaces = Array.from(
      { length: RESTORE_CONCURRENCY * 2 + 5 },
      (_, i) => `did:key:z6Mk-bounded-restore-${i}`,
    );
    for (const space of spaces) await client.mount(space, {}, principal());
    peer.drop();
    await until(() => peer.held.length === RESTORE_CONCURRENCY);
    await pause(20);
    assertEquals(peer.held.length, RESTORE_CONCURRENCY);
    // Each answered reopen frees one slot for the next.
    for (let answered = 0; answered < spaces.length; answered++) {
      await until(() => peer.held.length > 0);
      assert(peer.held.length <= RESTORE_CONCURRENCY);
      peer.held.shift()!();
    }
    await client.restoreConnection();
    for (const space of spaces) assertEquals(peer.opens.get(space), 2);
  } finally {
    await client.close();
  }
});

Deno.test("settleBounded runs at most the limit at once and settles in order", async () => {
  let running = 0, most = 0;
  const results = await settleBounded([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running++;
    most = Math.max(most, running);
    await pause(n % 3);
    running--;
    if (n === 4) throw new Error("four");
    return n * 10;
  });
  assertEquals(most, 3);
  assertEquals(
    results.map((r) => r.status === "fulfilled" ? r.value : "rejected"),
    [10, 20, 30, "rejected", 50, 60, 70],
  );
  assertEquals(await settleBounded([], 3, () => Promise.resolve()), []);
});

Deno.test("a capacity refusal during a restore holds the session and reports no lost access", async () => {
  // A router or toolshed at a capacity limit refuses a reopen, or the watch
  // set after it, marked retriable. The session waits and tries again; only
  // a final denial ends it as access lost.
  for (const step of ["open", "watch set"] as const) {
    const peer = new RoutedPeer(
      (space, open) =>
        space !== SPACE_A || open !== 2
          ? "ok"
          : step === "open"
          ? "retriable"
          : "new",
      (space, n) =>
        step === "watch set" && space === SPACE_A && n === 1
          ? "retriable"
          : "ok",
    );
    const client = await connect({ transport: peer });
    try {
      const a = await client.mount(SPACE_A, {}, principal());
      await a.watchAdd([{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: "of:held-root",
            selector: { path: [], schema: false },
          }],
        },
      }]);
      const lost: Error[] = [];
      a.subscribeAccessLoss((error) => lost.push(error));
      peer.drop();
      await until(() => a.held);
      assert((await within(a.transact(commit(1)))).seq > 0, step);
      assertEquals(lost, [], step);
      assertEquals(a.held, false, step);
      // The refused step was sent again.
      assertEquals(
        step === "open" ? peer.opens.get(SPACE_A) : peer.watchSets.get(SPACE_A),
        step === "open" ? 3 : 2,
        step,
      );
    } finally {
      await client.close();
    }
  }
  // The same refusal unmarked is final: the session's access is lost.
  const peer = new RoutedPeer((space, open) =>
    space === SPACE_A && open === 2 ? "permanent" : "ok"
  );
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    const lost: Error[] = [];
    a.subscribeAccessLoss((error) => lost.push(error));
    peer.drop();
    await client.restoreConnection();
    await until(() => lost.length === 1);
  } finally {
    await client.close();
  }
});

Deno.test("a permanent reopen denial still ends only that session", async () => {
  const peer = new RoutedPeer((space, open) =>
    space === SPACE_A && open === 2 ? "permanent" : "ok"
  );
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    const b = await client.mount(SPACE_B, {}, principal());
    peer.drop();
    await client.restoreConnection();
    const error = await assertRejects(
      () => a.transact(commit(1)),
      Error,
      "Routed memory request denied",
    );
    assertEquals(error.name, "AuthorizationError");
    assert((await b.transact(commit(1))).seq > 0);
    assertEquals(peer.hellos, 2);
  } finally {
    await client.close();
  }
});

Deno.test("a signed open's retriable denial still reconnects the client", async () => {
  // A function signs each open itself, so a retriable denial is an
  // anti-replay race only a new connection's challenge heals.
  const peer = new RoutedPeer((space, open) =>
    space === SPACE_A && open === 2 ? "retriable" : "ok"
  );
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, () => undefined);
    peer.drop();
    assert((await within(a.transact(commit(1)))).seq > 0);
    assertEquals(a.held, false);
    assertEquals(peer.hellos, 3);
  } finally {
    await client.close();
  }
});

Deno.test("a held restore that keeps failing restarts the connection with backoff", async () => {
  // A's reopen alternates a retriable denial, which holds it, with an error
  // only a new connection heals, which restarts the connection.
  const peer = new RoutedPeer((space, open) =>
    space === SPACE_A && open > 1
      ? (open % 2 === 0 ? "retriable" : "session-error")
      : "ok"
  );
  const client = await connect({ transport: peer });
  try {
    await client.mount(SPACE_A, {}, principal());
    await client.mount(SPACE_B, {}, principal());
    peer.drop();
    await pause(1500);
    // Restarts back off: 25 ms doubling, so about six in 1.5 s, not one
    // per retry.
    assert(peer.hellos <= 10, `${peer.hellos} handshakes in 1.5 s`);
    assert(
      (peer.opens.get(SPACE_B) ?? 0) <= 10,
      `${peer.opens.get(SPACE_B)} reopens of B in 1.5 s`,
    );
  } finally {
    await client.close();
  }
});

Deno.test("a session that restores before a held one leaves the restart backoff alone", async () => {
  // B restores first on each connection, before A is held again; its
  // reopen ends no hold, so it must not reset the backoff A's restarts need.
  const peer = new RoutedPeer((space, open) =>
    space === SPACE_A && open > 1
      ? (open % 2 === 0 ? "retriable" : "session-error")
      : "ok"
  );
  const client = await connect({ transport: peer });
  try {
    await client.mount(SPACE_B, {}, principal());
    await client.mount(SPACE_A, {}, principal());
    peer.drop();
    await pause(1500);
    assert(peer.hellos <= 10, `${peer.hellos} handshakes in 1.5 s`);
  } finally {
    await client.close();
  }
});

Deno.test("restarts back off from the start again once no session is held", async () => {
  // Four rounds of hold-then-fail restart the connection with growing
  // backoff; A then restores on its own, and a later restart waits the base
  // delay again.
  const opened: number[] = [];
  const peer = new RoutedPeer((space, open) => {
    if (space !== SPACE_A || open === 1) return "ok";
    opened[open] = Date.now();
    if (open === 11) return "ok";
    return open % 2 === 0 ? "retriable" : "session-error";
  });
  const hellos = recordHellos(peer);
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    peer.drop();
    await until(() => (peer.opens.get(SPACE_A) ?? 0) === 11 && !a.held);
    await a.restore();
    assert(a.held);
    await until(() => (peer.opens.get(SPACE_A) ?? 0) >= 13);
    await until(() => hellos.some((at) => at >= opened[13]));
    const waited = hellos.find((at) => at >= opened[13])! - opened[13];
    assert(waited < 200, `restarted ${waited} ms after the failure`);
  } finally {
    await client.close();
  }
});

Deno.test("a peer that denies a reopen and then drops is reconnected to with backoff", async () => {
  const peer = new RoutedPeer(
    (space, open) => space === SPACE_A && open > 1 ? "retriable" : "ok",
    undefined,
    true,
    { dropOnDenial: true },
  );
  const client = await connect({ transport: peer });
  try {
    await client.mount(SPACE_A, {}, principal());
    peer.drop();
    await pause(1500);
    // A drop while a session is held counts as a restart and backs off.
    assert(peer.hellos <= 10, `${peer.hellos} handshakes in 1.5 s`);
  } finally {
    await client.close();
  }
});

Deno.test("a full reconnect with no session held resets the restart backoff", async () => {
  // Four rounds of hold-then-fail restart the connection; the fifth
  // reconnect restores A outright, and a later restart waits the base delay.
  const opened: number[] = [];
  const peer = new RoutedPeer((space, open) => {
    if (space !== SPACE_A || open === 1 || open === 10 || open > 12) {
      return "ok";
    }
    opened[open] = Date.now();
    if (open === 11) return "retriable";
    if (open === 12) return "session-error";
    return open % 2 === 0 ? "retriable" : "session-error";
  });
  const hellos = recordHellos(peer);
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    peer.drop();
    await until(() => (peer.opens.get(SPACE_A) ?? 0) === 10 && !a.held);
    await a.restore();
    assert(a.held);
    await until(() => hellos.some((at) => at >= (opened[12] ?? Infinity)));
    const waited = hellos.find((at) => at >= opened[12])! - opened[12];
    assert(waited < 200, `restarted ${waited} ms after the failure`);
  } finally {
    await client.close();
  }
});

Deno.test("closing the last held session resets the restart backoff", async () => {
  const peer = new RoutedPeer((space, open) =>
    space === SPACE_A && open > 1
      ? (open % 2 === 0 ? "retriable" : "session-error")
      : "ok"
  );
  const hellos = recordHellos(peer);
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    await client.mount(SPACE_B, {}, principal());
    peer.drop();
    // Four restarts, then A held again on the fifth connection.
    await until(() => hellos.length >= 6 && a.held);
    await a.close();
    const restarted = Date.now();
    client.restartConnection(new Error("restart"));
    await until(() => hellos.some((at) => at >= restarted));
    const waited = hellos.find((at) => at >= restarted)! - restarted;
    assert(waited < 200, `restarted ${waited} ms after the close`);
  } finally {
    await client.close();
  }
});

Deno.test("closing one held session keeps the restart backoff while another is held", async () => {
  // A's held retries keep failing, which restarts the connection with
  // growing backoff, and B stays held throughout. Closing A must not reset
  // the backoff B's restarts still need.
  const peer = new RoutedPeer((space, open) =>
    open === 1
      ? "ok"
      : space === SPACE_B || open % 2 === 0
      ? "retriable"
      : "session-error"
  );
  const hellos = recordHellos(peer);
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    const b = await client.mount(SPACE_B, {}, principal());
    peer.drop();
    // Four restarts, then both held again on the fifth connection.
    await until(() => hellos.length >= 6 && a.held && b.held);
    await a.close();
    const restarted = Date.now();
    client.restartConnection(new Error("restart"));
    await until(() => hellos.some((at) => at >= restarted));
    const waited = hellos.find((at) => at >= restarted)! - restarted;
    assert(waited >= 100, `restarted ${waited} ms after the close`);
  } finally {
    await client.close();
  }
});

Deno.test("a drop once no session is held reconnects without the last restart's backoff", async () => {
  const peer = new RoutedPeer((space, open) =>
    space === SPACE_A && open > 1
      ? (open % 2 === 0 ? "retriable" : "session-error")
      : "ok"
  );
  const hellos = recordHellos(peer);
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    await client.mount(SPACE_B, {}, principal());
    peer.drop();
    // Four restarts, then A held again on the fifth connection.
    await until(() => hellos.length >= 6 && a.held);
    await a.close();
    const dropped = Date.now();
    peer.drop();
    await until(() => hellos.some((at) => at >= dropped));
    const waited = hellos.find((at) => at >= dropped)! - dropped;
    assert(waited < 100, `reconnected ${waited} ms after the drop`);
  } finally {
    await client.close();
  }
});

Deno.test("closing the client during a restart's backoff sends no handshake", async () => {
  const peer = new RoutedPeer(() => "ok");
  const client = await connect({ transport: peer });
  await client.mount(SPACE_A, {}, principal());
  client.restartConnection(new Error("restart"));
  await client.close();
  await pause(100);
  assertEquals(peer.hellos, 1);
});

Deno.test("a restart that lands as the reconnect loop ends still reconnects", async () => {
  // Each round lands a restart a few more microtasks after the session
  // restored: while the loop still restores, as it ends, or after it.
  const peer = new RoutedPeer(() => "ok");
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    for (let hops = 0; hops < 20; hops++) {
      peer.drop();
      await a.whenRestored();
      for (let hop = 0; hop < hops; hop++) await null;
      const hellos = peer.hellos;
      client.restartConnection(new Error("restart"));
      // The client reconnects on its own, with no request to prompt it.
      await until(() => peer.hellos > hellos, 1000);
      assert((await within(a.transact(commit(hops + 1)))).seq > 0);
    }
  } finally {
    await client.close();
  }
});

Deno.test("a held session's backoff starts over on a new connection", async () => {
  // Four holds back off to 400 ms; a drop then hands A to a new connection,
  // where its next hold waits the base delay again.
  const opened: number[] = [];
  const peer = new RoutedPeer((space, open) => {
    if (space !== SPACE_A) return "ok";
    opened[open] = Date.now();
    return open >= 2 && open <= 6 ? "retriable" : "ok";
  });
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    peer.drop();
    await until(() => (peer.opens.get(SPACE_A) ?? 0) === 5 && a.held);
    peer.drop();
    await until(() => (peer.opens.get(SPACE_A) ?? 0) === 7);
    const waited = opened[7] - opened[6];
    assert(waited < 200, `waited ${waited} ms on the new connection`);
  } finally {
    await client.close();
  }
});

Deno.test("a principal's retriable denial against a direct peer still reconnects", async () => {
  // Without `connectionAuth` even a principal signs each open, so the
  // denial is an anti-replay race only a new connection heals.
  const peer = new RoutedPeer(
    (space, open) => space === SPACE_A && open === 2 ? "retriable" : "ok",
    undefined,
    true,
    { direct: true },
  );
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, signingPrincipal());
    peer.drop();
    assert((await within(a.transact(commit(1)))).seq > 0);
    assertEquals(a.held, false);
    assertEquals(peer.hellos, 3);
  } finally {
    await client.close();
  }
});

Deno.test("a held restore failing where the transport cannot restart fails the session", async () => {
  // Without `reset` the client cannot discard the connection, so a held
  // restore that needs a new one fails the client rather than waiting.
  const peer = new RoutedPeer(
    (space, open) =>
      space === SPACE_A && open === 2
        ? "retriable"
        : space === SPACE_A && open > 2
        ? "session-error"
        : "ok",
    undefined,
    false,
  );
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    peer.drop();
    await until(() => a.held);
    await assertRejects(
      () => within(a.transact(commit(1))),
      Error,
      "Session restore failed",
    );
  } finally {
    await client.close();
  }
});

Deno.test("a restart while the reconnect loop restores still reconnects", async () => {
  // B's reopen waits while the loop restores, and the restart lands then.
  const peer = new RoutedPeer((space, open) =>
    space === SPACE_B && open === 2 ? "hold" : "ok"
  );
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    const b = await client.mount(SPACE_B, {}, principal());
    peer.drop();
    await until(() => peer.held.length === 1);
    client.restartConnection(new Error("restart"));
    peer.held.shift()!();
    // The client reconnects on its own, with no request to prompt it.
    await until(() => peer.hellos === 3);
    assert((await within(a.transact(commit(1)))).seq > 0);
    assert((await within(b.transact(commit(1)))).seq > 0);
    assertEquals(peer.hellos, 3);
  } finally {
    await client.close();
  }
});

Deno.test("a drop while a session is held hands it to the reconnect", async () => {
  const peer = new RoutedPeer((space, open) =>
    space === SPACE_A && open === 2 ? "retriable" : "ok"
  );
  const client = await connect({ transport: peer });
  const timers = trackTimers();
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    peer.drop();
    await until(() => a.held);
    // The drop clears the held retry at once; the reconnect restores A.
    const gate = Promise.withResolvers<void>();
    peer.helloGate = gate.promise;
    assertEquals(timers.short(), 1);
    peer.drop();
    // The held retry is gone; the one short timer is the reconnect's
    // backoff, since a drop while a session is held counts as a restart.
    assertEquals(timers.short(), 1);
    assertEquals(a.held, false);
    peer.helloGate = undefined;
    gate.resolve();
    assert((await within(a.transact(commit(1)))).seq > 0);
    assertEquals(peer.opens.get(SPACE_A), 3);
  } finally {
    timers.restore();
    await client.close();
  }
});

Deno.test("a restore started while a session is held replaces its retry", async () => {
  // The restore's reopen waits, as on a slow peer, past the held retry's
  // backoff; the retry must not reopen A alongside it, or after it.
  const peer = new RoutedPeer((space, open) =>
    space !== SPACE_A
      ? "ok"
      : open === 2
      ? "retriable"
      : open === 3
      ? "hold"
      : "ok"
  );
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    peer.drop();
    await until(() => a.held);
    const restored = a.restore();
    // Closing the client after a failed assertion rejects it; let that
    // assertion be what the test reports.
    restored.catch(() => {});
    await until(() => peer.held.length === 1);
    await pause(150);
    assertEquals(peer.opens.get(SPACE_A), 3);
    peer.held.shift()!();
    await restored;
    assertEquals(a.held, false);
    await pause(150);
    assertEquals(peer.opens.get(SPACE_A), 3);
  } finally {
    await client.close();
  }
});

Deno.test("a held session's backoff starts over once it restores", async () => {
  // Four holds back off to 200 ms; after a success, the next hold waits
  // the base delay again.
  let denyFrom = 2, denyTo = 5;
  const opened: number[] = [];
  const peer = new RoutedPeer((space, open) => {
    if (space !== SPACE_A) return "ok";
    opened[open] = Date.now();
    return open >= denyFrom && open <= denyTo ? "retriable" : "ok";
  });
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    peer.drop();
    await until(() => (peer.opens.get(SPACE_A) ?? 0) === 6 && !a.held);
    // The fourth hold waited at least 200 ms.
    assert(opened[6] - opened[5] >= 200, `waited ${opened[6] - opened[5]} ms`);
    denyFrom = 7;
    denyTo = 7;
    await a.restore();
    assert(a.held);
    await until(() => (peer.opens.get(SPACE_A) ?? 0) === 8);
    const waited = opened[8] - opened[7];
    assert(waited < 200, `waited ${waited} ms after a fresh hold`);
  } finally {
    await client.close();
  }
});

Deno.test("terminating a held session clears its retry", async () => {
  const peer = new RoutedPeer((space, open) =>
    space === SPACE_A && open > 1 ? "retriable" : "ok"
  );
  const client = await connect({ transport: peer });
  const timers = trackTimers();
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    peer.drop();
    await until(() => a.held);
    assertEquals(timers.short(), 1);
    peer.push({
      type: "session/revoked",
      space: SPACE_A,
      sessionId: a.sessionId,
      reason: "unauthorized",
    });
    assertEquals(timers.short(), 0);
    assertEquals(a.held, false);
  } finally {
    timers.restore();
    await client.close();
  }
});

Deno.test("a denial while re-establishing the watch set holds the session and sends it again", async () => {
  // The reopen starts a new server session, whose watch set is denied
  // retriably; the retry resumes that session and must still send it.
  const peer = new RoutedPeer(
    (space, open) => space === SPACE_A && open === 2 ? "new" : "ok",
    (space, n) => space === SPACE_A && n === 1 ? "retriable" : "ok",
  );
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    await a.watchAdd([{
      id: "root",
      kind: "graph",
      query: {
        roots: [{ id: "of:held-root", selector: { path: [], schema: false } }],
      },
    }]);
    peer.drop();
    await until(() => a.held);
    // Held, the session sends no commit until it is restored.
    const pendingA = a.transact(commit(1));
    await pause(5);
    assertEquals(peer.transacts.get(SPACE_A), undefined);
    assert((await within(pendingA)).seq > 0);
    assertEquals(peer.watchSets.get(SPACE_A), 2);
    assertEquals(peer.transacts.get(SPACE_A), 1);
    // Sent, the watch set is owed no more: a resumed reopen sends none.
    peer.drop();
    await within(client.restoreConnection());
    assertEquals(peer.watchSets.get(SPACE_A), 2);
  } finally {
    await client.close();
  }
});

Deno.test("an overlapping restore leaves the restoring state to the latest", async () => {
  // Two restores overlap: the first finishing must not end the second's
  // restoring state, or a commit is sent before the second has restored.
  const peer = new RoutedPeer((space, open) =>
    space === SPACE_A && open > 1 ? "hold" : "ok"
  );
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    const first = a.restore();
    await until(() => peer.held.length === 1);
    const second = a.restore();
    await until(() => peer.held.length === 2);
    peer.held.shift()!();
    await first;
    const pendingA = a.transact(commit(1));
    // Closing the client after a failed assertion rejects these; let that
    // assertion be what the test reports.
    second.catch(() => {});
    pendingA.catch(() => {});
    await pause(5);
    assertEquals(peer.transacts.get(SPACE_A), undefined);
    peer.held.shift()!();
    await second;
    assert((await within(pendingA)).seq > 0);
    assertEquals(peer.transacts.get(SPACE_A), 1);
  } finally {
    await client.close();
  }
});

Deno.test("closing the client while a session is held leaves no retry running", async () => {
  const timers = trackTimers();
  try {
    const peer = new RoutedPeer((space, open) =>
      space === SPACE_A && open > 1 ? "retriable" : "ok"
    );
    const client = await connect({ transport: peer });
    const a = await client.mount(SPACE_A, {}, principal());
    peer.drop();
    await until(() => (peer.opens.get(SPACE_A) ?? 0) >= 3);
    const pendingA = a.transact(commit(1));
    await client.close();
    await assertRejects(() => pendingA, Error, "memory session closed");
    assertEquals(timers.live(), 0);
  } finally {
    timers.restore();
  }
});

Deno.test("cancelling a held session's route ends its retries", async () => {
  const peer = new RoutedPeer((space, open) =>
    space === SPACE_A && open > 1 ? "retriable" : "ok"
  );
  const client = await connect({ transport: peer });
  const route = new AbortController();
  const timers = trackTimers();
  try {
    const a = await client.mount(SPACE_A, {}, principal(), route.signal);
    peer.drop();
    await until(() => (peer.opens.get(SPACE_A) ?? 0) >= 2);
    // The cancellation clears the held retry at once.
    await until(() => timers.short() === 1);
    route.abort();
    assertEquals(timers.short(), 0);
    assertEquals(a.held, false);
    const opens = peer.opens.get(SPACE_A);
    await pause(200);
    assertEquals(peer.opens.get(SPACE_A), opens);
    assertEquals(peer.hellos, 2);
  } finally {
    timers.restore();
    await client.close();
  }
});

Deno.test("a route cancelled before a watch-set denial leaves the session unheld", async () => {
  // The reopen starts a new server session; the route is cancelled while
  // its watch set waits, and the watch set is then denied retriably.
  const peer = new RoutedPeer(
    (space, open) => space === SPACE_A && open === 2 ? "new" : "ok",
    (space, n) => space === SPACE_A && n === 1 ? "hold" : "ok",
  );
  const client = await connect({ transport: peer });
  const route = new AbortController();
  const timers = trackTimers();
  try {
    const a = await client.mount(SPACE_A, {}, principal(), route.signal);
    await a.watchAdd([{
      id: "root",
      kind: "graph",
      query: {
        roots: [{ id: "of:held-root", selector: { path: [], schema: false } }],
      },
    }]);
    peer.drop();
    await until(() => peer.held.length === 1);
    route.abort();
    peer.held.shift()!("retriable");
    // Not `within`, whose own timer would still be pending below.
    await client.restoreConnection();
    assertEquals(a.held, false);
    assertEquals(timers.short(), 0);
  } finally {
    timers.restore();
    await client.close();
  }
});

/** A's first reopen is denied retriably; its held retry's reopen waits. */
const slowRetry = (space: string, open: number): Reply =>
  space !== SPACE_A
    ? "ok"
    : open === 2
    ? "retriable"
    : open === 3
    ? "hold"
    : "ok";

Deno.test("cancelling a route while its held retry reopens ends the hold, not the connection", async () => {
  const peer = new RoutedPeer(slowRetry);
  const client = await connect({ transport: peer });
  const route = new AbortController();
  try {
    const a = await client.mount(SPACE_A, {}, principal(), route.signal);
    peer.drop();
    await until(() => peer.held.length === 1);
    route.abort();
    await until(() => !a.held);
    await pause(100);
    assertEquals(peer.hellos, 2);
  } finally {
    await client.close();
  }
});

Deno.test("closing a session while its held retry reopens leaves the connection", async () => {
  const peer = new RoutedPeer(slowRetry);
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    const b = await client.mount(SPACE_B, {}, principal());
    peer.drop();
    await until(() => peer.held.length === 1);
    await a.close();
    // A failure only a new connection heals, but A no longer needs one.
    peer.held.shift()!("session-error");
    await pause(100);
    assertEquals(peer.hellos, 2);
    assert((await within(b.transact(commit(1)))).seq > 0);
  } finally {
    await client.close();
  }
});

Deno.test("a drop while a held retry reopens leaves the session to the reconnect", async () => {
  const peer = new RoutedPeer(slowRetry);
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    peer.drop();
    await until(() => peer.held.length === 1);
    peer.drop();
    assert((await within(a.transact(commit(1)))).seq > 0);
    // The retry's failure is the drop's, so it neither discards the
    // connection the reconnect opened nor restarts it.
    await pause(100);
    assertEquals(peer.hellos, 3);
    assertEquals(peer.resets, 0);
  } finally {
    await client.close();
  }
});

Deno.test("a hold that ends leaves no listener on the session's route", async () => {
  const peer = new RoutedPeer((space, open) =>
    space === SPACE_A && open === 2 ? "retriable" : "ok"
  );
  const client = await connect({ transport: peer });
  const route = new AbortController();
  const signal = route.signal;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === "abort") listeners.add(listener);
    add(type, listener, options);
  };
  signal.removeEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    if (type === "abort") listeners.delete(listener);
    remove(type, listener, options);
  };
  try {
    const a = await client.mount(SPACE_A, {}, principal(), signal);
    const mounted = listeners.size;
    peer.drop();
    await until(() => a.held);
    assertEquals(listeners.size, mounted + 1);
    await until(() => !a.held);
    assertEquals(listeners.size, mounted);
  } finally {
    await client.close();
  }
});

Deno.test("a held retry whose signer outlives its connection leaves the next connection alone", async () => {
  const peer = new RoutedPeer(() => "ok");
  // connection.auth: the mount's passes, the reconnect's two are refused as
  // retriable so A is held, and later ones pass. A held retry sends a
  // refused statement again while its challenge lasts; these challenges
  // last two seconds, so a later retry signs a new one.
  let auths = 0;
  const send = peer.send.bind(peer);
  peer.send = (payload: string) => {
    const body = JSON.parse(payload.slice(5));
    if (body.type === "connection.auth" && (++auths === 2 || auths === 3)) {
      peer.push({
        type: "response",
        requestId: body.requestId,
        error: {
          name: "AuthorizationError",
          message: "toolshed down",
          retriable: true,
        },
      });
      return Promise.resolve();
    }
    return send(payload);
  };
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => release = r);
  let gated = false;
  const base = principal();
  const slowSigner: SessionPrincipal = {
    ...base,
    authorizeConnection: async (context) => {
      // The first signature after a refusal, the held retry's, waits until
      // the test releases it.
      if (auths >= 2 && !gated) {
        gated = true;
        await gate;
      }
      return await base.authorizeConnection(context);
    },
  };
  const client = await connect({ transport: peer });
  challengeLife = 2;
  try {
    const a = await client.mount(SPACE_A, {}, slowSigner);
    peer.drop();
    await until(() => a.held);
    await until(() => gated);
    // The connection drops under the retry's signer, and the reconnect
    // restores A on a new one.
    peer.drop();
    await within(client.restoreConnection());
    await until(() => client.isConnected() && !a.held);
    const resets = peer.resets;
    release();
    await pause(300);
    assertEquals(peer.resets, resets);
    assert(client.isConnected());
  } finally {
    challengeLife = 60;
    await client.close();
  }
});

Deno.test("a reconnect signs anew rather than sending a statement refused on the connection before", async () => {
  const peer = new RoutedPeer(() => "ok");
  // The reconnect's connection.auth is refused for now, so A is held with
  // that statement kept; a second reconnect must not send it again.
  let auths = 0;
  const send = peer.send.bind(peer);
  peer.send = (payload: string) => {
    const body = JSON.parse(payload.slice(5));
    if (body.type === "connection.auth" && ++auths === 2) {
      peer.push({
        type: "response",
        requestId: body.requestId,
        error: {
          name: "AuthorizationError",
          message: "Routed memory request denied",
          retriable: true,
        },
      });
      return Promise.resolve();
    }
    return send(payload);
  };
  let signs = 0;
  const base = principal();
  const counting: SessionPrincipal = {
    ...base,
    authorizeConnection: (context) => {
      signs++;
      return base.authorizeConnection(context);
    },
  };
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, counting);
    peer.drop();
    await until(() => a.held);
    peer.drop();
    await within(client.restoreConnection());
    await until(() => client.isConnected() && !a.held);
    assertEquals(signs, 3);
  } finally {
    await client.close();
  }
});

Deno.test("a held retry after a router refuses a challenge for now waits a second", async () => {
  const peer = new RoutedPeer(() => "ok");
  // Challenges last two seconds, too short to send a refused statement
  // again, so each retry asks for a challenge; the first two are refused.
  challengeLife = 2;
  const asked: number[] = [];
  let auths = 0;
  const send = peer.send.bind(peer);
  peer.send = (payload: string) => {
    const body = JSON.parse(payload.slice(5));
    const refuse = (body.type === "connection.auth" && ++auths === 2) ||
      (body.type === "connection.challenge" && asked.push(Date.now()) <= 2);
    if (refuse) {
      peer.push({
        type: "response",
        requestId: body.requestId,
        error: {
          name: "AuthorizationError",
          message: "Routed memory request denied",
          retriable: true,
        },
      });
      return Promise.resolve();
    }
    return send(payload);
  };
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    peer.drop();
    await until(() => asked.length >= 2, 10_000);
    assert(asked[1] - asked[0] >= 1000, `${asked[1] - asked[0]} ms`);
    await until(() => !a.held, 10_000);
  } finally {
    challengeLife = 60;
    await client.close();
  }
});

Deno.test("a watch set refused on a held retry keeps the reconnect backoff growing", async () => {
  const peer = new RoutedPeer(
    (space, open) => space === SPACE_A && open > 1 ? "new" : "ok",
    (space) => space === SPACE_A ? "retriable" : "ok",
  );
  const hellos = recordHellos(peer);
  const client = await connect({ transport: peer });
  try {
    const a = await client.mount(SPACE_A, {}, principal());
    await a.watchAdd([{
      id: "root",
      kind: "graph",
      query: {
        roots: [{ id: "of:held-root", selector: { path: [], schema: false } }],
      },
    }]);
    const gaps: number[] = [];
    let before = peer.watchSets.get(SPACE_A) ?? 0;
    peer.drop();
    for (let round = 0; round < 7; round++) {
      // The loop's watch set and the held retry's are both refused.
      await until(
        () => (peer.watchSets.get(SPACE_A) ?? 0) >= before + 2 && a.held,
        20000,
      );
      before = peer.watchSets.get(SPACE_A) ?? 0;
      const at = Date.now();
      const seen = hellos.length;
      peer.drop();
      await until(() => hellos.length > seen, 40000);
      gaps.push(hellos[seen] - at);
    }
    assert(gaps[gaps.length - 1] > 200, `gaps never grew: ${gaps.join(", ")}`);
  } finally {
    await client.close();
  }
});

Deno.test("a client a held retry fails does not handshake again", async () => {
  const peer = new RoutedPeer(
    (space, open) =>
      space === SPACE_A && open > 1
        ? (open === 2 ? "retriable" : "session-error")
        : "ok",
    undefined,
    false,
  );
  // B's commit is never answered, so B's restore is still replaying when
  // A's retry fails the client.
  const send = peer.send.bind(peer);
  peer.send = (payload: string) => {
    const body = JSON.parse(payload.slice(5));
    if (body.type === "transact" && body.space === SPACE_B) {
      return Promise.resolve();
    }
    return send(payload);
  };
  const client = await connect({ transport: peer });
  try {
    await client.mount(SPACE_A, {}, principal());
    const b = await client.mount(SPACE_B, {}, principal());
    const pending = b.transact(commit(1)).catch((error) => error);
    await pause(5);
    peer.drop();
    await until(() => client.connectionState === "failed", 3000);
    const hellos = peer.hellos;
    await pause(200);
    assertEquals(peer.hellos, hellos);
    assert(!client.isConnected());
    void pending;
  } finally {
    await client.close();
  }
});
