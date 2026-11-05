import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { ServerMessage } from "../v2.ts";
import { Server } from "../v2/server.ts";
import { encodeMemoryBoundary, getMemoryProtocolFlags } from "../v2.ts";
import { Identity } from "@commonfabric/identity";
const principal = (await Identity.fromRaw(new Uint8Array(32).fill(31))).did();
const space = (await Identity.fromRaw(new Uint8Array(32).fill(32))).did();
const audience = (await Identity.fromRaw(new Uint8Array(32).fill(33))).did();
const hello = {
  type: "hello",
  protocol: "memory",
  flags: getMemoryProtocolFlags(),
};
async function probe(event: string) {
  let now = Math.floor(Date.now() / 1000), owns = true;
  const options: ConstructorParameters<typeof Server>[0] = {
    store: new URL("memory://routed-review-queued-" + event),
    subscriptionRefreshDelayMs: "manual",
    authorizeSessionOpen: (m) =>
      typeof m.invocation?.iss === "string" ? m.invocation.iss : undefined,
    authorizeConnection: (m) =>
      typeof m.invocation?.iss === "string" ? m.invocation.iss : undefined,
    sessionOpenAuth: { audience, nowSeconds: () => now },
    ownsSpace: (s) => s === space,
    requireExplicitAcl: false,
    acl: { mode: "enforce" },
  };
  const server = new Server(options),
    seedOut: ServerMessage[] = [],
    seed = server.connect((m) => seedOut.push(m));
  try {
    await seed.receive(encodeMemoryBoundary(hello));
    const h = seedOut.shift();
    if (h?.type !== "hello.ok" || h.sessionOpen === undefined) {
      throw new Error("hello");
    }
    await seed.receive(
      encodeMemoryBoundary({
        type: "session.open",
        requestId: "seed-open",
        space,
        session: {},
        invocation: {
          iss: space,
          aud: audience,
          challenge: h.sessionOpen.challenge.value,
        },
      }),
    );
    const seeded = seedOut.find((m) =>
      m.type === "response" && m.requestId === "seed-open"
    );
    if (
      seeded?.type !== "response" || !seeded.ok ||
      typeof seeded.ok !== "object" || !("sessionId" in seeded.ok) ||
      typeof seeded.ok.sessionId !== "string"
    ) throw new Error("seed open");
    await seed.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "seed-acl",
      space,
      sessionId: seeded.ok.sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:" + space,
          value: { value: { [principal]: "OWNER" } },
        }],
      },
    }));
    options.requireExplicitAcl = true;
    const out: ServerMessage[] = [],
      connection = server.connectRouted(
        (m) => out.push(m),
        (s) => owns && s === space,
      );
    await connection.receive(encodeMemoryBoundary(hello));
    connection.admitRoutedPrincipal(principal, now + 600);
    await connection.receive(
      encodeMemoryBoundary({
        type: "session.open",
        requestId: "r-open",
        space,
        principal,
        session: {},
      }),
    );
    const opened = out.find((m) =>
      m.type === "response" && m.requestId === "r-open"
    );
    if (
      opened?.type !== "response" || !opened.ok ||
      typeof opened.ok !== "object" || !("sessionId" in opened.ok) ||
      typeof opened.ok.sessionId !== "string"
    ) throw new Error("routed open");
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const lock = server.accessForTestingOnly.withSpacePublicationLock(
      space,
      () => {
        entered.resolve();
        return release.promise;
      },
    );
    await entered.promise;
    const reached = Promise.withResolvers<void>(),
      original = server.transact.bind(server);
    server.transact = (m, publish) => {
      const p = original(m, publish);
      reached.resolve();
      return p;
    };
    const pending = connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "queued",
      space,
      sessionId: opened.ok.sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:review-write",
          value: { value: "unexpected" },
        }],
      },
    }));
    await reached.promise;
    if (event === "close") connection.close();
    if (event === "resume") {
      connection.close();
      const resumedOut: ServerMessage[] = [],
        resumed = server.connectRouted(
          (m) => resumedOut.push(m),
          (s) => s === space,
        );
      await resumed.receive(encodeMemoryBoundary(hello));
      resumed.admitRoutedPrincipal(principal, now + 600);
      await resumed.receive(
        encodeMemoryBoundary({
          type: "session.open",
          requestId: "resume",
          space,
          principal,
          session: {
            sessionId: opened.ok.sessionId,
            sessionToken: opened.ok.sessionToken,
          },
        }),
      );
      const result = resumedOut.find((m) =>
        m.type === "response" && m.requestId === "resume"
      );
      expect(result?.type === "response" && result.ok !== undefined).toBe(true);
    }
    if (event === "expiry") now += 600;
    if (event === "ownership") owns = false;
    if (event === "release") connection.releasePrincipal(principal);
    release.resolve();
    await Promise.all([lock, pending]);
    return {
      event,
      committed: await server.readDocument(space, "of:review-write") !== null,
      error: out.filter((m) => m.type === "response").find((m) =>
        m.requestId === "queued"
      )?.error?.name,
    };
  } finally {
    await server.close();
  }
}
describe("routed-session-authority", () => {
  for (const event of ["close", "expiry", "ownership", "release", "resume"]) {
    it(`rechecks ${event} after a queued write acquires its publication turn`, async () => {
      const result = await probe(event);
      expect(result.committed).toBe(event === "release");
      if (event !== "release") {
        expect(["SessionRevokedError", "SessionError"]).toContain(result.error);
      }
    });
  }
});
