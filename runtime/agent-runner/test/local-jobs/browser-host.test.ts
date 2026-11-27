import { expect } from "@std/expect";

import type { BrowserHostResult } from "@commonfabric/cf-harness/contracts/browser-host";
import { describe, it } from "@commonfabric/test-support/test";

import { LocalJobBrowserHost } from "../../src/local-jobs/browser-host.ts";

/** An answer the host gives. */
const OK: BrowserHostResult = {
  status: "ok",
  page: { url: "https://example.com/", title: "Example" },
};

/** An answer the host gives in a named session, which reports sites. */
const NAMED_OK: BrowserHostResult = {
  status: "ok",
  page: {
    url: "https://example.com/",
    title: "Example",
    site: "https://example.com",
    sites: ["https://example.com"],
  },
};

/** One event read off a host stream. */
interface Frame {
  event: string;
  data: Record<string, unknown>;
}

/** Helper for tests, which reads a host stream one event at a time. */
const reader = (stream: ReadableStream<Uint8Array>) => {
  const text = new Response(stream).body!.pipeThrough(new TextDecoderStream())
    .getReader();
  let buffer = "";
  return {
    /** The next event, or `undefined` once the stream has ended. */
    async next(): Promise<Frame | undefined> {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1] ?? "";
          const data = /^data: (.*)$/m.exec(frame)?.[1] ?? "{}";
          return { event, data: JSON.parse(data) };
        }
        const { value, done } = await text.read();
        if (done) return undefined;
        buffer += value;
      }
    },
    cancel: () => text.cancel(),
  };
};

/** Helper for tests, which reads whether a promise has settled yet. */
const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false;
  promise.then(() => done = true, () => done = true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
};

