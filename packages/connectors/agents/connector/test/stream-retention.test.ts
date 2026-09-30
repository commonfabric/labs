import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { streamSource } from "../src/reconcile.ts";
import type { AgentDriver, SessionPage, SessionSummary } from "../src/types.ts";

/** Constructs a paginated driver which records transcript reads. */
function fixture() {
  const summaries: SessionSummary[] = ["one", "two"].map((id) => ({
    nativeSessionId: id,
    title: id,
    cwd: null,
    createdAt: null,
    updatedAt: null,
    archived: false,
    active: false,
    raw: {},
  }));
  const pages: SessionPage[] = [
    { sessions: [summaries[0]], nextCursor: "1" },
    { sessions: [summaries[1]] },
  ];
  const listed: Array<string | undefined> = [];
  const reads: string[] = [];
  const driver: AgentDriver = {
    source: {
      id: "sample",
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
    listSessions: (cursor) => {
      listed.push(cursor);
      return Promise.resolve(pages[Number(cursor ?? 0)]);
    },
    readSession: (id) => {
      reads.push(id);
      return Promise.resolve({
        summary: summaries.find((summary) => summary.nativeSessionId === id)!,
        events: [],
        normalizedMessages: [],
        complete: true,
      });
    },
    prompt: () => Promise.resolve({ status: "unsupported" }),
    startSession: () => Promise.resolve({ status: "unsupported" }),
    cancel: () => Promise.resolve({ status: "unsupported" }),
    renameSession: () => Promise.resolve({ status: "unsupported" }),
    setMode: () => Promise.resolve({ status: "unsupported" }),
    setConfigOption: () => Promise.resolve({ status: "unsupported" }),
  };
  return { driver, listed, pages, reads, summaries };
}

describe("streamSource()", () => {
  it("retains an accepted summary and reads the other session", async () => {
    const { driver, reads } = fixture();
    const collected = streamSource(
      driver,
      undefined,
      (summary) => summary.nativeSessionId === "one",
    );
    const sessions = [];
    for await (const session of collected.sessions) sessions.push(session);

    expect(reads).toEqual(["two"]);
    expect(sessions.map((session) => session.summary.nativeSessionId))
      .toEqual(["two"]);
    expect(collected.retained.map((summary) => summary.nativeSessionId))
      .toEqual(["one"]);
    expect(collected.outcome).toEqual({
      errors: [],
      complete: true,
      sessionCount: 1,
      consumed: true,
    });
  });

  for (const retainFirst of [false, true]) {
    it(`records a duplicate once when retention is ${retainFirst}`, async () => {
      const { driver, listed, pages, reads, summaries } = fixture();
      pages[1] = { sessions: summaries, nextCursor: "2" };
      pages.push({ sessions: [summaries[0]] });
      const collected = streamSource(
        driver,
        undefined,
        (summary) => retainFirst && summary.nativeSessionId === "one",
      );
      const sessions = [];
      for await (const session of collected.sessions) sessions.push(session);

      expect(reads).toEqual(retainFirst ? ["two"] : ["one", "two"]);
      expect(listed).toEqual([undefined, "1", "2"]);
      expect(sessions.length).toBe(reads.length);
      expect(collected.retained.map((summary) => summary.nativeSessionId))
        .toEqual(retainFirst ? ["one"] : []);
      expect(collected.outcome.complete).toBe(false);
      expect(collected.outcome.errors).toEqual([{
        nativeSessionId: "one",
        message: "duplicate session in inventory: one",
      }]);
    });
  }

  it("keeps reading after a failed session without vouching for the inventory", async () => {
    const { driver, reads } = fixture();
    const readSession = driver.readSession;
    driver.readSession = (id) =>
      id === "one"
        ? Promise.reject(new Error("transcript unavailable"))
        : readSession(id);
    const collected = streamSource(driver);
    const sessions = await Array.fromAsync(collected.sessions);

    expect(reads).toEqual(["two"]);
    expect(sessions.map((session) => session.summary.nativeSessionId))
      .toEqual(["two"]);
    expect(collected.outcome).toEqual({
      errors: [{
        nativeSessionId: "one",
        message: "Error: transcript unavailable",
      }],
      complete: false,
      sessionCount: 1,
      consumed: true,
    });
  });

  it("stops a repeated cursor before listing it again", async () => {
    const { driver, listed, pages, reads } = fixture();
    pages[1].nextCursor = "1";
    const collected = streamSource(driver);
    const sessions = await Array.fromAsync(collected.sessions);

    expect(listed).toEqual([undefined, "1"]);
    expect(reads).toEqual(["one", "two"]);
    expect(sessions.map((session) => session.summary.nativeSessionId))
      .toEqual(reads);
    expect(collected.outcome).toEqual({
      errors: [{ message: "Error: repeated session cursor: 1" }],
      complete: false,
      sessionCount: 2,
      consumed: true,
    });
  });

  it("counts repeated listings toward the inventory safety limit", async () => {
    const { driver, listed, pages, reads, summaries } = fixture();
    pages[0].sessions = Array(100_000).fill(summaries[0]);
    const collected = streamSource(driver);
    const sessions = await Array.fromAsync(collected.sessions);

    expect(listed).toEqual([undefined, "1"]);
    expect(reads).toEqual(["one"]);
    expect(sessions.map((session) => session.summary.nativeSessionId))
      .toEqual(["one"]);
    expect(collected.outcome).toEqual({
      errors: [
        {
          nativeSessionId: "one",
          message: "duplicate session in inventory: one",
        },
        { message: "Error: session enumeration exceeded safety limit" },
      ],
      complete: false,
      sessionCount: 1,
      consumed: true,
    });
  });

  it("rejects a canceled read without recording it as a session error", async () => {
    const { driver, listed } = fixture();
    const controller = new AbortController();
    const reason = new Error("collection canceled");
    driver.readSession = () => {
      controller.abort(reason);
      return Promise.reject(new Error("interrupted read"));
    };
    const collected = streamSource(driver, controller.signal);

    await expect(Array.fromAsync(collected.sessions)).rejects.toBe(reason);
    expect(listed).toEqual([undefined]);
    expect(collected.outcome).toEqual({
      errors: [],
      complete: false,
      sessionCount: 0,
      consumed: true,
    });
  });
});
