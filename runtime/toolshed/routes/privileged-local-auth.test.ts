import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { signFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import env from "@/env.ts";
import { createTestApp } from "@/lib/create-app.ts";
import webReadRouter from "@/routes/agent-tools/web-read/web-read.index.ts";
import webSearchRouter from "@/routes/agent-tools/web-search/web-search.index.ts";
import sandboxExecRouter from "@/routes/sandbox/exec/exec.index.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const signer = await Identity.fromPassphrase("toolshed local route auth test");
const originalFetch = globalThis.fetch;

const webReadApp = createTestApp(webReadRouter);
const webSearchApp = createTestApp(webSearchRouter);
const sandboxExecApp = createTestApp(sandboxExecRouter);

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function signedHeaders(path: string, body: string): Promise<Headers> {
  return await signFirstPartyHttpRequest({
    url: new URL(path, "http://localhost"),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signer,
  });
}

describe("privileged local route authentication", () => {
  const missingProofCases = [
    {
      name: "web-read",
      app: webReadApp,
      path: "/api/agent-tools/web-read",
      body: JSON.stringify({ url: "https://example.com/read" }),
    },
    {
      name: "web-search",
      app: webSearchApp,
      path: "/api/agent-tools/web-search",
      body: JSON.stringify({ query: "example" }),
    },
    {
      name: "sandbox exec",
      app: sandboxExecApp,
      path: "/api/sandbox/exec",
      body: JSON.stringify({
        sandboxId: "sandbox-auth-test",
        command: "echo hello",
      }),
    },
  ] as const;

  for (const routeCase of missingProofCases) {
    it(`rejects ${routeCase.name} calls without a proof before privileged work`, async () => {
      let fetchCalled = false;
      globalThis.fetch = () => {
        fetchCalled = true;
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      };

      const response = await routeCase.app.request(routeCase.path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: routeCase.body,
      });
      await response.text();

      expect(response.status).toBe(401);
      expect(fetchCalled).toBe(false);
    });
  }

  it("allows a web-read call with a proof through to the handler", async () => {
    const url = `https://example.com/${crypto.randomUUID()}`;
    const body = JSON.stringify({ url, max_tokens: 4000 });
    const headers = await signedHeaders("/api/agent-tools/web-read", body);
    let fetchCalled = false;

    globalThis.fetch = () => {
      fetchCalled = true;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              content: "extracted content",
              title: "Signed page",
              publishedTime: "2026-06-22",
              usage: { tokens: 12 },
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    };

    const response = await webReadApp.request("/api/agent-tools/web-read", {
      method: "POST",
      headers,
      body,
    });
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(fetchCalled).toBe(true);
    expect(result.content).toBe("extracted content");
  });
});
