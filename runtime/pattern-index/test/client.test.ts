import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  FIRST_PARTY_HTTP_AUTH_HEADERS,
  verifyFirstPartyHttpRequest,
} from "@commonfabric/runner/toolshed-http-auth";
import {
  PatternIndexClient,
  PatternIndexError,
} from "@commonfabric/pattern-index/client";
import type { PatternIndexFetch } from "@commonfabric/pattern-index/http-fetch";

const signer = await Identity.fromPassphrase("cf-harness pattern-index client");

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/**
 * A fetch that records what it was asked for and answers with `responses` in
 * order. No network is involved, so what the client sends is observable
 * exactly as it composed it.
 */
const recordingFetch = (
  responses: readonly Response[],
): { fetchFn: PatternIndexFetch; requests: RecordedRequest[] } => {
  const requests: RecordedRequest[] = [];
  let index = 0;
  const fetchFn: PatternIndexFetch = (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    });
    const response = responses[index];
    index += 1;
    return Promise.resolve(response);
  };
  return { fetchFn, requests };
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const createClient = (
  responses: readonly Response[],
  baseUrl = "https://index.test/api",
) => {
  const { fetchFn, requests } = recordingFetch(responses);
  return {
    client: new PatternIndexClient({ baseUrl, fetchFn, signer }),
    requests,
  };
};