describe("LocalJobBrowserHost", () => {
  it("delivers each operation in order and resolves with the host's answer", async () => {
    const host = new LocalJobBrowserHost();
    const opened = host.perform({
      operation: { action: "open", url: "https://example.com" },
    });
    const snapshot = host.perform({
      operation: { action: "snapshot", interactive: true },
    });
    const stream = reader(host.attach());
    expect(await stream.next()).toEqual({
      event: "request",
      data: {
        id: "1",
        operation: { action: "open", url: "https://example.com" },
      },
    });
    expect(await stream.next()).toEqual({
      event: "request",
      data: { id: "2", operation: { action: "snapshot", interactive: true } },
    });
    expect(host.acceptResult("1", OK)).toBe("accepted");
    expect(await opened).toEqual(OK);
    expect(host.acceptResult("2", { ...OK, text: "- heading" })).toBe(
      "accepted",
    );
    expect(await snapshot).toEqual({ ...OK, text: "- heading" });
    expect(host.view()).toEqual({
      state: "open",
      attached: true,
      outstanding: 0,
      withdrawn: 0,
    });
    await stream.cancel();
  });

  it("withdraws a delivered operation and holds the next until the host acknowledges it", async () => {
    const host = new LocalJobBrowserHost();
    const stream = reader(host.attach());
    const abort = new AbortController();
    const click = host.perform(
      { operation: { action: "click", ref: "@e3" } },
      abort.signal,
    );
    expect((await stream.next())?.data.id).toBe("1");
    abort.abort(new Error("the run moved on"));
    await expect(click).rejects.toThrow("the run moved on");
    expect(await stream.next()).toEqual({
      event: "withdraw",
      data: { id: "1" },
    });
    expect(host.view().withdrawn).toBe(1);

    const next = host.perform({
      operation: { action: "snapshot", interactive: true },
    });
    // Nothing reaches the host until it answers the withdrawn operation.
    expect(await settled(next)).toBe(false);
    expect(host.view()).toMatchObject({ outstanding: 1, withdrawn: 1 });
    expect(
      host.acceptResult("1", { status: "failed", message: "withdrawn" }),
    ).toBe("accepted");
    expect(await stream.next()).toEqual({
      event: "request",
      data: { id: "2", operation: { action: "snapshot", interactive: true } },
    });
    host.acceptResult("2", OK);
    expect(await next).toEqual(OK);
    await stream.cancel();
  });

  it("takes any answer to a withdrawn operation as its acknowledgment, as the console does", async () => {
    const host = new LocalJobBrowserHost();
    const stream = reader(host.attach());
    const abort = new AbortController();
    const click = host.perform(
      { operation: { action: "click", ref: "@e3" } },
      abort.signal,
    );
    await stream.next();
    abort.abort(new Error("moved on"));
    await expect(click).rejects.toThrow("moved on");
    await stream.next();
    const next = host.perform({ operation: { action: "back" } });
    expect(host.acceptResult("1", { status: "not a result" })).toBe("accepted");
    expect((await stream.next())?.data.id).toBe("2");
    host.acceptResult("2", OK);
    expect(await next).toEqual(OK);
    await stream.cancel();
  });

  it("drops an operation the run withdraws before the host has it", async () => {
    const host = new LocalJobBrowserHost();
    const abort = new AbortController();
    const queued = host.perform(
      { operation: { action: "reload" } },
      abort.signal,
    );
    abort.abort(new Error("gone"));
    await expect(queued).rejects.toThrow("gone");
    await expect(
      host.perform({ operation: { action: "back" } }, abort.signal),
    ).rejects.toThrow("gone");
    const stream = reader(host.attach());
    host.perform({ operation: { action: "forward" } });
    expect(await stream.next()).toEqual({
      event: "request",
      data: { id: "2", operation: { action: "forward" } },
    });
    await stream.cancel();
  });

  it("outlives a dropped stream, and sends the next attach what is still owed", async () => {
    const host = new LocalJobBrowserHost();
    const abort = new AbortController();
    const first = reader(host.attach());
    const withdrawn = host.perform(
      { operation: { action: "click", ref: "@e1" } },
      abort.signal,
    );
    await first.next();
    abort.abort(new Error("moved on"));
    await expect(withdrawn).rejects.toThrow("moved on");
    await first.cancel();
    expect(host.view().state).toBe("open");

    // Sent while nobody is attached: it waits behind the acknowledgment.
    const waiting = host.perform({
      operation: { action: "snapshot", interactive: true },
    });
    const second = reader(host.attach());
    expect(await second.next()).toEqual({
      event: "request",
      data: { id: "1", operation: { action: "click", ref: "@e1" } },
    });
    expect(await second.next()).toEqual({
      event: "withdraw",
      data: { id: "1" },
    });
    host.acceptResult("1", { status: "failed", message: "withdrawn" });
    expect((await second.next())?.data.id).toBe("2");

    // A third attach is sent the delivered operation again, and replaces
    // the second, which ends.
    const third = reader(host.attach());
    expect(await second.next()).toBeUndefined();
    expect(await third.next()).toEqual({
      event: "request",
      data: { id: "2", operation: { action: "snapshot", interactive: true } },
    });
    host.acceptResult("2", OK);
    expect(await waiting).toEqual(OK);
    await third.cancel();
  });

  it("closes: tells the host, ends its stream, and settles everything as session-ended", async () => {
    const host = new LocalJobBrowserHost();
    const stream = reader(host.attach());
    const delivered = host.perform({
      operation: { action: "open", url: "https://a.test" },
    });
    await stream.next();
    host.close();
    host.close();
    expect(await delivered).toEqual({
      status: "session-ended",
      message: "the job has ended",
    });
    expect(await stream.next()).toEqual({ event: "close", data: {} });
    expect(await stream.next()).toBeUndefined();
    expect(await host.perform({ operation: { action: "back" } })).toEqual({
      status: "session-ended",
      message: "the job has ended",
    });
    expect(host.view()).toEqual({
      state: "closed",
      attached: false,
      outstanding: 0,
      withdrawn: 0,
    });

    const late = reader(host.attach());
    expect(await late.next()).toEqual({ event: "close", data: {} });
    expect(await late.next()).toBeUndefined();
  });

  it("settles operations still queued when it closes before anyone attached", async () => {
    const host = new LocalJobBrowserHost();
    const queued = host.perform({
      operation: { action: "snapshot", interactive: true },
    });
    host.close();
    expect(await queued).toEqual({
      status: "session-ended",
      message: "the job has ended",
    });
  });

  it("reads a repeated answer as a duplicate, and refuses unknown ids and non-results", async () => {
    const host = new LocalJobBrowserHost();
    const stream = reader(host.attach());
    const first = host.perform({
      operation: { action: "snapshot", interactive: true },
    });
    const second = host.perform({
      operation: { action: "get", kind: "title" },
    });
    await stream.next();
    await stream.next();
    expect(host.acceptResult(1, OK)).toBe("unknown");
    expect(host.acceptResult("9", OK)).toBe("unknown");
    expect(host.acceptResult("1", OK)).toBe("accepted");
    expect(host.acceptResult("1", { ...OK, text: "again" })).toBe("duplicate");
    expect(await first).toEqual(OK);
    expect(host.acceptResult("2", { status: "fine" })).toBe("invalid");
    expect(await second).toEqual({
      status: "failed",
      message: "the browser host answered with something that is not a result",
    });
    await stream.cancel();
  });

  it("does not deliver an operation queued before attach to nobody", async () => {
    const host = new LocalJobBrowserHost();
    const pending = host.perform({
      operation: { action: "snapshot", interactive: true },
    });
    expect(host.view()).toEqual({
      state: "open",
      attached: false,
      outstanding: 0,
      withdrawn: 0,
    });
    // An answer for an operation the host was never sent is not one.
    expect(host.acceptResult("1", OK)).toBe("unknown");
    expect(await settled(pending)).toBe(false);
    host.close();
  });

  describe("detach", () => {
    it("settles every session's operations, outstanding, queued or later, as session-ended", async () => {
      const host = new LocalJobBrowserHost();
      const stream = reader(host.attach());
      const abort = new AbortController();
      const withdrawn = host.perform(
        { session: "a", operation: { action: "click", ref: "@e1" } },
        abort.signal,
      );
      const delivered = host.perform({
        session: "b",
        operation: { action: "handoff", reason: "sign-in" },
      });
      const unnamed = host.perform({ operation: { action: "reload" } });
      await stream.next();
      await stream.next();
      await stream.next();
      abort.abort(new Error("moved on"));
      await expect(withdrawn).rejects.toThrow("moved on");
      await stream.next();
      const queued = host.perform({
        session: "a",
        operation: { action: "back" },
      });

      host.detach();

      const ended = {
        status: "session-ended",
        message: "the browser host detached",
      };
      expect(await Promise.all([delivered, unnamed, queued])).toEqual([
        ended,
        ended,
        ended,
      ]);
      expect(
        await host.perform({ session: "c", operation: { action: "reload" } }),
      ).toEqual(ended);
      expect(await stream.next()).toEqual({ event: "close", data: {} });
      expect(await stream.next()).toBeUndefined();
      expect(host.view()).toEqual({
        state: "closed",
        attached: false,
        outstanding: 0,
        withdrawn: 0,
      });
    });

    it("changes nothing once the channel has ended or detached", async () => {
      const closed = new LocalJobBrowserHost();
      closed.close();
      closed.detach();
      const detached = new LocalJobBrowserHost();
      detached.detach();
      detached.detach();
      detached.close();

      expect(await closed.perform({ operation: { action: "reload" } }))
        .toEqual({ status: "session-ended", message: "the job has ended" });
      expect(await detached.perform({ operation: { action: "reload" } }))
        .toEqual({
          status: "session-ended",
          message: "the browser host detached",
        });
    });
  });

  describe("sessions", () => {
    it("frames each operation with the session it addresses, and with none for the unnamed session", async () => {
      const host = new LocalJobBrowserHost();
      const stream = reader(host.attach());
      host.perform({ operation: { action: "reload" } });
      host.perform({ session: "bank", operation: { action: "back" } });

      expect(await stream.next()).toEqual({
        event: "request",
        data: { id: "1", operation: { action: "reload" } },
      });
      expect(await stream.next()).toEqual({
        event: "request",
        data: { id: "2", session: "bank", operation: { action: "back" } },
      });
      host.close();
    });

    it("settles each session's operation when the host answers it, in whatever order", async () => {
      const host = new LocalJobBrowserHost();
      const stream = reader(host.attach());
      const slow = host.perform({
        session: "a",
        operation: { action: "handoff", reason: "sign-in" },
      });
      const fast = host.perform({
        session: "b",
        operation: { action: "snapshot", interactive: true },
      });
      await stream.next();
      await stream.next();

      expect(host.acceptResult("2", NAMED_OK)).toBe("accepted");
      expect(await fast).toEqual(NAMED_OK);
      expect(await settled(slow)).toBe(false);
      host.acceptResult("1", { ...NAMED_OK, handoff: "done" });
      expect(await slow).toEqual({ ...NAMED_OK, handoff: "done" });
      await stream.cancel();
    });

    it("holds back only the session that owes an acknowledgment of a withdrawal, and keeps each session's order", async () => {
      const host = new LocalJobBrowserHost();
      const stream = reader(host.attach());
      const abort = new AbortController();
      const click = host.perform(
        { session: "a", operation: { action: "click", ref: "@e1" } },
        abort.signal,
      );
      await stream.next();
      abort.abort(new Error("moved on"));
      await expect(click).rejects.toThrow("moved on");
      expect(await stream.next()).toEqual({
        event: "withdraw",
        data: { id: "1" },
      });

      const a2 = host.perform({ session: "a", operation: { action: "back" } });
      const a3 = host.perform({
        session: "a",
        operation: { action: "reload" },
      });
      const b1 = host.perform({
        session: "b",
        operation: { action: "reload" },
      });
      const unnamed = host.perform({ operation: { action: "forward" } });
      // The other sessions' operations reach the host at once.
      expect(await stream.next()).toMatchObject({
        data: { id: "4", session: "b" },
      });
      expect((await stream.next())?.data).toEqual({
        id: "5",
        operation: { action: "forward" },
      });
      host.acceptResult("4", NAMED_OK);
      host.acceptResult("5", OK);
      expect(await b1).toEqual(NAMED_OK);
      expect(await unnamed).toEqual(OK);
      expect(await settled(a2)).toBe(false);

      host.acceptResult("1", { status: "failed", message: "withdrawn" });
      expect((await stream.next())?.data).toEqual({
        id: "2",
        session: "a",
        operation: { action: "back" },
      });
      expect((await stream.next())?.data).toEqual({
        id: "3",
        session: "a",
        operation: { action: "reload" },
      });
      host.acceptResult("2", NAMED_OK);
      host.acceptResult("3", NAMED_OK);
      expect(await a2).toEqual(NAMED_OK);
      expect(await a3).toEqual(NAMED_OK);
      await stream.cancel();
    });

    it("sends a resumed stream what is still owed in every session, and holds back only the withdrawing one", async () => {
      const host = new LocalJobBrowserHost();
      const abort = new AbortController();
      const first = reader(host.attach());
      const a1 = host.perform(
        { session: "a", operation: { action: "click", ref: "@e1" } },
        abort.signal,
      );
      const b1 = host.perform({
        session: "b",
        operation: { action: "snapshot", interactive: true },
      });
      const unnamed = host.perform({ operation: { action: "reload" } });
      await first.next();
      await first.next();
      await first.next();
      abort.abort(new Error("moved on"));
      await expect(a1).rejects.toThrow("moved on");
      await first.cancel();

      // Sent while nobody is attached.
      const a2 = host.perform({ session: "a", operation: { action: "back" } });
      const b2 = host.perform({ session: "b", operation: { action: "back" } });
      const second = reader(host.attach());
      const resent = [];
      for (let index = 0; index < 5; index++) {
        resent.push(await second.next());
      }

      expect(resent).toEqual([
        {
          event: "request",
          data: {
            id: "1",
            session: "a",
            operation: { action: "click", ref: "@e1" },
          },
        },
        { event: "withdraw", data: { id: "1" } },
        {
          event: "request",
          data: {
            id: "2",
            session: "b",
            operation: { action: "snapshot", interactive: true },
          },
        },
        {
          event: "request",
          data: { id: "3", operation: { action: "reload" } },
        },
        {
          event: "request",
          data: { id: "5", session: "b", operation: { action: "back" } },
        },
      ]);
      host.acceptResult("1", { status: "failed", message: "withdrawn" });
      expect((await second.next())?.data).toEqual({
        id: "4",
        session: "a",
        operation: { action: "back" },
      });

      // Once acknowledged, the withdrawal is owed no more.
      const third = reader(host.attach());
      expect(await second.next()).toBeUndefined();
      const owed = [];
      for (let index = 0; index < 4; index++) {
        owed.push((await third.next())?.data.id);
      }
      expect(owed).toEqual(["2", "3", "5", "4"]);
      for (const id of ["2", "4", "5"]) host.acceptResult(id, NAMED_OK);
      host.acceptResult("3", OK);
      expect(await Promise.all([b1, unnamed, a2, b2])).toEqual([
        NAMED_OK,
        OK,
        NAMED_OK,
        NAMED_OK,
      ]);
      host.close();
      expect(await third.next()).toEqual({ event: "close", data: {} });
    });

    it("holds back only the unnamed session when it owes an acknowledgment of a withdrawal", async () => {
      const host = new LocalJobBrowserHost();
      const stream = reader(host.attach());
      const abort = new AbortController();
      const withdrawn = host.perform(
        { operation: { action: "click", ref: "@e1" } },
        abort.signal,
      );
      await stream.next();
      abort.abort(new Error("moved on"));
      await expect(withdrawn).rejects.toThrow("moved on");
      await stream.next();

      const next = host.perform({ operation: { action: "back" } });
      const named = host.perform({
        session: "b",
        operation: { action: "back" },
      });
      expect((await stream.next())?.data).toEqual({
        id: "3",
        session: "b",
        operation: { action: "back" },
      });
      host.acceptResult("3", NAMED_OK);
      expect(await named).toEqual(NAMED_OK);
      expect(await settled(next)).toBe(false);

      host.acceptResult("1", { status: "failed", message: "withdrawn" });
      expect((await stream.next())?.data).toEqual({
        id: "2",
        operation: { action: "back" },
      });
      host.close();
      expect(await next).toEqual({
        status: "session-ended",
        message: "the job has ended",
      });
    });

    it("sends a session-list while a session owes an acknowledgment, and holds nothing back behind a withdrawn one", async () => {
      const host = new LocalJobBrowserHost();
      const stream = reader(host.attach());
      const abort = new AbortController();
      const unnamed = host.perform(
        { operation: { action: "handoff", reason: "sign-in" } },
        abort.signal,
      );
      const firstList = host.perform(
        { operation: { action: "session-list" } },
        abort.signal,
      );
      await stream.next();
      await stream.next();
      abort.abort(new Error("moved on"));
      await expect(unnamed).rejects.toThrow("moved on");
      await expect(firstList).rejects.toThrow("moved on");
      await stream.next();
      await stream.next();

      // The unnamed session owes an acknowledgment, and so does the first
      // list; neither holds back a list.
      const list = host.perform({ operation: { action: "session-list" } });
      const next = host.perform({ operation: { action: "reload" } });
      expect(await stream.next()).toEqual({
        event: "request",
        data: { id: "3", operation: { action: "session-list" } },
      });
      host.acceptResult("3", { status: "ok", sessions: [] });
      expect(await list).toEqual({ status: "ok", sessions: [] });
      expect(await settled(next)).toBe(false);

      host.acceptResult("2", { status: "failed", message: "withdrawn" });
      expect(await settled(next)).toBe(false);
      host.acceptResult("1", { status: "failed", message: "withdrawn" });
      expect((await stream.next())?.data.id).toBe("4");
      host.close();
    });

    it("returns invalid for a malformed request, and sends the host nothing", async () => {
      const host = new LocalJobBrowserHost();
      const stream = reader(host.attach());

      expect(
        await host.perform({ session: "a/b", operation: { action: "reload" } }),
      ).toEqual({
        status: "invalid",
        message:
          "a session name is 1 to 64 ASCII letters, digits, hyphens, and underscores",
      });
      expect(
        await host.perform({
          session: "a",
          operation: { action: "session-list" },
        }),
      ).toMatchObject({ status: "invalid" });
      host.perform({ operation: { action: "session-list" } });
      expect(await stream.next()).toEqual({
        event: "request",
        data: { id: "1", operation: { action: "session-list" } },
      });
      host.close();
    });

    it("checks each answer against the operation it answers", async () => {
      const host = new LocalJobBrowserHost();
      const stream = reader(host.attach());
      const listed = host.perform({ operation: { action: "session-list" } });
      const mismatched = host.perform({
        operation: { action: "session-list" },
      });
      await stream.next();
      await stream.next();
      const sessions = [
        {
          name: "bank",
          kind: "locked-down",
          site: "https://bank.example",
          away: false,
        },
      ];

      expect(host.acceptResult("1", { status: "ok", sessions })).toBe(
        "accepted",
      );
      expect(host.acceptResult("2", OK)).toBe("invalid");
      expect(await listed).toEqual({ status: "ok", sessions });
      expect(await mismatched).toEqual({
        status: "failed",
        message:
          "the browser host answered with something that is not a result",
      });
      await stream.cancel();
    });
  });
});
