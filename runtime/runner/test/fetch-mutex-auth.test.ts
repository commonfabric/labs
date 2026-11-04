import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { setPatternEnvironment } from "../src/env.ts";
import {
  FIRST_PARTY_HTTP_AUTH_HEADERS,
  verifyFirstPartyHttpRequest,
} from "../src/toolshed-http-auth.ts";

const signer = await Identity.fromPassphrase("test fetch mutex");
const space = signer.did();

describe("fetch-json mutex mechanism: protected request auth", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let byRef: ReturnType<typeof createBuilder>["commonfabric"]["byRef"];
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    pattern = commonfabric.pattern;
    byRef = commonfabric.byRef;

    // Set up pattern environment with a mock base URL
    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local"),
    });

    // Mock fetch
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;

      fetchCalls.push({ url, init });

      return Promise.resolve(
        new Response(
          JSON.stringify({ mocked: true, url }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("adds custom auth headers to protected toolshed fetchJson requests", async () => {
    const fetchJson = byRef("fetchJson");
    const testRecipe = pattern<{ query: string }>(
      ({ query }) =>
        fetchJson({
          url: "/api/agent-tools/web-search",
          options: {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: { query },
          },
        }),
    );

    const resultCell = runtime.getCell(
      space,
      "signed-toolshed-fetch",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      testRecipe,
      { query: "signed request" },
      resultCell,
    );
    tx.commit();

    await result.pull();
    await runtime.settled();

    const call = fetchCalls.find((call) =>
      call.url === "http://mock-test-server.local/api/agent-tools/web-search"
    );
    expect(call).toBeDefined();

    const headers = new Headers(call!.init?.headers);
    expect(
      headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.proof),
    ).toBeTruthy();
    expect(
      headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth),
    ).toBeTruthy();
    expect(
      headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.bodySha256),
    ).toBeTruthy();
    expect(headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.userDid)).toBe(
      signer.did(),
    );
    expect(headers.get("Signature")).toBe(null);
    expect(headers.get("Signature-Input")).toBe(null);
    expect(headers.get("Content-Digest")).toBe(null);

    const verified = await verifyFirstPartyHttpRequest({
      request: new Request(call!.url, {
        method: call!.init?.method,
        headers,
        body: call!.init?.body as BodyInit,
      }),
    });
    expect(verified.userDid).toBe(signer.did());
  });

  it("replaces caller-supplied auth headers on protected fetchJson requests", async () => {
    const fetchJson = byRef("fetchJson");
    const testRecipe = pattern<{ query: string }>(
      ({ query }) =>
        fetchJson({
          url: "/api/agent-tools/web-search",
          options: {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              [FIRST_PARTY_HTTP_AUTH_HEADERS.proof]: "bogus",
              [FIRST_PARTY_HTTP_AUTH_HEADERS.auth]: "bogus",
              [FIRST_PARTY_HTTP_AUTH_HEADERS.bodySha256]: "bogus",
              [FIRST_PARTY_HTTP_AUTH_HEADERS.userDid]: "did:key:bogus",
              "Signature": "bogus",
              "Signature-Input": "bogus",
              "Content-Digest": "bogus",
            },
            body: { query },
          },
        }),
    );

    const resultCell = runtime.getCell(
      space,
      "replace-auth-headers",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      testRecipe,
      { query: "replace request" },
      resultCell,
    );
    tx.commit();

    await result.pull();
    await runtime.settled();

    const call = fetchCalls.find((call) =>
      call.url === "http://mock-test-server.local/api/agent-tools/web-search"
    );
    expect(call).toBeDefined();

    const headers = new Headers(call!.init?.headers);
    expect(headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.proof)).not.toBe(
      "bogus",
    );
    expect(
      headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth),
    ).not.toBe("bogus");
    expect(
      headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.bodySha256),
    ).not.toBe("bogus");
    expect(headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.userDid)).toBe(
      signer.did(),
    );
    expect(headers.get("Signature")).toBe(null);
    expect(headers.get("Signature-Input")).toBe(null);
    expect(headers.get("Content-Digest")).toBe(null);

    const verified = await verifyFirstPartyHttpRequest({
      request: new Request(call!.url, {
        method: call!.init?.method,
        headers,
        body: call!.init?.body as BodyInit,
      }),
    });
    expect(verified.userDid).toBe(signer.did());
  });

  it("does not add auth headers to protected-looking external requests", async () => {
    const fetchJson = byRef("fetchJson");
    const testRecipe = pattern<{ query: string }>(
      ({ query }) =>
        fetchJson({
          url: "http://external.test/api/agent-tools/web-search",
          options: {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: { query },
          },
        }),
    );

    const resultCell = runtime.getCell(
      space,
      "external-toolshed-looking-fetch",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      testRecipe,
      { query: "external request" },
      resultCell,
    );
    tx.commit();

    await result.pull();
    await runtime.settled();

    const call = fetchCalls.find((call) =>
      call.url === "http://external.test/api/agent-tools/web-search"
    );
    expect(call).toBeDefined();

    const headers = new Headers(call!.init?.headers);
    expect(headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.proof)).toBe(
      null,
    );
    expect(headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth)).toBe(
      null,
    );
    expect(headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.userDid)).toBe(null);
  });
});
