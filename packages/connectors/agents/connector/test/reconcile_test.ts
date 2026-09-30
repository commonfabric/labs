import { assertEquals } from "@std/assert";
import {
  collectSource,
  prepareSession,
  streamSource,
} from "../src/reconcile.ts";
import type {
  AgentDriver,
  NativeSessionSnapshot,
  SessionPage,
} from "../src/types.ts";

function fakeDriver(): AgentDriver {
  const summaries = ["one", "two"].map((id) => ({
    nativeSessionId: id,
    title: id,
    cwd: null,
    createdAt: null,
    updatedAt: null,
    archived: false,
    active: false,
    raw: { id },
  }));
  return {
    source: {
      id: "fake:default",
      driver: "acp",
      capabilities: {
        inventory: true,
        read: true,
        prompt: false,
        cancel: false,
        rename: false,
        setMode: false,
        setConfigOption: false,
      },
    },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    listSessions: (cursor?: string): Promise<SessionPage> =>
      Promise.resolve(
        cursor
          ? { sessions: [summaries[1]] }
          : { sessions: [summaries[0]], nextCursor: "next" },
      ),
    readSession: (id: string): Promise<NativeSessionSnapshot> =>
      Promise.resolve({
        summary: summaries.find((summary) => summary.nativeSessionId === id)!,
        events: [{ id: `${id}-message`, text: "hello" }],
        normalizedMessages: [],
        complete: true,
      }),
    prompt: () => Promise.resolve({ status: "unsupported" }),
    startSession: () => Promise.resolve({ status: "unsupported" }),
    cancel: () => Promise.resolve({ status: "unsupported" }),
    renameSession: () => Promise.resolve({ status: "unsupported" }),
    setMode: () => Promise.resolve({ status: "unsupported" }),
    setConfigOption: () => Promise.resolve({ status: "unsupported" }),
  };
}

Deno.test("collectSource consumes every page and prepares stable session snapshots", async () => {
  const collected = await collectSource(fakeDriver());
  assertEquals(collected.complete, true);
  assertEquals(
    collected.sessions.map((session) => session.summary.nativeSessionId),
    ["one", "two"],
  );

  const first = await prepareSession("fake:default", collected.sessions[0], 64);
  const again = await prepareSession("fake:default", collected.sessions[0], 64);
  assertEquals(first, again);
  assertEquals(first.key, "fake%3Adefault/one");
  assertEquals(first.chunks[0].events, [{ id: "one-message", text: "hello" }]);
  assertEquals(first.snapshotHash.startsWith("sha256:"), true);
});

Deno.test("collectSource lists a session the retain predicate accepts without reading it", async () => {
  const reads: string[] = [];
  const base = fakeDriver();
  const driver: AgentDriver = {
    ...base,
    readSession: (id: string) => {
      reads.push(id);
      return base.readSession(id);
    },
  };

  const collected = await collectSource(driver, {
    retain: (summary) => summary.nativeSessionId === "one",
  });

  assertEquals(reads, ["two"]);
  assertEquals(
    collected.retained?.map((summary) => summary.nativeSessionId),
    ["one"],
  );
  assertEquals(
    collected.sessions.map((session) => session.summary.nativeSessionId),
    ["two"],
  );
  assertEquals(collected.complete, true);
});

Deno.test("collectSource keeps a session a later page repeats once and records the repeat", async () => {
  // A provider whose cursors overlap lists one session on two pages, the
  // second time with a newer update. The first listing stands, the session
  // is read once, and the inventory is not complete on the provider's word.
  const base = fakeDriver();
  const reads: string[] = [];
  const first = (await base.listSessions()).sessions[0];
  const second = (await base.listSessions("next")).sessions[0];
  const driver: AgentDriver = {
    ...base,
    listSessions: (cursor?: string): Promise<SessionPage> =>
      Promise.resolve(
        cursor
          ? {
            sessions: [
              { ...first, updatedAt: "2026-09-14T00:00:00.000Z" },
              second,
            ],
          }
          : { sessions: [first], nextCursor: "next" },
      ),
    readSession: (id: string) => {
      reads.push(id);
      return base.readSession(id);
    },
  };

  const collected = await collectSource(driver);

  assertEquals(reads, ["one", "two"]);
  assertEquals(collected.errors, [{
    nativeSessionId: "one",
    message: "duplicate session in inventory: one",
  }]);
  assertEquals(collected.complete, false);
  assertEquals(
    collected.sessions.map((session) => session.summary.nativeSessionId),
    ["one", "two"],
  );
});

