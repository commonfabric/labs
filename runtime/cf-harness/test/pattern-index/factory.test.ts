import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { verifyFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import { PatternIndexStore } from "@commonfabric/pattern-index/store";
import { createHarnessPatternIndexClientFactory } from "../../src/pattern-index/factory.ts";

import type { HarnessFetch } from "../../src/contracts/http-fetch.ts";

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

describe("createHarnessPatternIndexClientFactory()", () => {
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
      const store = new PatternIndexStore(`${root}/store`);
      const client = await createHarnessPatternIndexClientFactory(
        config,
        keyPath,
        fetchFn,
        store,
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
          undefined,
          store,
        )();
      expect(defaultTransportClient.did).toBe(identity.did());
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("presents the chain this machine keeps for the key, so it acts for its member", async () => {
    const root = await Deno.makeTempDir();
    try {
      const key = await Identity.generatePkcs8();
      const keyPath = `${root}/identity.key`;
      await Deno.writeFile(keyPath, key);
      const store = new PatternIndexStore(`${root}/store`);
      const member = await store.createRootKey();
      await store.recordMembership({
        handle: "p-1",
        role: "user",
        root: member.did(),
      });
      const { fetchFn, requests } = recordingFetch([
        jsonResponse({ results: [] }),
      ]);
      const client = await createHarnessPatternIndexClientFactory(
        { baseUrl: "https://index.test/api" },
        keyPath,
        fetchFn,
        store,
      )();
      await client.searchPatterns({ text: "reusable components" });
      const proofs = JSON.parse(requests[0].body).proofs;
      expect(Array.isArray(proofs) && proofs.length > 0).toBe(true);
      // the chain was issued by the member's root to this key, and kept
      const signer = (await Identity.fromPkcs8(key)).did();
      expect(await store.chainFor(signer)).toBeDefined();
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("presents no chain on a machine that never joined", async () => {
    const root = await Deno.makeTempDir();
    try {
      const key = await Identity.generatePkcs8();
      const keyPath = `${root}/identity.key`;
      await Deno.writeFile(keyPath, key);
      const { fetchFn, requests } = recordingFetch([
        jsonResponse({ results: [] }),
      ]);
      const client = await createHarnessPatternIndexClientFactory(
        { baseUrl: "https://index.test/api" },
        keyPath,
        fetchFn,
        new PatternIndexStore(`${root}/store`),
      )();
      await client.searchPatterns({ text: "reusable components" });
      expect(JSON.parse(requests[0].body).proofs).toBeUndefined();
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("refuses, sending nothing, when the chain cannot be built, rather than signing as a stranger", async () => {
    const root = await Deno.makeTempDir();
    try {
      const key = await Identity.generatePkcs8();
      const keyPath = `${root}/identity.key`;
      await Deno.writeFile(keyPath, key);
      const storeDir = `${root}/store`;
      const store = new PatternIndexStore(storeDir);
      await store.createRootKey();
      await Deno.writeTextFile(`${storeDir}/membership.json`, "not json");
      const { fetchFn, requests } = recordingFetch([
        jsonResponse({ results: [] }),
      ]);
      await expect(
        createHarnessPatternIndexClientFactory(
          { baseUrl: "https://index.test/api" },
          keyPath,
          fetchFn,
          store,
        )(),
      ).rejects.toThrow(
        "pattern index: the run cannot act for its member, since the membership chain for its key could not be built",
      );
      expect(requests).toHaveLength(0);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
