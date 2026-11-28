import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  FIRST_PARTY_HTTP_AUTH_HEADERS,
  verifyFirstPartyHttpRequest,
} from "@commonfabric/runner/toolshed-http-auth";
import {
  deployedPieceRef,
  PatternIndexClient,
  PatternIndexError,
} from "@commonfabric/pattern-index/client";
import type { PatternIndexFetch } from "@commonfabric/pattern-index/http-fetch";
import { MAX_PROOF_CHAIN_LENGTH } from "@commonfabric/memory/v2/session-open-auth";
import { describe, it } from "@commonfabric/test-support/test";

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

  it("asks getPattern by a pattern link with the ref alone, and answers what it names", async () => {
    const link = {
      ref: "a-xyz@beta",
      channel: "beta",
      number: 3,
      stable: false,
    };
    const { client, requests } = createClient([
      jsonResponse({
        patternId: "pat-3",
        createdAt: "2026-08-01T00:00:00.000Z",
        description: "Totals an expense list",
        hashtags: [],
        dependencies: [],
        link,
      }),
    ]);
    const pattern = await client.getPattern({ ref: "a-xyz@beta" });
    expect(JSON.parse(requests[0].body)).toEqual({ ref: "a-xyz@beta" });
    expect(pattern.link).toEqual(link);
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

  it("requests a publication withheld from search with the reason it gives", async () => {
    const { client, requests } = createClient([
      jsonResponse({ patternId: "pat-3", created: true }),
    ]);
    await client.publishPattern({
      patternId: "pat-3",
      description: "Doubles a number",
      directQuery: "double a number",
      hashtags: ["math"],
      program: {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: "export default 1;" }],
      },
      discoverable: true,
      nonDiscoverable: { reason: "render-gate-failed" },
    });

    const body = JSON.parse(requests[0].body);
    expect(body.discoverable).toBe(false);
    expect(body.discoverabilityReason).toBe("render-gate-failed");
  });

  it("reads the index's health with an unsigned GET", async () => {
    const { client, requests } = createClient([jsonResponse({ ok: true })]);

    expect(await client.health()).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://index.test/api/health");
    expect(requests[0].method).toBe("GET");
    for (const header of Object.values(FIRST_PARTY_HTTP_AUTH_HEADERS)) {
      expect(requests[0].headers.has(header)).toBe(false);
    }
  });

  it("reads enrollment for the DID it signs as", async () => {
    const { client, requests } = createClient([
      jsonResponse({ enrolled: true }),
    ]);

    expect(await client.enrollmentStatus()).toEqual({ enrolled: true });
    const url = new URL(requests[0].url);
    expect(url.origin + url.pathname).toBe(
      "https://index.test/api/enrollmentStatus",
    );
    expect(url.searchParams.get("did")).toBe(signer.did());
    expect(requests[0].method).toBe("GET");
  });

  it("throws a typed error when health or enrollment is refused", async () => {
    const { client } = createClient([
      jsonResponse({ error: "down" }, 503),
      jsonResponse({ error: "down" }, 503),
    ]);

    await expect(client.health()).rejects.toThrow(
      "pattern index health failed (503)",
    );
    await expect(client.enrollmentStatus()).rejects.toThrow(
      "pattern index enrollmentStatus failed (503)",
    );
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
    expect(error).toMatchObject({
      fn: "searchPatterns",
      status: 200,
      message:
        "pattern index searchPatterns answer is malformed: it is not JSON",
    });
  });

  it("refuses a getPattern answer whose program lacks what a program holds, naming what and quoting nothing", async () => {
    const files = [{ name: "/main.tsx", contents: "SOURCE_MARKER" }];
    const malformed: [unknown, string][] = [
      ["SOURCE_MARKER", "program is not an object"],
      [null, "program is not an object"],
      [{ files }, "program.main is not a string"],
      [
        { main: "/main.tsx", mainExport: 1, files },
        "program.mainExport is not a string",
      ],
      [{ main: "/main.tsx" }, "program.files is not an array"],
      [
        { main: "/main.tsx", files: [...files, { name: "/b.tsx" }] },
        "program.files[1].contents is not a string",
      ],
      [
        { main: "/main.tsx", files: [{ contents: "SOURCE_MARKER" }] },
        "program.files[0].name is not a string",
      ],
      [
        { main: "/main.tsx", files, sourceRoots: "/" },
        "program.sourceRoots is not an array of strings",
      ],
      [
        { main: "/main.tsx", files, dataFiles: [7] },
        "program.dataFiles is not an array of strings",
      ],
    ];
    const { client } = createClient(
      malformed.map(([program]) =>
        jsonResponse({ patternId: "pat-1", program })
      ),
    );
    for (const [, problem] of malformed) {
      const error = await client.getPattern({
        patternId: "pat-1",
        includeSource: true,
      }).then(() => undefined, (thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(PatternIndexError);
      expect(error).toMatchObject({
        fn: "getPattern",
        status: 200,
        message: `pattern index getPattern answer is malformed: ${problem}`,
      });
      expect(error).not.toHaveProperty("detail");
    }
  });

  it("answers a getPattern program carrying every optional field it may", async () => {
    const program = {
      main: "/main.tsx",
      mainExport: "pattern",
      files: [{ name: "/main.tsx", contents: "export default 1;" }],
      sourceRoots: ["/"],
      dataFiles: ["/data.json"],
    };
    const { client } = createClient([
      jsonResponse({ patternId: "pat-1", program }),
    ]);
    const pattern = await client.getPattern({
      patternId: "pat-1",
      includeSource: true,
    });
    expect(pattern.program).toEqual(program);
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

  it("asks for standalone patterns only when the caller does", async () => {
    const { client, requests } = createClient([
      jsonResponse({ results: [] }),
      jsonResponse({ results: [] }),
      jsonResponse({ results: [] }),
    ]);
    await client.searchPatterns({ text: "notes", standalone: true });
    await client.searchPatterns({ text: "notes", standalone: false });
    await client.searchPatterns({ text: "notes" });
    expect(JSON.parse(requests[0].body)).toEqual({
      text: "notes",
      standalone: true,
    });
    expect(JSON.parse(requests[1].body)).toEqual({
      text: "notes",
      standalone: false,
    });
    expect(JSON.parse(requests[2].body)).toEqual({ text: "notes" });
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

  it("sends `standalone` as stated, and omits it when unstated", async () => {
    const { client, requests } = createClient([
      jsonResponse({ patternId: "pat-6", created: true }),
      jsonResponse({ patternId: "pat-7", created: true }),
      jsonResponse({ patternId: "pat-8", created: true }),
    ]);
    const request = {
      patternId: "pat-6",
      description: "Doubles a number",
      hashtags: [],
      program: {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: "export default 2;" }],
      },
    };
    await client.publishPattern({ ...request, standalone: false });
    await client.publishPattern({ ...request, standalone: true });
    await client.publishPattern(request);
    const bodies = requests.map((sent) => JSON.parse(sent.body));
    expect(bodies[0].standalone).toBe(false);
    expect(bodies[1].standalone).toBe(true);
    expect(Object.hasOwn(bodies[2], "standalone")).toBe(false);
  });

  it("sends a version's lineage, slot, origin and privacy, and omits each when unset", async () => {
    const { client, requests } = createClient([
      jsonResponse({
        patternId: "pat-4",
        created: true,
        versionId: "ver-4",
        lineageId: "lin-1",
        seq: 4,
        visibility: "private",
        share: "none",
        autoShare: "kept_private",
      }),
      jsonResponse({ patternId: "pat-5", created: true }),
    ]);
    const program = {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: "export default 2;" }],
    };
    const response = await client.publishPattern({
      patternId: "pat-4",
      description: "Doubles a number",
      hashtags: [],
      program,
      lineageId: "lin-1",
      slot: "file:/work/main.tsx",
      origin: "self",
      keepPrivate: true,
    });
    expect(response.versionId).toBe("ver-4");
    expect(response.autoShare).toBe("kept_private");
    const body = JSON.parse(requests[0].body);
    expect([body.lineageId, body.slot, body.origin, body.keepPrivate])
      .toEqual(["lin-1", "file:/work/main.tsx", "self", true]);

    await client.publishPattern({
      patternId: "pat-5",
      description: "Doubles a number",
      hashtags: [],
      program,
      keepPrivate: false,
    });
    const bare = JSON.parse(requests[1].body);
    for (const field of ["lineageId", "slot", "origin", "keepPrivate"]) {
      expect(Object.hasOwn(bare, field)).toBe(false);
    }
  });

  it("sends the piece a version was deployed to, and an event about a piece in place of a pattern id", async () => {
    const { client, requests } = createClient([
      jsonResponse({ patternId: "pat-6", created: true }),
      jsonResponse({ ok: true, recorded: true }),
    ]);
    const deployedTo = deployedPieceRef("did:key:z6Mkspace", "of:fid1:p");
    await client.publishPattern({
      patternId: "pat-6",
      description: "Doubles a number",
      hashtags: [],
      program: {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: "export default 2;" }],
      },
      deployedTo,
    });
    await client.recordUsageEvent({
      piece: deployedTo,
      eventType: "viewed_in_loom",
    });

    expect(deployedTo).toBe(
      deployedPieceRef("did:key:z6Mkspace", "fid1:p"),
    );
    expect(deployedTo).toMatch(/^piece:[0-9a-f]{64}$/);
    expect(JSON.parse(requests[0].body).deployedTo).toBe(deployedTo);
    const event = JSON.parse(requests[1].body);
    expect(requests[1].url).toBe("https://index.test/api/recordEvent");
    expect(event.piece).toBe(deployedTo);
    expect(Object.hasOwn(event, "patternId")).toBe(false);
  });

  it("refuses to send a raw piece id where a hashed piece reference belongs", async () => {
    const { client, requests } = createClient([]);

    await expect(client.recordUsageEvent({
      piece: "fid1:raw",
      eventType: "viewed_in_loom",
    })).rejects.toThrow("piece reference");
    await expect(client.publishPattern({
      patternId: "pat-7",
      description: "Doubles a number",
      hashtags: [],
      program: { main: "/main.tsx", files: [] },
      deployedTo: "fid1:raw",
    })).rejects.toThrow("piece reference");
    expect(requests).toEqual([]);
  });

  it("posts each version, visibility and sharing-setting call to its function with only its fields", async () => {
    const calls: Array<{
      fn: string;
      call: (client: PatternIndexClient) => Promise<unknown>;
      body: Record<string, unknown>;
    }> = [
      { fn: "listLineages", call: (c) => c.listLineages(), body: {} },
      {
        fn: "listVersions",
        call: (c) => c.listVersions({ lineageId: "lin-1" }),
        body: { lineageId: "lin-1" },
      },
      {
        fn: "getVersion",
        call: (c) => c.getVersion({ versionId: "ver-1", includeSource: true }),
        body: { versionId: "ver-1", includeSource: true },
      },
      {
        fn: "rollback",
        call: (c) => c.rollback({ lineageId: "lin-1", toVersionId: "ver-1" }),
        body: { lineageId: "lin-1", toVersionId: "ver-1" },
      },
      {
        fn: "shareVersion",
        call: (c) => c.shareVersion({ versionId: "ver-1" }),
        body: { versionId: "ver-1" },
      },
      {
        fn: "shareVersion",
        call: (c) => c.shareVersion({ versionId: "ver-1", channel: "beta" }),
        body: { versionId: "ver-1", channel: "beta" },
      },
      {
        fn: "publishLineage",
        call: (c) =>
          c.publishLineage({
            lineageId: "lin-1",
            profile: { space: "did:key:z6Mkprofile" },
            displayName: "Sam",
            profileProof: ["root", "link"],
          }),
        body: {
          lineageId: "lin-1",
          profile: { space: "did:key:z6Mkprofile" },
          displayName: "Sam",
          profileProof: ["root", "link"],
        },
      },
      {
        fn: "deleteVersion",
        call: (c) => c.deleteVersion({ versionId: "ver-1" }),
        body: { versionId: "ver-1" },
      },
      {
        fn: "deleteLineage",
        call: (c) => c.deleteLineage({ lineageId: "lin-1" }),
        body: { lineageId: "lin-1" },
      },
      {
        fn: "unshareLineage",
        call: (c) => c.unshareLineage({ lineageId: "lin-1" }),
        body: { lineageId: "lin-1" },
      },
      {
        fn: "unpublishLineage",
        call: (c) => c.unpublishLineage({ lineageId: "lin-1" }),
        body: { lineageId: "lin-1" },
      },
      {
        fn: "getSharingSettings",
        call: (c) => c.getSharingSettings(),
        body: {},
      },
      {
        fn: "setSharingSettings",
        call: (c) => c.setSharingSettings({ selfBuilt: false }),
        body: { selfBuilt: false },
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

  it("posts each listing, identity and curation call to its function with only its fields", async () => {
    const calls: Array<{
      fn: string;
      call: (client: PatternIndexClient) => Promise<unknown>;
      body: Record<string, unknown>;
    }> = [
      {
        fn: "recordEvent",
        call: (c) =>
          c.recordUsageEvent({
            patternId: "pat-1",
            eventType: "viewed_in_loom",
          }),
        body: {
          patternId: "pat-1",
          eventType: "viewed_in_loom",
          did: signer.did(),
        },
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
        fn: "moveRoot",
        call: (c) => c.moveRoot({ rootDelegation: "deleg" }),
        body: { rootDelegation: "deleg" },
      },
      {
        fn: "moveMemberRoot",
        call: (c) =>
          c.moveMemberRoot({ handle: "quiet-fox", did: "did:key:z6Mk" }),
        body: { handle: "quiet-fox", did: "did:key:z6Mk" },
      },
      {
        fn: "revoke",
        call: (c) => c.revoke({ delegation: "deleg" }),
        body: { delegation: "deleg" },
      },
      {
        fn: "revoke",
        call: (c) => c.revoke({ legacyKey: "did:key:z6Mk" }),
        body: { legacyKey: "did:key:z6Mk" },
      },
      {
        fn: "admitKey",
        call: (c) => c.admitKey({ did: "did:key:z6Mk" }),
        body: { did: "did:key:z6Mk" },
      },
      { fn: "whoami", call: (c) => c.whoami(), body: {} },
      {
        fn: "setPatternHidden",
        call: (c) =>
          c.setPatternHidden({
            patternId: "pat-1",
            hidden: true,
            reason: "spam",
          }),
        body: { patternId: "pat-1", hidden: true, reason: "spam" },
      },
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
  it("sends its delegation chain inside every signed call, and none when it has none", async () => {
    const { fetchFn, requests } = recordingFetch([
      jsonResponse({ handle: "quiet-fox", role: "user" }),
      jsonResponse({ results: [] }),
    ]);
    const chained = new PatternIndexClient({
      baseUrl: "https://index.test/api",
      fetchFn,
      signer,
      proofs: ["root-link", "device-link"],
    });
    await chained.whoami();
    await chained.searchPatterns({ text: "expenses" });
    expect(JSON.parse(requests[0].body)).toEqual({
      proofs: ["root-link", "device-link"],
    });
    expect(JSON.parse(requests[1].body)).toEqual({
      text: "expenses",
      proofs: ["root-link", "device-link"],
    });
    // The chain rides inside the signed bytes, so the signature still holds.
    const verified = await verifyFirstPartyHttpRequest({
      request: new Request(requests[0].url, {
        method: requests[0].method,
        headers: requests[0].headers,
        body: requests[0].body,
      }),
    });
    expect(verified.userDid).toBe(signer.did());

    const { client, requests: plain } = createClient([
      jsonResponse({ handle: "quiet-fox", role: "user" }),
    ]);
    await client.whoami();
    expect(Object.hasOwn(JSON.parse(plain[0].body), "proofs")).toBe(false);
  });
  it("sends its GitHub OIDC token inside every signed call", async () => {
    const { fetchFn, requests } = recordingFetch([
      jsonResponse({ heads: [] }),
    ]);
    const client = new PatternIndexClient({
      baseUrl: "https://index.test/api",
      fetchFn,
      signer,
      githubOidc: () => Promise.resolve("jwt"),
    });
    await client.listRepoHeads({ repository: "acme/patterns" });
    expect(requests[0].url).toBe("https://index.test/api/listRepoHeads");
    expect(JSON.parse(requests[0].body)).toEqual({
      repository: "acme/patterns",
      githubOidc: "jwt",
    });
    const verified = await verifyFirstPartyHttpRequest({
      request: new Request(requests[0].url, {
        method: requests[0].method,
        headers: requests[0].headers,
        body: requests[0].body,
      }),
    });
    expect(verified.userDid).toBe(signer.did());
  });
  it("mints a GitHub OIDC token for each call", async () => {
    const { fetchFn, requests } = recordingFetch([
      jsonResponse({ heads: [] }),
      jsonResponse({ heads: [] }),
    ]);
    let minted = 0;
    const client = new PatternIndexClient({
      baseUrl: "https://index.test/api",
      fetchFn,
      signer,
      githubOidc: () => Promise.resolve(`jwt-${++minted}`),
    });
    await client.listRepoHeads({ repository: "acme/patterns" });
    await client.listRepoHeads({ repository: "acme/patterns" });
    expect(requests.map((request) => JSON.parse(request.body).githubOidc))
      .toEqual(["jwt-1", "jwt-2"]);
  });
  it("posts the paths to withdraw, and throws when the answer lists none", async () => {
    const { client, requests } = createClient([
      jsonResponse({ withdrawn: [{ path: "p/a.tsx", withdrawn: true }] }),
      jsonResponse({}),
    ]);
    const answer = await client.withdrawRepoPaths({
      repository: "acme/patterns",
      paths: ["p/a.tsx"],
    });
    expect(answer.withdrawn).toEqual([{ path: "p/a.tsx", withdrawn: true }]);
    expect(requests[0].url).toBe("https://index.test/api/withdrawRepoPaths");
    expect(JSON.parse(requests[0].body)).toEqual({
      repository: "acme/patterns",
      paths: ["p/a.tsx"],
    });
    await expect(
      client.withdrawRepoPaths({ repository: "acme/patterns", paths: [] }),
    ).rejects.toThrow("withdrawn is not an array");
  });
  it("throws when `listRepoHeads` returns no list of heads", async () => {
    const { client } = createClient([jsonResponse({ heads: "none" })]);
    await expect(client.listRepoHeads({ repository: "acme/patterns" }))
      .rejects.toThrow("heads is not an array");
  });
  it("sends a publish's repository source as it is given", async () => {
    const { client, requests } = createClient([
      jsonResponse({ patternId: "pat-1", created: true }),
    ]);
    const source = {
      repository: "acme/patterns",
      path: "patterns/a/main.tsx",
      commit: "c0ffee",
      sourceHash: "abc",
    };
    await client.publishPattern({
      patternId: "pat-1",
      description: "Doubles",
      hashtags: [],
      program: { main: "/a.tsx", files: [{ name: "/a.tsx", contents: "" }] },
      source,
    });
    expect(JSON.parse(requests[0].body).source).toEqual(source);
  });
  it("throws, sending nothing, for a publish with a repository source and a predecessor", async () => {
    const { client, requests } = createClient([]);
    await expect(client.publishPattern({
      patternId: "pat-1",
      description: "Doubles",
      hashtags: [],
      program: { main: "/a.tsx", files: [{ name: "/a.tsx", contents: "" }] },
      source: {
        repository: "acme/patterns",
        path: "patterns/a/main.tsx",
        commit: "c0ffee",
        sourceHash: "abc",
      },
      priorPatternId: "pat-0",
    })).rejects.toThrow("names no predecessor");
    expect(requests).toEqual([]);
  });
  it("snapshots its chain, and refuses one longer than the index accepts", async () => {
    const { fetchFn, requests } = recordingFetch([
      jsonResponse({ handle: "quiet-fox", role: "user" }),
    ]);
    const proofs = ["root-link"];
    const client = new PatternIndexClient({
      baseUrl: "https://index.test/api",
      fetchFn,
      signer,
      proofs,
    });
    proofs.push("added-later");
    await client.whoami();
    expect(JSON.parse(requests[0].body)).toEqual({ proofs: ["root-link"] });

    const links = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);
    expect(() =>
      new PatternIndexClient({
        baseUrl: "https://index.test/api",
        fetchFn,
        signer,
        proofs: links(MAX_PROOF_CHAIN_LENGTH),
      })
    ).not.toThrow();
    expect(() =>
      new PatternIndexClient({
        baseUrl: "https://index.test/api",
        fetchFn,
        signer,
        proofs: links(MAX_PROOF_CHAIN_LENGTH + 1),
      })
    ).toThrow(`longer than ${MAX_PROOF_CHAIN_LENGTH} links`);
  });
  it("needs a reason to hide, and none to show again", () => {
    const { client } = createClient([]);
    const typesOnly = () => {
      // @ts-expect-error: hiding without a reason is refused by the index
      client.setPatternHidden({ patternId: "pat-1", hidden: true });
      client.setPatternHidden({ patternId: "pat-1", hidden: false });
    };
    expect(typeof typesOnly).toBe("function");
  });
});
