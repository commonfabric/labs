import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";

import {
  type FabricValue,
  isFabricPlainObject,
} from "@commonfabric/data-model";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
} from "../v2.ts";
import {
  connect,
  type SessionPrincipal,
  type Transport,
} from "../v2/client.ts";

const did = "did:key:z6Mk-auth-recovery";
const signer: SessionPrincipal = {
  did,
  authorizeConnection: () => ({ invocation: {}, authorization: {} }),
  authorizeSessionOpen: () => {
    throw new Error("Uses connection authentication");
  },
};

/** Creates a direct protocol peer whose renewal responses the test controls. */
function directPeer() {
  let receive = (_: string) => {};
  let onClose = (_?: Error) => {};
  let refuseRetries = false;
  let hellos = 0;
  let challenges = 0;
  let opens = 0;
  const auths: string[] = [];
  const push = (body: FabricValue) => receive(encodeMemoryBoundary(body));
  const challenge = () => ({
    value: `challenge:${challenges}`,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  });
  const accept = (index: number) =>
    push({
      type: "response",
      requestId: auths[index],
      ok: {
        principal: did,
        expiresAt: Math.floor(Date.now() / 1000) + (index === 0 ? 4 : 3600),
      },
    });
  const refuse = (index: number, retriable = true) =>
    push({
      type: "response",
      requestId: auths[index],
      error: {
        name: "AuthorizationError",
        message: retriable ? "challenge expired" : "signature refused",
        retriable,
      },
    });
  const transport: Transport = {
    setReceiver: (receiver) => {
      receive = receiver;
    },
    setCloseReceiver: (receiver) => {
      onClose = receiver;
    },
    send: (payload) => {
      const body = decodeMemoryBoundary(payload);
      if (!isFabricPlainObject(body) || typeof body.type !== "string") {
        throw new Error("Expected a request");
      }
      if (body.type === "hello") {
        hellos++;
        push({
          type: "hello.ok",
          protocol: "memory",
          flags: { ...getMemoryProtocolFlags(), connectionAuth: true },
          sessionOpen: { audience: did, challenge: challenge() },
        });
      } else {
        if (typeof body.requestId !== "string") {
          throw new Error("Expected a request ID");
        }
        const response = { type: "response", requestId: body.requestId };
        switch (body.type) {
          case "connection.challenge":
            challenges++;
            push({ ...response, ok: { challenge: challenge() } });
            break;
          case "connection.auth":
            auths.push(body.requestId);
            if (auths.length === 1) accept(0);
            else if (refuseRetries) refuse(auths.length - 1);
            break;
          case "session.open":
            opens++;
            push({
              ...response,
              ok: {
                sessionId: `session:${opens}`,
                sessionToken: `token:${opens}`,
                serverSeq: 0,
              },
            });
            break;
          case "session.close":
          case "connection.release":
            push({ ...response, ok: {} });
            break;
          default:
            throw new Error(`Unexpected request: ${body.type}`);
        }
      }
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
  return {
    transport,
    accept,
    refuse,
    auths,
    drop: () => onClose(new Error("Connection lost")),
    refuseRetries: () => {
      refuseRetries = true;
    },
    counts: () => ({ hellos, challenges, opens }),
  };
}

/** Observes settlement immediately, including failures during clock advances. */
function observe<T>(promise: Promise<T>) {
  let state = "pending";
  const result = promise.then((value) => {
    state = "resolved";
    return value;
  }, (error: unknown) => {
    state = "rejected";
    return error;
  });
  return { result, state: () => state };
}

/** Advances production timers and drains the microtasks their callbacks start. */
async function advance(time: FakeTime, ms: number): Promise<void> {
  await time.tickAsync(ms);
  await time.runMicrotasks();
}

describe("Client authentication recovery", () => {
  it("keeps concurrent mounts pending across repeated renewal refusals and shares each authentication", async () => {
    using time = new FakeTime(Date.UTC(2026, 9, 10));
    using _random = stub(Math, "random", () => 0);
    const peer = directPeer();
    const client = await connect({ transport: peer.transport });
    try {
      const existing = await client.mount(did, {}, signer);
      await advance(time, 2000);
      expect(peer.auths).toHaveLength(2);
      const mounts = [
        observe(client.mount("space:A", {}, signer)),
        observe(client.mount("space:B", {}, signer)),
      ];
      // The synthetic signer and transport settle in microtasks. Holding
      // the reply while draining those tasks puts both mounts on the
      // renewal's unanswered authentication without advancing its backoff.
      await time.tickAsync(0);
      peer.refuse(1);
      await time.tickAsync(0);
      expect(mounts.map((mount) => mount.state())).toEqual([
        "pending",
        "pending",
      ]);
      await advance(time, 24);
      expect(peer.auths).toHaveLength(2);
      await advance(time, 1);
      expect(peer.auths).toHaveLength(3);
      peer.refuse(2);
      await time.tickAsync(0);
      expect(mounts.map((mount) => mount.state())).toEqual([
        "pending",
        "pending",
      ]);
      await advance(time, 50);
      expect(peer.auths).toHaveLength(4);
      peer.accept(3);
      await Promise.all(mounts.map((mount) => mount.result));
      expect(mounts.map((mount) => mount.state())).toEqual([
        "resolved",
        "resolved",
      ]);
      expect(peer.counts()).toEqual({ hellos: 1, challenges: 3, opens: 3 });
      expect(existing.closeError).toBeUndefined();
      expect(client.connectionState).toBe("connected");
    } finally {
      await client.close();
    }
  });

  it("cancels one held mount without ending another mount or the renewal", async () => {
    using time = new FakeTime(Date.UTC(2026, 9, 10));
    using _random = stub(Math, "random", () => 0);
    const peer = directPeer();
    const client = await connect({ transport: peer.transport });
    try {
      await client.mount(did, {}, signer);
      await advance(time, 2000);
      const abort = new AbortController();
      const cancelled = observe(
        client.mount("space:A", {}, signer, abort.signal),
      );
      const surviving = observe(client.mount("space:B", {}, signer));
      await time.tickAsync(0);
      peer.refuse(1);
      await time.tickAsync(0);
      expect(cancelled.state()).toBe("pending");
      const reason = new Error("Mount canceled by caller");
      abort.abort(reason);
      expect(await cancelled.result).toBe(reason);
      await advance(time, 25);
      expect(peer.auths).toHaveLength(3);
      peer.accept(2);
      await surviving.result;
      expect(surviving.state()).toBe("resolved");
      expect(peer.counts().opens).toBe(2);
    } finally {
      await client.close();
    }
  });

  it("fails a held mount on a permanent renewal refusal", async () => {
    using time = new FakeTime(Date.UTC(2026, 9, 10));
    using _random = stub(Math, "random", () => 0);
    const peer = directPeer();
    const client = await connect({ transport: peer.transport });
    try {
      const existing = await client.mount(did, {}, signer);
      await advance(time, 2000);
      const mount = observe(client.mount("space:A", {}, signer));
      await time.tickAsync(0);
      peer.refuse(1);
      await time.tickAsync(0);
      expect(mount.state()).toBe("pending");
      await advance(time, 25);
      peer.refuse(2, false);
      expect(await mount.result).toMatchObject({
        name: "AuthorizationError",
        message: "signature refused",
        retriable: false,
      });
      expect(mount.state()).toBe("rejected");
      expect(existing.closeError?.message).toBe("signature refused");
      expect(peer.counts().opens).toBe(1);
      expect(time.next()).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("unwinds a canceled open while the shared renewal remains unanswered", async () => {
    using time = new FakeTime(Date.UTC(2026, 9, 10));
    const peer = directPeer();
    const client = await connect({ transport: peer.transport });
    try {
      await client.mount(did, {}, signer);
      await advance(time, 2000);
      const abort = new AbortController();
      // Observe the internal open as well as the public mount wrapper:
      // cancellation must detach it from the long-lived renewal itself.
      const opening = observe(
        client.openSession("space:A", {}, signer, undefined, {
          signal: abort.signal,
        }),
      );
      await time.runMicrotasks();
      const reason = new Error("Open canceled by caller");
      abort.abort(reason);
      expect(await opening.result).toBe(reason);
      expect(opening.state()).toBe("rejected");
      expect(peer.auths).toHaveLength(2);
      const surviving = observe(client.mount("space:B", {}, signer));
      await time.runMicrotasks();
      peer.accept(1);
      await surviving.result;
      expect(surviving.state()).toBe("resolved");
      expect(peer.counts().opens).toBe(2);
    } finally {
      await client.close();
    }
  });

  it("rejects an open canceled while resolving its principal", async () => {
    using time = new FakeTime(Date.UTC(2026, 9, 10));
    const peer = directPeer();
    const client = await connect({ transport: peer.transport });
    try {
      await client.mount(did, {}, signer);
      await advance(time, 2000);
      const abort = new AbortController();
      const reason = new Error("Principal lookup canceled the open");
      const cancelingSigner: SessionPrincipal = {
        ...signer,
        get did() {
          abort.abort(reason);
          return did;
        },
      };
      // Principal access can run caller code after the open's initial
      // cancellation check, but before it subscribes to the renewal.
      await expect(
        client.openSession("space:A", {}, cancelingSigner, undefined, {
          signal: abort.signal,
        }),
      ).rejects.toBe(reason);
      expect(peer.auths).toHaveLength(2);
      expect(peer.counts().opens).toBe(1);
      const surviving = observe(client.mount("space:B", {}, signer));
      await time.runMicrotasks();
      peer.accept(1);
      await surviving.result;
      expect(surviving.state()).toBe("resolved");
      expect(peer.counts().opens).toBe(2);
    } finally {
      await client.close();
    }
  });

  it("ends a held mount and its backoff when the client closes", async () => {
    using time = new FakeTime(Date.UTC(2026, 9, 10));
    const peer = directPeer();
    const client = await connect({ transport: peer.transport });
    try {
      await client.mount(did, {}, signer);
      await advance(time, 2000);
      const mount = observe(client.mount("space:A", {}, signer));
      await time.tickAsync(0);
      peer.refuse(1);
      await time.tickAsync(0);
      expect(mount.state()).toBe("pending");
      await client.close();
      expect(await mount.result).toBeInstanceOf(Error);
      expect(mount.state()).toBe("rejected");
      expect(peer.auths).toHaveLength(2);
      expect(peer.counts().opens).toBe(1);
      expect(time.next()).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("shares one retry schedule across staggered mounts and fast refusals", async () => {
    // The same renewal runs alone, then with a hundred mounts arriving
    // during its backoffs. Varied jitter distinguishes shared recovery
    // from independent mount timers that happen to fire together.
    const counts: number[] = [];
    for (const mountsPerStep of [0, 10]) {
      using time = new FakeTime(Date.UTC(2026, 9, 10));
      let draws = 0;
      using _random = stub(Math, "random", () => (draws++ % 10) / 10);
      const peer = directPeer();
      const client = await connect({ transport: peer.transport });
      try {
        const existing = await client.mount(did, {}, signer);
        peer.refuseRetries();
        await advance(time, 2000);
        const mounts = [];
        for (let step = 0; step < 10; step++) {
          for (let i = 0; i < mountsPerStep; i++) {
            mounts.push(
              observe(client.mount(`space:${step}:${i}`, {}, signer)),
            );
          }
          await advance(time, 100);
        }
        expect(mounts.every((mount) => mount.state() === "pending")).toBe(true);
        expect(peer.counts().opens).toBe(1);
        expect(existing.closeError).toBeUndefined();
        counts.push(peer.auths.length);
      } finally {
        await client.close();
      }
      expect(time.next()).toBe(false);
    }
    expect(counts[0]).toBeGreaterThan(2);
    expect(counts[1]).toBe(counts[0]);
  });

  it("fails mounts arriving during backoff on the renewal's permanent refusal", async () => {
    using time = new FakeTime(Date.UTC(2026, 9, 10));
    let draws = 0;
    using _random = stub(Math, "random", () => (draws++ % 2) * 0.8);
    const peer = directPeer();
    const client = await connect({ transport: peer.transport });
    try {
      await client.mount(did, {}, signer);
      await advance(time, 2000);
      const first = observe(client.mount("space:A", {}, signer));
      await time.runMicrotasks();
      peer.refuse(1);
      await time.runMicrotasks();
      const late = observe(client.mount("space:B", {}, signer));
      await advance(time, 25);
      expect(peer.auths).toHaveLength(3);
      peer.refuse(2, false);
      await time.runMicrotasks();
      expect(first.state()).toBe("rejected");
      expect(late.state()).toBe("rejected");
      expect(await first.result).toBe(await late.result);
      expect(await late.result).toMatchObject({ message: "signature refused" });
      expect(time.next()).toBe(false);
      expect(peer.auths).toHaveLength(3);
      expect(peer.counts().opens).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("opens waiting mounts when renewal succeeds after the old lease expires", async () => {
    using time = new FakeTime(Date.UTC(2026, 9, 10));
    using _random = stub(Math, "random", () => 0);
    const peer = directPeer();
    const client = await connect({ transport: peer.transport });
    try {
      const existing = await client.mount(did, {}, signer);
      await advance(time, 2000);
      const mount = observe(client.mount("space:A", {}, signer));
      await time.runMicrotasks();
      peer.refuse(1);
      await advance(time, 25);
      await advance(time, 3000);
      expect(mount.state()).toBe("pending");
      expect(peer.counts().opens).toBe(1);
      peer.accept(2);
      await mount.result;
      expect(mount.state()).toBe("resolved");
      expect(existing.closeError).toBeUndefined();
      expect(peer.counts().opens).toBe(2);
    } finally {
      await client.close();
    }
  });

  it("settles renewal waiters when a restore authenticates during backoff", async () => {
    using time = new FakeTime(Date.UTC(2026, 9, 10));
    const peer = directPeer();
    const client = await connect({ transport: peer.transport });
    try {
      const existing = await client.mount(did, {}, signer);
      await advance(time, 2000);
      const mount = observe(client.mount("space:A", {}, signer));
      await time.runMicrotasks();
      peer.refuse(1);
      await time.runMicrotasks();
      const restoring = existing.restore();
      await time.runMicrotasks();
      expect(peer.auths).toHaveLength(3);
      peer.accept(2);
      await restoring;
      await time.runMicrotasks();
      expect(mount.state()).toBe("resolved");
      await client.mount("space:B", {}, signer);
      expect(peer.counts().opens).toBe(4);
      await advance(time, 1000);
      expect(peer.auths).toHaveLength(3);
    } finally {
      await client.close();
    }
  });

  it("ends renewal waiters when a restore's authentication is permanently refused", async () => {
    using time = new FakeTime(Date.UTC(2026, 9, 10));
    const peer = directPeer();
    const client = await connect({ transport: peer.transport });
    try {
      const existing = await client.mount(did, {}, signer);
      const sibling = await client.mount("space:sibling", {}, signer);
      await advance(time, 2000);
      const mount = observe(client.mount("space:A", {}, signer));
      await time.runMicrotasks();
      peer.refuse(1);
      await time.runMicrotasks();
      const restoring = observe(existing.restore());
      await time.runMicrotasks();
      expect(peer.auths).toHaveLength(3);
      peer.refuse(2, false);
      await restoring.result;
      await time.runMicrotasks();
      expect(mount.state()).toBe("rejected");
      expect(await mount.result).toMatchObject({
        message: "signature refused",
      });
      expect(existing.closeError?.message).toBe("signature refused");
      expect(sibling.closeError).toBe(existing.closeError);
      expect(time.next()).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("rejects renewal waiters when their connection drops", async () => {
    using time = new FakeTime(Date.UTC(2026, 9, 10));
    const peer = directPeer();
    const client = await connect({ transport: peer.transport });
    try {
      await client.mount(did, {}, signer);
      await advance(time, 2000);
      const mount = observe(client.mount("space:A", {}, signer));
      await time.runMicrotasks();
      peer.drop();
      expect(await mount.result).toMatchObject({ name: "ConnectionError" });
      expect(mount.state()).toBe("rejected");
    } finally {
      await client.close();
    }
  });

  it("reauthenticates a waiting mount when its renewing key is released", async () => {
    using time = new FakeTime(Date.UTC(2026, 9, 10));
    const peer = directPeer();
    const client = await connect({ transport: peer.transport });
    try {
      await client.mount(did, {}, signer);
      await advance(time, 2000);
      const mount = observe(client.mount("space:A", {}, signer));
      await time.runMicrotasks();
      peer.refuse(1);
      await time.runMicrotasks();
      await client.release(did);
      await time.runMicrotasks();
      expect(peer.auths).toHaveLength(3);
      peer.accept(2);
      await mount.result;
      expect(mount.state()).toBe("resolved");
      expect(peer.counts().opens).toBe(2);
    } finally {
      await client.close();
    }
  });
});
