/**
 * Unit coverage for the pattern-test fetch-mocking helpers (CT-1768): parsing a
 * test's `fetchMocks` export, resolving request URLs, matching entries, building
 * mock Responses, and the injected `fetch` wrapper.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fetchInputUrl,
  makeMockFetch,
  makeMockResponse,
  matchFetchMock,
  readFetchMocks,
} from "../lib/fetch-mock.ts";

describe("readFetchMocks", () => {
  it("returns valid entries from a module's fetchMocks export", () => {
    const entries = readFetchMocks({
      fetchMocks: [{ urlIncludes: "/a" }, { urlIncludes: "/b", status: 201 }],
    });
    expect(entries?.length).toBe(2);
    expect(entries?.[1].status).toBe(201);
  });

  it("returns undefined when fetchMocks is absent or not an array", () => {
    expect(readFetchMocks(undefined)).toBeUndefined();
    expect(readFetchMocks(null)).toBeUndefined();
    expect(readFetchMocks({})).toBeUndefined();
    expect(readFetchMocks({ fetchMocks: "nope" })).toBeUndefined();
  });

  it("filters out malformed entries, returning undefined if none remain", () => {
    expect(readFetchMocks({ fetchMocks: [{}, { urlIncludes: 5 }, null] }))
      .toBeUndefined();
    const mixed = readFetchMocks({
      fetchMocks: [{ urlIncludes: "/ok" }, { nope: true }],
    });
    expect(mixed?.length).toBe(1);
    expect(mixed?.[0].urlIncludes).toBe("/ok");
  });
});

describe("fetchInputUrl", () => {
  it("resolves strings, URLs, Requests, and {url} objects", () => {
    expect(fetchInputUrl("https://x.test/a")).toBe("https://x.test/a");
    expect(fetchInputUrl(new URL("https://x.test/b"))).toBe("https://x.test/b");
    expect(fetchInputUrl(new Request("https://x.test/c"))).toBe(
      "https://x.test/c",
    );
    expect(fetchInputUrl({ url: "https://x.test/d" })).toBe("https://x.test/d");
  });

  it("returns empty string for inputs with no usable URL", () => {
    expect(fetchInputUrl(42)).toBe("");
    expect(fetchInputUrl(null)).toBe("");
    expect(fetchInputUrl({})).toBe("");
  });
});

describe("matchFetchMock", () => {
  const entries = [{ urlIncludes: "/api/a" }, { urlIncludes: "/api/b" }];

  it("returns undefined when there are no entries", () => {
    expect(matchFetchMock(undefined, "https://x.test/api/a")).toBeUndefined();
  });

  it("matches the first entry whose urlIncludes is a substring", () => {
    expect(matchFetchMock(entries, "https://x.test/api/b?q=1")?.urlIncludes)
      .toBe("/api/b");
  });

  it("returns undefined when nothing matches", () => {
    expect(matchFetchMock(entries, "https://x.test/other")).toBeUndefined();
  });
});

describe("makeMockResponse", () => {
  it("defaults to 200 + application/json and a string body", async () => {
    const res = makeMockResponse({ urlIncludes: "/x", body: '{"ok":true}' });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("honors status and contentType, and empty body by default", async () => {
    const res = makeMockResponse({
      urlIncludes: "/x",
      status: 404,
      contentType: "text/plain",
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("");
  });

  it("decodes base64Body (taking precedence over body) to bytes", async () => {
    // base64("hi") === "aGk="
    const res = makeMockResponse({
      urlIncludes: "/x",
      base64Body: "aGk=",
      body: "ignored",
    });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([104, 105]),
    );
  });
});

describe("makeMockFetch", () => {
  it("returns a mocked Response for a matching request without calling realFetch", async () => {
    let realCalled = false;
    const realFetch = (() => {
      realCalled = true;
      return Promise.resolve(new Response("real"));
    }) as typeof globalThis.fetch;
    const fetch = makeMockFetch(
      () => [{ urlIncludes: "/mock", body: "mocked" }],
      realFetch,
    );
    const res = await fetch("https://x.test/mock");
    expect(await res.text()).toBe("mocked");
    expect(realCalled).toBe(false);
  });

  it("falls through to realFetch (with init) when nothing matches", async () => {
    let seen: { input: unknown; init: unknown } | undefined;
    const client = {} as Deno.HttpClient;
    const realFetch = ((input: unknown, init: unknown) => {
      seen = { input, init };
      return Promise.resolve(new Response("real"));
    }) as typeof globalThis.fetch;
    const fetch = makeMockFetch(() => [{ urlIncludes: "/mock" }], realFetch);
    const res = await fetch("https://x.test/other", {
      method: "POST",
      client,
    });
    expect(await res.text()).toBe("real");
    expect(seen?.input).toBe("https://x.test/other");
    expect((seen?.init as RequestInit).method).toBe("POST");
    expect(
      (seen?.init as RequestInit & { client?: Deno.HttpClient }).client,
    ).toBe(client);
  });

  it("reads entries late-bound on each call", async () => {
    // `const` holder mutated by property (not a reassigned `let`) so the closure
    // sees the later value without tripping deno-lint's prefer-const.
    const holder: { entries?: { urlIncludes: string; body?: string }[] } = {};
    const fetch = makeMockFetch(
      () => holder.entries,
      (() => Promise.resolve(new Response("real"))) as typeof globalThis.fetch,
    );
    expect(await (await fetch("https://x.test/late")).text()).toBe("real");
    holder.entries = [{ urlIncludes: "/late", body: "now-mocked" }];
    expect(await (await fetch("https://x.test/late")).text()).toBe(
      "now-mocked",
    );
  });

  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("waits for delayMs before returning", async () => {
    const fetch = makeMockFetch(
      () => [{ urlIncludes: "/slow", body: "slow", delayMs: 40 }],
      (() => Promise.resolve(new Response("real"))) as typeof globalThis.fetch,
    );
    let done = false;
    const p = fetch("https://x.test/slow").then((r) => (done = true, r));
    await tick(); // a 0ms timer fires before the 40ms delay
    expect(done).toBe(false);
    expect(await (await p).text()).toBe("slow");
  });

  const realStub =
    (() => Promise.resolve(new Response("real"))) as typeof globalThis.fetch;

  it("resolves a delayed response when the signal is present but not aborted", async () => {
    const ac = new AbortController();
    const fetch = makeMockFetch(
      () => [{ urlIncludes: "/slow", body: "ok", delayMs: 10 }],
      realStub,
    );
    const res = await fetch("https://x.test/slow", { signal: ac.signal });
    expect(await res.text()).toBe("ok");
  });

  it("rejects a delayed response if the signal aborts during the delay", async () => {
    const ac = new AbortController();
    const fetch = makeMockFetch(
      () => [{ urlIncludes: "/slow", body: "ok", delayMs: 1000 }],
      realStub,
    );
    const p = fetch("https://x.test/slow", { signal: ac.signal });
    ac.abort(new Error("cancelled"));
    let err: unknown;
    try {
      await p;
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toBe("cancelled");
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort(new Error("pre-aborted"));
    const fetch = makeMockFetch(
      () => [{ urlIncludes: "/x", body: "ok" }],
      realStub,
    );
    let err: unknown;
    try {
      await fetch("https://x.test/x", { signal: ac.signal });
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toBe("pre-aborted");
  });

  it("honors a Request input's own signal when init has none", async () => {
    const ac = new AbortController();
    const fetch = makeMockFetch(
      () => [{ urlIncludes: "/r", body: "ok", delayMs: 1000 }],
      realStub,
    );
    const p = fetch(new Request("https://x.test/r", { signal: ac.signal }));
    ac.abort(new Error("req-cancelled"));
    let err: unknown;
    try {
      await p;
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toBe("req-cancelled");
  });
});