Deno.test("collectSource ends an inventory that repeats one session under fresh cursors", async () => {
  // Every page is a new cursor listing the same session many times over:
  // the deduplicated inventory never grows, so the safety limit counts the
  // listings the provider sends, and the repeat is recorded once.
  const base = fakeDriver();
  const one = (await base.listSessions()).sessions[0];
  const reads: string[] = [];
  let pages = 0;
  const driver: AgentDriver = {
    ...base,
    listSessions: (): Promise<SessionPage> => {
      pages++;
      return Promise.resolve({
        sessions: Array.from({ length: 60_000 }, () => one),
        nextCursor: `cursor-${pages}`,
      });
    },
    readSession: (id: string) => {
      reads.push(id);
      return base.readSession(id);
    },
  };

  const collected = await collectSource(driver);

  assertEquals(pages, 2);
  assertEquals(reads, ["one"]);
  assertEquals(collected.errors, [
    { nativeSessionId: "one", message: "duplicate session in inventory: one" },
    { message: "Error: session enumeration exceeded safety limit" },
  ]);
  assertEquals(collected.complete, false);
});

Deno.test("streamSource reads the next session only after publication advances", async () => {
  const calls: string[] = [];
  const driver = fakeDriver();
  const listSessions = driver.listSessions;
  const readSession = driver.readSession;
  driver.listSessions = async (cursor) => {
    calls.push(`list:${cursor ?? "first"}`);
    return await listSessions(cursor);
  };
  driver.readSession = async (nativeSessionId) => {
    calls.push(`read:${nativeSessionId}`);
    return await readSession(nativeSessionId);
  };

  const collected = streamSource(driver);
  const sessions = collected.sessions[Symbol.asyncIterator]();
  assertEquals((await sessions.next()).value?.summary.nativeSessionId, "one");
  assertEquals(calls, ["list:first", "read:one"]);
  assertEquals(collected.outcome.sessionCount, 1);

  assertEquals((await sessions.next()).value?.summary.nativeSessionId, "two");
  assertEquals(calls, ["list:first", "read:one", "list:next", "read:two"]);
  assertEquals((await sessions.next()).done, true);
  assertEquals(collected.outcome, {
    errors: [],
    complete: true,
    sessionCount: 2,
    consumed: true,
  });
});

Deno.test("streamSource consults the current cancellation signal", async () => {
  const controller = new AbortController();
  let cancellationEnabled = true;
  const collected = streamSource(
    fakeDriver(),
    () => cancellationEnabled ? controller.signal : undefined,
  );
  const sessions = collected.sessions[Symbol.asyncIterator]();
  assertEquals((await sessions.next()).value?.summary.nativeSessionId, "one");

  controller.abort(new Error("publication can no longer stop"));
  cancellationEnabled = false;

  assertEquals((await sessions.next()).value?.summary.nativeSessionId, "two");
  assertEquals((await sessions.next()).done, true);
  assertEquals(collected.outcome.complete, true);
});

Deno.test("collectSource retains lifecycle state reported only by inventory", async () => {
  const inventorySummary = {
    nativeSessionId: "one",
    title: "one",
    cwd: null,
    createdAt: null,
    updatedAt: null,
    archived: true,
    active: false,
    raw: { id: "one", archived: true },
  };
  const driver: AgentDriver = {
    ...fakeDriver(),
    listSessions: () => Promise.resolve({ sessions: [inventorySummary] }),
    readSession: () =>
      Promise.resolve({
        summary: {
          ...inventorySummary,
          archived: null,
          active: null,
          raw: { id: "one" },
        },
        events: [],
        normalizedMessages: [],
        complete: true,
      }),
  };

  const collected = await collectSource(driver);

  assertEquals(collected.sessions[0].summary.archived, true);
  assertEquals(collected.sessions[0].summary.active, false);
});

Deno.test("collectSource rejects an oversized terminal inventory page", async () => {
  const summary = {
    nativeSessionId: "one",
    title: "one",
    cwd: null,
    createdAt: null,
    updatedAt: null,
    archived: false,
    active: false,
    raw: { id: "one" },
  };
  let readCalls = 0;
  const driver: AgentDriver = {
    ...fakeDriver(),
    listSessions: () =>
      Promise.resolve({ sessions: Array(100_001).fill(summary) }),
    readSession: () => {
      readCalls++;
      return Promise.reject(new Error("oversized inventory was read"));
    },
  };

  const collected = await collectSource(driver);

  assertEquals(collected.complete, false);
  assertEquals(collected.sessions, []);
  assertEquals(collected.errors, [{
    message: "Error: session enumeration exceeded safety limit",
  }]);
  assertEquals(readCalls, 0);
});
