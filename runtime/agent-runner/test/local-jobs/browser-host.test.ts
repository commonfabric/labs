import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { BrowserHostResult } from "@commonfabric/cf-harness/contracts/browser-host";

import { LocalJobBrowserHost } from "../../src/local-jobs/browser-host.ts";

/** An answer the host gives. */
const OK: BrowserHostResult = {
  status: "ok",
  page: { url: "https://example.com/", title: "Example" },
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
    const opened = host.perform({ action: "open", url: "https://example.com" });
    const snapshot = host.perform({ action: "snapshot", interactive: true });
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
    const click = host.perform({ action: "click", ref: "@e3" }, abort.signal);
    expect((await stream.next())?.data.id).toBe("1");
    abort.abort(new Error("the run moved on"));
    await expect(click).rejects.toThrow("the run moved on");
    expect(await stream.next()).toEqual({
      event: "withdraw",
      data: { id: "1" },
    });
    expect(host.view().withdrawn).toBe(1);

    const next = host.perform({ action: "snapshot", interactive: true });
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
    const click = host.perform({ action: "click", ref: "@e3" }, abort.signal);
    await stream.next();
    abort.abort(new Error("moved on"));
    await expect(click).rejects.toThrow("moved on");
    await stream.next();
    const next = host.perform({ action: "back" });
    expect(host.acceptResult("1", { status: "not a result" })).toBe("accepted");
    expect((await stream.next())?.data.id).toBe("2");
    host.acceptResult("2", OK);
    expect(await next).toEqual(OK);
    await stream.cancel();
  });

  it("drops an operation the run withdraws before the host has it", async () => {
    const host = new LocalJobBrowserHost();
    const abort = new AbortController();
    const queued = host.perform({ action: "reload" }, abort.signal);
    abort.abort(new Error("gone"));
    await expect(queued).rejects.toThrow("gone");
    await expect(
      host.perform({ action: "back" }, abort.signal),
    ).rejects.toThrow("gone");
    const stream = reader(host.attach());
    host.perform({ action: "forward" });
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
      { action: "click", ref: "@e1" },
      abort.signal,
    );
    await first.next();
    abort.abort(new Error("moved on"));
    await expect(withdrawn).rejects.toThrow("moved on");
    await first.cancel();
    expect(host.view().state).toBe("open");

    // Sent while nobody is attached: it waits behind the acknowledgment.
    const waiting = host.perform({ action: "snapshot", interactive: true });
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
    const delivered = host.perform({ action: "open", url: "https://a.test" });
    await stream.next();
    host.close();
    host.close();
    expect(await delivered).toEqual({
      status: "session-ended",
      message: "the job has ended",
    });
    expect(await stream.next()).toEqual({ event: "close", data: {} });
    expect(await stream.next()).toBeUndefined();
    expect(await host.perform({ action: "back" })).toEqual({
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
    const queued = host.perform({ action: "snapshot", interactive: true });
    host.close();
    expect(await queued).toEqual({
      status: "session-ended",
      message: "the job has ended",
    });
  });

  it("reads a repeated answer as a duplicate, and refuses unknown ids and non-results", async () => {
    const host = new LocalJobBrowserHost();
    const stream = reader(host.attach());
    const first = host.perform({ action: "snapshot", interactive: true });
    const second = host.perform({ action: "get", kind: "title" });
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
    const pending = host.perform({ action: "snapshot", interactive: true });
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
});
