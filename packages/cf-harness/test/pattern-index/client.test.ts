import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  FIRST_PARTY_HTTP_AUTH_HEADERS,
  verifyFirstPartyHttpRequest,
} from "@commonfabric/runner/toolshed-http-auth";
import {
  createHarnessPatternIndexClientFactory,
  PatternIndexClient,
  PatternIndexError,
} from "../../src/pattern-index/client.ts";
import type { HarnessFetch } from "../../src/contracts/http-fetch.ts";

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
): { fetchFn: HarnessFetch; requests: RecordedRequest[] } => {
  const requests: RecordedRequest[] = [];
  let index = 0;
  const fetchFn: HarnessFetch = (input, init) => {
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
  it("constructs clients that sign as the identity read from the configured keyfile", async () => {
    const root = await Deno.makeTempDir();
    try {
      const key = await Identity.generatePkcs8();
      const identity = await Identity.fromPkcs8(key);
      const keyPath = `${root}/identity.key`;
      await Deno.writeFile(keyPath, key);
      const { fetchFn, requests } = recordingFetch([
        jsonResponse({ results: [] }),
      ]);
      const config = { baseUrl: "https://index.test/api" };
      const client = await createHarnessPatternIndexClientFactory(
        config,
        keyPath,
        fetchFn,
      )();
      await client.searchPatterns({ text: "reusable components" });
      const request = requests[0];
      const verified = await verifyFirstPartyHttpRequest({
        request: new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        }),
      });
      expect(verified.userDid).toBe(identity.did());
      expect(request.url).toBe("https://index.test/api/searchPatterns");
      const defaultTransportClient =
        await createHarnessPatternIndexClientFactory(
          config,
          keyPath,
        )();
      expect(defaultTransportClient.did).toBe(identity.did());
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

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

  it("answers searchPatterns with the index's results", async () => {
    const { client } = createClient([
      jsonResponse({
        results: [{
          patternId: "pat-1",
          description: "Totals an expense list",
          hashtags: ["expenses"],
          ownerDid: "did:key:zOwner",
          createdAt: "2026-08-01T00:00:00.000Z",
          dependencies: [],
          signals: { uses: 4, score: 0.75 },
        }],
      }),
      jsonResponse({ patterns: [], eventTypes: {} }),
    ]);
    const response = await client.searchPatterns({ tags: ["expenses"] });
    expect(response.results.length).toBe(1);
    expect(response.results[0].patternId).toBe("pat-1");
    expect(response.results[0].signals).toEqual({ uses: 4, score: 0.75 });
  });

  it("refreshes catalog membership while caching immutable lineage metadata", async () => {
    const metadata = (id: string, priorPatternId?: string) => ({
      patternId: id,
      ownerDid: signer.did(),
      createdAt: "2026-09-17T00:00:00Z",
      description: id,
      hashtags: ["donuts"],
      dependencies: [],
      ...(priorPatternId === undefined ? {} : { priorPatternId }),
    });
    const records = [metadata("old"), metadata("fresh", "old")];
    const requests: { fn: string; body: Record<string, unknown> }[] = [];
    let listed = records.slice(0, 1);
    const client = new PatternIndexClient({
      baseUrl: "https://index.test/api",
      signer,
      fetchFn: (input, init) => {
        const fn = new URL(String(input)).pathname.split("/").at(-1)!;
        const body = JSON.parse(String(init?.body));
        requests.push({ fn, body });
        const output = fn === "searchPatterns"
          ? { results: [{ ...records[0], quality: "proven", kind: "app" }] }
          : fn === "listPatterns"
          ? {
            patterns: listed.map((entry) => ({
              ...entry,
              events: { created: 1 },
              score: 0,
              quality: "unproven",
            })),
            eventTypes: {},
          }
          : records.find((entry) => entry.patternId === body.patternId);
        return Promise.resolve(jsonResponse(output));
      },
    });
    const first = await client.searchPatterns({ text: "donuts", limit: 1 });
    listed = records;
    const second = await client.searchPatterns({ text: "donuts", limit: 1 });
    const third = await client.searchPatterns({ text: "donuts", limit: 1 });
    expect(first.results.map((hit) => hit.patternId)).toEqual(["old"]);
    expect(second.results.map((hit) => hit.patternId)).toEqual(["fresh"]);
    expect(third).toEqual(second);
    expect(requests.filter((request) => request.fn === "listPatterns").length)
      .toBe(3);
    expect(
      requests.filter((request) => request.fn === "getPattern").map((request) =>
        request.body
      ),
    ).toEqual([
      { patternId: "old", includeSource: false },
      { patternId: "fresh", includeSource: false },
    ]);
    expect(
      (await client.getPattern({ patternId: "old", includeSource: true }))
        .patternId,
    ).toBe("old");
    expect(requests.at(-1)?.body).toEqual({
      patternId: "old",
      includeSource: true,
    });
  });

  it("does not cache failed or mismatched discovery metadata", async () => {
    for (
      const failure of [
        jsonResponse({ error: "unavailable" }, 503),
        jsonResponse({ patternId: "wrong" }),
      ]
    ) {
      const hit = {
        patternId: "old",
        ownerDid: signer.did(),
        quality: "unproven",
        kind: "app",
      };
      const search = () => jsonResponse({ results: [hit] });
      const catalog = () =>
        jsonResponse({ patterns: [{ patternId: "old" }], eventTypes: {} });
      const { client, requests } = createClient([
        search(),
        catalog(),
        failure,
        search(),
        catalog(),
        jsonResponse(hit),
      ]);
      await expect(client.searchPatterns({ text: "donuts" })).rejects.toThrow();
      expect((await client.searchPatterns({ text: "donuts" })).results).toEqual(
        [hit],
      );
      expect(
        requests.filter((request) => request.url.endsWith("/getPattern"))
          .length,
      ).toBe(2);
    }
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
});
