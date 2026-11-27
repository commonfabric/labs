import { expect } from "@std/expect";
import { describe, it } from "@commonfabric/test-support/test";

import { fetchWithin } from "../../src/executor/fetch-within.ts";
import type { RuntimeFetch } from "../../src/runtime.ts";

/**
 * A fetch that hands each request's signal to `seen` and never answers,
 * rejecting with the signal's reason once the signal aborts, as the platform
 * fetch does.
 */
const silentFetch = (seen: AbortSignal[]): RuntimeFetch => (_input, init) => {
  const signal = init!.signal!;
  seen.push(signal);
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason));
  });
};

describe("fetchWithin()", () => {
  it("returns the answer with its body already read, and aborts nothing", async () => {
    const seen: AbortSignal[] = [];
    const fetch = fetchWithin((_input, init) => {
      seen.push(init!.signal!);
      return Promise.resolve(
        new Response("source", {
          status: 201,
          statusText: "Made",
          headers: { "x-kind": "pattern" },
        }),
      );
    }, 1_000);

    const response = await fetch("https://patterns.example/main.tsx");

    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Made");
    expect(response.headers.get("x-kind")).toBe("pattern");
    expect(await response.text()).toBe("source");
    expect(seen.map((signal) => signal.aborted)).toEqual([false]);
  });

  it("rejects, and aborts the request, once the answer has taken `deadlineMs`", async () => {
    const seen: AbortSignal[] = [];
    const fetch = fetchWithin(silentFetch(seen), 250);

    const error = await fetch("https://patterns.example/main.tsx").then(
      () => undefined,
      (error: Error) => error,
    );

    expect(error?.message).toContain("went 250ms without an answer");
    expect(seen.map((signal) => signal.reason)).toEqual([error]);
  });

  it("aborts the request at once with the reason of a caller's signal that has already aborted", async () => {
    const seen: AbortSignal[] = [];
    const fetch = fetchWithin(silentFetch(seen), 60_000);
    const reason = new Error("the caller gave up first");

    await expect(
      fetch("https://patterns.example/main.tsx", {
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
    expect(seen.map((signal) => signal.reason)).toEqual([reason]);
  });

  it("aborts the request with the reason of a caller's signal when that signal aborts", async () => {
    const seen: AbortSignal[] = [];
    const fetch = fetchWithin(silentFetch(seen), 60_000);
    const caller = new AbortController();
    const answer = fetch("https://patterns.example/main.tsx", {
      signal: caller.signal,
    });
    answer.catch(() => {});
    expect(seen.map((signal) => signal.aborted)).toEqual([false]);

    const reason = new Error("the caller gave up");
    caller.abort(reason);

    await expect(answer).rejects.toBe(reason);
    expect(seen.map((signal) => signal.reason)).toEqual([reason]);
  });

  it("leaves the request alone when a caller's signal aborts after the answer", async () => {
    const seen: AbortSignal[] = [];
    const fetch = fetchWithin((_input, init) => {
      seen.push(init!.signal!);
      return Promise.resolve(new Response("source"));
    }, 60_000);
    const caller = new AbortController();

    const response = await fetch("https://patterns.example/main.tsx", {
      signal: caller.signal,
    });
    caller.abort(new Error("the caller gave up late"));

    expect(await response.text()).toBe("source");
    expect(seen.map((signal) => signal.aborted)).toEqual([false]);
  });
});
