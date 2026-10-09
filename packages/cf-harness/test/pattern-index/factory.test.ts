import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { verifyFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
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
});