describe("PatternIndexClient", () => {
  it("refuses a base URL carrying a query or fragment", () => {
    for (
      const baseUrl of [
        "https://index.test/api?x=1",
        "https://index.test/api#frag",
      ]
    ) {
      expect(() =>
        new PatternIndexClient({
          baseUrl,
          fetchFn: () => Promise.resolve(jsonResponse({})),
          signer,
        })
      ).toThrow("query or fragment");
    }
  });

  it("joins functions onto the parsed base, so a bare trailing delimiter cannot survive", async () => {
    // "https://index.test/api?" parses to an empty search the guard cannot
    // see; appending to the raw string would address "…api?/searchPatterns".
    const { client, requests } = createClient(
      [jsonResponse({ results: [] })],
      "https://index.test/api?",
    );
    await client.searchPatterns({ tags: ["todo"] });
    expect(requests[0].url).toBe("https://index.test/api/searchPatterns");
  });

  it("posts a signed CF1 request to the named index function", async () => {
    const { client, requests } = createClient([
      jsonResponse({ results: [] }),
    ]);
    await client.searchPatterns({ tags: ["todo"] });
    expect(requests.length).toBe(1);
    const request = requests[0];
    expect(request.method).toBe("POST");
    expect(request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.userDid))
      .toBe(signer.did());
    expect(request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth)).toContain(
      "CF1",
    );
    expect(request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.proof))
      .toBeTruthy();
    expect(request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.bodySha256))
      .toBeTruthy();
    expect(request.headers.get("Content-Type")).toBe("application/json");
  });

  it("signs what it sends, as the index's own verifier reads it", async () => {
    const { client, requests } = createClient([jsonResponse({ results: [] })]);
    await client.searchPatterns({ tags: ["todo"], text: "expenses" });
    // Reconstructed from exactly what the fetch was handed, and verified with
    // the function the index runs on the receiving side: the proof commits to
    // the body hash, so a client that signed one set of bytes and sent
    // another fails here rather than at the deployment.
    const request = requests[0];
    const verified = await verifyFirstPartyHttpRequest({
      request: new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      }),
    });
    expect(verified.userDid).toBe(signer.did());
  });

  it("keeps every segment of a base URL served under a path prefix", async () => {
    const { client, requests } = createClient([jsonResponse({ results: [] })]);
    await client.searchPatterns({ text: "expenses" });
    expect(requests[0].url).toBe("https://index.test/api/searchPatterns");
  });

  it("sends only the search fields the caller supplied", async () => {
    const { client, requests } = createClient([jsonResponse({ results: [] })]);
    await client.searchPatterns({ text: "expenses", limit: 5 });
    expect(JSON.parse(requests[0].body)).toEqual({
      text: "expenses",
      limit: 5,
    });
  });

  it("answers searchPatterns with the index's rows, from one request", async () => {
    // The index substitutes successors itself, so a replacement row, its
    // display name, and the generation it supersedes arrive as sent.
    const row = {
      patternId: "fresh",
      name: "Expense Totaler",
      description: "Totals an expense list",
      hashtags: ["expenses"],
      ownerDid: "did:key:zOwner",
      createdAt: "2026-08-01T00:00:00.000Z",
      dependencies: [],
      signals: { uses: 4, score: 0.75 },
      quality: "proven",
      kind: "app",
      supersedes: "old",
    };
    const { client, requests } = createClient([
      jsonResponse({ results: [row], successorsResolved: true }),
    ]);

    const response = await client.searchPatterns({ tags: ["expenses"] });

    expect(response.results).toEqual([row]);
    expect(requests.map((request) => request.url)).toEqual([
      "https://index.test/api/searchPatterns",
    ]);
  });

  it("asks getPattern for source only when told to", async () => {
    const { client, requests } = createClient([
      jsonResponse({
        patternId: "pat-1",
        ownerDid: "did:key:zOwner",
        createdAt: "2026-08-01T00:00:00.000Z",
        description: "Totals an expense list",
        hashtags: ["expenses"],
        dependencies: [],
        program: {
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: "export default 1;" }],
        },
      }),
    ]);
    const pattern = await client.getPattern({
      patternId: "pat-1",
      includeSource: true,
    });
    expect(requests[0].url).toBe("https://index.test/api/getPattern");
    expect(JSON.parse(requests[0].body)).toEqual({
      patternId: "pat-1",
      includeSource: true,
    });
    expect(pattern.program?.files[0].contents).toBe("export default 1;");
  });

  it("asks getPattern for no source when the caller omits the flag", async () => {
    const { client, requests } = createClient([
      jsonResponse({
        patternId: "pat-1",
        ownerDid: "did:key:zOwner",
        createdAt: "2026-08-01T00:00:00.000Z",
        description: "Totals an expense list",
        hashtags: ["expenses"],
        dependencies: [],
      }),
    ]);
    const pattern = await client.getPattern({ patternId: "pat-1" });
    expect(JSON.parse(requests[0].body)).toEqual({ patternId: "pat-1" });
    expect(pattern.program).toBeUndefined();
  });

  it("posts listPatterns with no fields and answers with the scored listing", async () => {
    const { client, requests } = createClient([
      jsonResponse({
        patterns: [{
          patternId: "pat-1",
          description: "Totals an expense list",
          hashtags: ["expenses"],
          keywords: ["total"],
          ownerDid: "did:key:zOwner",
          createdAt: "2026-08-01T00:00:00.000Z",
          events: { run_succeeded: 3, thumbs_up: 1 },
          score: 5,
        }],
        eventTypes: { run_succeeded: 1, thumbs_up: 2 },
      }),
    ]);
    const listing = await client.listPatterns();
    expect(requests[0].url).toBe("https://index.test/api/listPatterns");
    expect(JSON.parse(requests[0].body)).toEqual({});
    expect(listing.patterns[0].events).toEqual({
      run_succeeded: 3,
      thumbs_up: 1,
    });
    expect(listing.eventTypes.thumbs_up).toBe(2);
  });

  it("carries a listing's absent creation time through as null", async () => {
    const { client } = createClient([
      jsonResponse({
        patterns: [{
          patternId: "pat-1",
          description: "Totals an expense list",
          hashtags: [],
          keywords: [],
          ownerDid: "did:key:zOwner",
          createdAt: null,
          events: {},
          score: 0,
        }],
        eventTypes: {},
      }),
    ]);
    expect((await client.listPatterns()).patterns[0].createdAt).toBeNull();
  });

  it("sends only the listEvents fields the caller supplied", async () => {
    const { client, requests } = createClient([
      jsonResponse({ events: [] }),
      jsonResponse({ events: [] }),
    ]);
    await client.listEvents();
    expect(requests[0].url).toBe("https://index.test/api/listEvents");
    expect(JSON.parse(requests[0].body)).toEqual({});

    await client.listEvents({ patternId: "pat-1", limit: 20 });
    expect(JSON.parse(requests[1].body)).toEqual({
      patternId: "pat-1",
      limit: 20,
    });
  });

  it("answers listEvents with the caller's own recorded events", async () => {
    const { client } = createClient([
      jsonResponse({
        events: [{
          patternId: "pat-1",
          did: "did:key:zOwner",
          eventType: "run_succeeded",
          ts: "2026-08-02T09:00:00.000Z",
          note: "ran in the harness",
        }],
      }),
    ]);
    const response = await client.listEvents({ limit: 1 });
    expect(response.events).toHaveLength(1);
    expect(response.events[0].eventType).toBe("run_succeeded");
    expect(response.events[0].note).toBe("ran in the harness");
  });

  it("posts an event with its type and optional note", async () => {
    const { client, requests } = createClient([jsonResponse({ ok: true })]);
    const response = await client.recordEvent({
      patternId: "pat-1",
      eventType: "run_succeeded",
      note: "ran in the harness",
    });
    expect(requests[0].url).toBe("https://index.test/api/recordEvent");
    expect(JSON.parse(requests[0].body)).toEqual({
      patternId: "pat-1",
      eventType: "run_succeeded",
      did: signer.did(),
      note: "ran in the harness",
    });
    expect(response.ok).toBe(true);
  });

  it("binds the event author to its signer despite a supplied DID", async () => {
    const { client, requests } = createClient([jsonResponse({ ok: true })]);
    const input = {
      patternId: "pat-1",
      eventType: "thumbs_up" as const,
      did: "did:key:zImpersonated",
    };
    await client.recordEvent(input);

    const request = requests[0];
    const verified = await verifyFirstPartyHttpRequest({
      request: new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      }),
    });
    expect(verified.userDid).toBe(signer.did());
    expect(JSON.parse(request.body)).toEqual({
      patternId: "pat-1",
      eventType: "thumbs_up",
      did: signer.did(),
    });
  });

  it("signs a retraction as its configured identity and sends only its declared fields", async () => {
    const request = {
      patternId: "A".repeat(43),
      successorPatternId: "B".repeat(43),
      reason: "Superseded by the corrected reader",
      ownerDid: "did:key:zOther",
      retractedBy: "did:key:zOther",
      admin: true,
    };
    const receipt = {
      patternId: request.patternId,
      status: "retracted",
      successorPatternId: request.successorPatternId,
      retractionReason: request.reason,
      retractedBy: signer.did(),
      retractedAt: "2026-09-21T00:00:00.000Z",
      discoverable: false,
      changed: true,
    };
    const { client, requests } = createClient([jsonResponse(receipt)]);

    expect(await client.retractPattern(request)).toEqual(receipt);
    expect(requests).toHaveLength(1);
    const sent = requests[0];
    expect(sent.url).toBe("https://index.test/api/retractPattern");
    expect(sent.method).toBe("POST");
    expect(JSON.parse(sent.body)).toEqual({
      patternId: request.patternId,
      successorPatternId: request.successorPatternId,
      reason: request.reason,
    });
    const verified = await verifyFirstPartyHttpRequest({
      request: new Request(sent.url, {
        method: sent.method,
        headers: sent.headers,
        body: sent.body,
      }),
    });
    expect(verified.userDid).toBe(signer.did());
  });

  it("posts a publication with its program and declared shapes", async () => {
    const { client, requests } = createClient([
      jsonResponse({ patternId: "pat-2", created: true }),
    ]);
    const response = await client.publishPattern({
      patternId: "pat-2",
      description: "Doubles a number",
      directQuery: "double a number",
      hashtags: ["math"],
      program: {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: "export default 1;" }],
      },
      resultSchema: { type: "object" },
      discoverable: true,
    });
    expect(requests[0].url).toBe("https://index.test/api/publishPattern");
    expect(JSON.parse(requests[0].body)).toEqual({
      patternId: "pat-2",
      program: {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: "export default 1;" }],
      },
      meta: {
        directQuery: "double a number",
        description: "Doubles a number",
        hashtags: ["math"],
      },
      schemas: { resultSchema: { type: "object" } },
      discoverable: true,
    });
    expect(response.patternId).toBe("pat-2");
    expect(response.created).toBe(true);
  });

  it("omits discoverability when a publication leaves it unspecified", async () => {
    const { client, requests } = createClient([
      jsonResponse({ patternId: "pat-2", created: true }),
    ]);
    await client.publishPattern({
      patternId: "pat-2",
      description: "Doubles a number",
      directQuery: "double a number",
      hashtags: ["math"],
      program: {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: "export default 1;" }],
      },
    });

    const body = JSON.parse(requests[0].body);
    expect(Object.hasOwn(body, "discoverable")).toBe(false);
    expect(Object.hasOwn(body, "discoverabilityReason")).toBe(false);
  });

  it("throws a typed error carrying the status and the index's message", async () => {
    const { client } = createClient([
      jsonResponse({ error: "unknown pattern" }, 404),
    ]);
    const error = await client.getPattern({ patternId: "missing" })
      .then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PatternIndexError);
    expect((error as PatternIndexError).status).toBe(404);
    expect((error as PatternIndexError).fn).toBe("getPattern");
    // The service body stays off `message` — error paths render `message`
    // toward the model, and a failure body can quote indexed source.
    expect((error as PatternIndexError).message).toBe(
      "pattern index getPattern failed (404)",
    );
    expect((error as PatternIndexError).detail).toContain("unknown pattern");
  });

  it("throws rather than answering when a 2xx body does not parse", async () => {
    const { client } = createClient([
      new Response("not json", { status: 200 }),
    ]);
    const error = await client.searchPatterns({ text: "x" })
      .then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PatternIndexError);
    expect((error as PatternIndexError).detail).toContain("not JSON");
  });
  it("asks for unvetted hits only when the caller does", async () => {
    const { client, requests } = createClient([
      jsonResponse({ results: [] }),
      jsonResponse({ results: [] }),
    ]);
    await client.searchPatterns({ text: "expenses", includeUnvetted: true });
    await client.searchPatterns({ text: "expenses" });
    expect(JSON.parse(requests[0].body)).toEqual({
      text: "expenses",
      includeUnvetted: true,
    });
    expect(JSON.parse(requests[1].body)).toEqual({ text: "expenses" });
  });

  it("sends only the listPatterns filters the caller supplied", async () => {
    const { client, requests } = createClient([
      jsonResponse({ patterns: [], eventTypes: {} }),
      jsonResponse({ patterns: [], eventTypes: {} }),
    ]);
    await client.listPatterns({ mine: true });
    await client.listPatterns({ featured: true });
    expect(JSON.parse(requests[0].body)).toEqual({ mine: true });
    expect(JSON.parse(requests[1].body)).toEqual({ featured: true });
  });

  it("publishes without task text, and credits a remix", async () => {
    const { client, requests } = createClient([
      jsonResponse({ patternId: "pat-3", created: true }),
    ]);
    await client.publishPattern({
      patternId: "pat-3",
      description: "Doubles a number",
      hashtags: ["math"],
      program: {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: "export default 2;" }],
      },
      priorPatternId: "pat-2",
      remixedFrom: "pat-other",
    });
    const body = JSON.parse(requests[0].body);
    expect(Object.hasOwn(body.meta, "directQuery")).toBe(false);
    expect(body.priorPatternId).toBe("pat-2");
    expect(body.remixedFrom).toBe("pat-other");
  });

  it("posts each listing, identity and curation call to its function with only its fields", async () => {
    const calls: Array<{
      fn: string;
      call: (client: PatternIndexClient) => Promise<unknown>;
      body: Record<string, unknown>;
    }> = [
      {
        fn: "recordUsageEvent",
        call: (c) =>
          c.recordUsageEvent({
            patternId: "pat-1",
            eventType: "viewed_in_loom",
          }),
        body: { patternId: "pat-1", eventType: "viewed_in_loom" },
      },
      {
        fn: "regarden",
        call: (c) => c.regarden({ patternId: "pat-1", gardener: "privacy" }),
        body: { patternId: "pat-1", gardener: "privacy" },
      },
      {
        fn: "requestListing",
        call: (c) => c.requestListing({ patternId: "pat-1" }),
        body: { patternId: "pat-1" },
      },
      {
        fn: "getGardenerPrompt",
        call: (c) => c.getGardenerPrompt({ name: "privacy" }),
        body: { name: "privacy" },
      },
      { fn: "createInvite", call: (c) => c.createInvite(), body: {} },
      {
        fn: "createInvite",
        call: (c) => c.createInvite({ ttlSeconds: 3600 }),
        body: { ttlSeconds: 3600 },
      },
      {
        fn: "redeemInvite",
        call: (c) => c.redeemInvite({ inviteId: "inv-1", code: "secret" }),
        body: { inviteId: "inv-1", code: "secret" },
      },
      {
        fn: "linkKey",
        call: (c) => c.linkKey({ delegation: "chain" }),
        body: { delegation: "chain" },
      },
      {
        fn: "admitKey",
        call: (c) => c.admitKey({ did: "did:key:z6Mk" }),
        body: { did: "did:key:z6Mk" },
      },
      { fn: "whoami", call: (c) => c.whoami(), body: {} },
      {
        fn: "setPatternFeatured",
        call: (c) =>
          c.setPatternFeatured({ patternId: "pat-1", featured: true }),
        body: { patternId: "pat-1", featured: true },
      },
      {
        fn: "setPatternFeatured",
        call: (c) =>
          c.setPatternFeatured({
            patternId: "pat-1",
            featured: true,
            rank: 2,
            note: "good",
          }),
        body: { patternId: "pat-1", featured: true, rank: 2, note: "good" },
      },
    ];
    for (const { fn, call, body } of calls) {
      const { client, requests } = createClient([jsonResponse({})]);
      await call(client);
      expect(requests[0].url).toBe(`https://index.test/api/${fn}`);
      expect(requests[0].method).toBe("POST");
      expect(JSON.parse(requests[0].body)).toEqual(body);
    }
  });
  it("carries a limit refusal's reset time, and none when the index gives none", async () => {
    const { client } = createClient([
      jsonResponse(
        { error: "daily cap reached", resetsAt: "2026-11-16T00:00:00Z" },
        429,
      ),
      jsonResponse({ error: "not found" }, 404),
    ]);
    const capped = await client.requestListing({ patternId: "pat-1" })
      .then(() => undefined, (thrown: unknown) => thrown);
    expect(capped).toBeInstanceOf(PatternIndexError);
    expect((capped as PatternIndexError).status).toBe(429);
    expect((capped as PatternIndexError).retryAt).toBe("2026-11-16T00:00:00Z");
    const missing = await client.requestListing({ patternId: "pat-2" })
      .then(() => undefined, (thrown: unknown) => thrown);
    expect((missing as PatternIndexError).retryAt).toBeUndefined();
  });
  it("keeps usage events out of the call a harness run reports through", async () => {
    const { client, requests } = createClient([jsonResponse({ ok: true })]);
    await client.recordEvent({
      patternId: "pat-1",
      // @ts-expect-error: a person's use is reported only through recordUsageEvent
      eventType: "viewed_in_loom",
    });
    expect(requests[0].url).toBe("https://index.test/api/recordEvent");
  });
});
