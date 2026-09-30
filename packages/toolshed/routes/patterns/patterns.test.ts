import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { generateETag } from "@commonfabric/static/etag";
import env from "@/env.ts";
import createApp from "@/lib/create-app.ts";
import router from "@/routes/patterns/patterns.index.ts";
import {
  classifyPatternError,
  patternResponseHeaders,
} from "@commonfabric/runner/patterns-route.deno";
import { createPatternsRoute } from "@/routes/patterns/patterns-server.ts";

const IDENTITY_RE = /^[A-Za-z0-9_-]{43}$/;

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const app = createApp().route("/", router);

describe("Patterns API", () => {
  describe("basic pattern serving", () => {
    it("serves system/default-app.tsx", async () => {
      const response = await app.request(
        "/api/patterns/system/default-app.tsx",
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("export default pattern");
    });

    it("serves annotation.tsx", async () => {
      const response = await app.request("/api/patterns/annotation.tsx");
      expect(response.status).toBe(200);
      const text = await response.text();
      // annotation.tsx names its pattern and exports the binding, rather than
      // exporting the `pattern(...)` call directly.
      expect(text).toContain("export default Annotation");
    });

    it("serves connector-owned patterns at their stable routes", async () => {
      const agent = await app.request(
        "/api/patterns/agent-sessions-debug/main.tsx",
      );
      expect(agent.status).toBe(200);
      expect(await agent.text()).toContain('from "./presentation.ts"');

      const dependency = await app.request(
        "/api/patterns/agent-sessions-debug/presentation.ts",
      );
      expect(dependency.status).toBe(200);
      expect(await dependency.text()).toContain("conversationState");

      const github = await app.request(
        "/api/patterns/github-activity/main.tsx",
      );
      expect(github.status).toBe(200);
      expect(await github.text()).toContain("GitHub Activity");
    });

    it("returns 404 for non-existent pattern", async () => {
      const response = await app.request(
        "/api/patterns/non-existent-pattern.tsx",
      );
      expect(response.status).toBe(404);
    });

    it("returns 404 for a path naming a directory or reaching below a file", async () => {
      // Neither names a file this route can serve, and the route lists no
      // directories, so both are absent rather than a fault of this server.

      const directory = await app.request("/api/patterns/system");
      expect(directory.status).toBe(404);

      const belowAFile = await app.request(
        "/api/patterns/annotation.tsx/below.ts",
      );
      expect(belowAFile.status).toBe(404);
    });
  });

  describe("subdirectory imports", () => {
    // These tests validate that patterns with subdirectory structure work.
    // This was broken in PR #2314 when the patterns API blocked paths with '/'.
    // See PRs #2318 (revert) and #2319 (fix) for context.

    it("serves battleship/shared/game-logic.tsx (subdirectory import)", async () => {
      const response = await app.request(
        "/api/patterns/battleship/shared/game-logic.tsx",
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text.length).toBeGreaterThan(0);
    });

    it("serves battleship/shared/types.tsx", async () => {
      const response = await app.request(
        "/api/patterns/battleship/shared/types.tsx",
      );
      expect(response.status).toBe(200);
    });

    it("serves battleship/multiplayer/lobby.tsx", async () => {
      const response = await app.request(
        "/api/patterns/battleship/multiplayer/lobby.tsx",
      );
      expect(response.status).toBe(200);
    });

    it("serves nested subdirectory catalog/ui/story-renderer.tsx", async () => {
      const response = await app.request(
        "/api/patterns/catalog/ui/story-renderer.tsx",
      );
      expect(response.status).toBe(200);
    });

    it("serves deeply nested catalog/ui/controls/select-control.tsx", async () => {
      const response = await app.request(
        "/api/patterns/catalog/ui/controls/select-control.tsx",
      );
      expect(response.status).toBe(200);
    });

    it("serves catalog/ui/controls/index.ts", async () => {
      const response = await app.request(
        "/api/patterns/catalog/ui/controls/index.ts",
      );
      expect(response.status).toBe(200);
    });
  });

  describe("security validation", () => {
    // Note: Pure path traversal like "../../../etc/passwd" gets URL-normalized
    // before reaching the handler. These tests validate the handler-level checks.

    it("blocks .. in filename", async () => {
      // A filename containing .. should be blocked
      const response = await app.request("/api/patterns/foo..bar.tsx");
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid file path");
    });

    it("blocks .. in subdirectory path", async () => {
      // Even within a valid-looking path structure
      const response = await app.request("/api/patterns/battleship/..trick.ts");
      expect(response.status).toBe(400);
    });

    it("blocks URL scheme injection with colon", async () => {
      const response = await app.request(
        "/api/patterns/file:passwd",
      );
      expect(response.status).toBe(400);
    });

    it("blocks data: URL scheme", async () => {
      const response = await app.request(
        "/api/patterns/data:text",
      );
      expect(response.status).toBe(400);
    });
  });

  describe("?identity", () => {
    it("returns the content identity of system/default-app.tsx as text/plain", async () => {
      const response = await app.request(
        "/api/patterns/system/default-app.tsx?identity",
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/plain");
      const identity = (await response.text()).trim();
      expect(identity).toMatch(IDENTITY_RE);
    });

    it("serves identity with a strong closure-checksum ETag and requires revalidation", async () => {
      const first = await app.request(
        "/api/patterns/system/default-app.tsx?identity",
      );
      const identity = (await first.text()).trim();
      const etag = first.headers.get("ETag");

      expect(etag).toBe(`"${identity}"`);
      expect(first.headers.get("Cache-Control")).toBe("public, no-cache");

      const revalidated = await app.request(
        "/api/patterns/system/default-app.tsx?identity",
        { headers: { "If-None-Match": etag! } },
      );
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("ETag")).toBe(etag);
      expect(revalidated.headers.get("Cache-Control")).toBe(
        "public, no-cache",
      );
      expect(await revalidated.text()).toBe("");
    });

    it("allows cross-origin identity fetches", () => {
      const headers = new Headers(
        patternResponseHeaders("text/plain; charset=utf-8", '"test"'),
      );
      expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(headers.get("Access-Control-Expose-Headers")).toContain("ETag");
    });

    it("matches the shared resolveEntryIdentity over the real closure (HTTP-boundary drift guard)", async () => {
      const response = await app.request(
        "/api/patterns/system/default-app.tsx?identity",
      );
      const httpIdentity = (await response.text()).trim();
      // The same value the shared helper computes over default-app.tsx's actual
      // authored import closure — proves the endpoint wires through the runner
      // helper AND that the real system pattern's closure resolves cleanly.
      const direct = await createPatternsRoute().identity(
        "system/default-app.tsx",
      );
      expect(httpIdentity).toBe(direct);
    });

    it("computes an identity for system/home.tsx", async () => {
      const response = await app.request(
        "/api/patterns/system/home.tsx?identity",
      );
      expect(response.status).toBe(200);
      expect((await response.text()).trim()).toMatch(IDENTITY_RE);
    });

    it("computes an identity for a connector-owned pattern", async () => {
      const response = await app.request(
        "/api/patterns/agent-sessions-debug/main.tsx?identity",
      );
      expect(response.status).toBe(200);
      expect((await response.text()).trim()).toMatch(IDENTITY_RE);
    });

    it("is stable across requests", async () => {
      const a = await (await app.request(
        "/api/patterns/system/default-app.tsx?identity",
      )).text();
      const b = await (await app.request(
        "/api/patterns/system/default-app.tsx?identity",
      )).text();
      expect(a).toBe(b);
    });

    it("still serves source when identity is absent", async () => {
      const response = await app.request(
        "/api/patterns/system/default-app.tsx",
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain(
        "text/typescript-jsx",
      );
      expect(await response.text()).toContain("export default pattern");
    });

    it("serves source with a content-checksum ETag and requires revalidation", async () => {
      const first = await app.request(
        "/api/patterns/system/default-app.tsx",
      );
      const source = await first.text();
      const etag = first.headers.get("ETag");

      expect(etag).toBe(
        await generateETag(new TextEncoder().encode(source)),
      );
      expect(first.headers.get("Cache-Control")).toBe("public, no-cache");

      const revalidated = await app.request(
        "/api/patterns/system/default-app.tsx",
        { headers: { "If-None-Match": etag! } },
      );
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("ETag")).toBe(etag);
      expect(revalidated.headers.get("Cache-Control")).toBe(
        "public, no-cache",
      );
      expect(await revalidated.text()).toBe("");
    });

    it("returns source when the cached checksum does not match", async () => {
      const response = await app.request(
        "/api/patterns/system/default-app.tsx",
        { headers: { "If-None-Match": '"stale"' } },
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("export default pattern");
    });

    it("returns 404 for ?identity on a non-existent pattern", async () => {
      const response = await app.request(
        "/api/patterns/system/does-not-exist.tsx?identity",
      );
      expect(response.status).toBe(404);
    });
  });

  describe("classifyPatternError", () => {
    it("maps a not-found error to 404", () => {
      expect(classifyPatternError(new Error("Pattern file not found: x")))
        .toEqual({ status: 404, body: { error: "File not found" } });
    });
    it("maps an incomplete-closure error to 400 with the reason", () => {
      const err = new Error("incomplete closure: './x' in '/y' ...");
      expect(classifyPatternError(err)).toEqual({
        status: 400,
        body: { error: err.message },
      });
    });
    it("maps a fabric-import error to 400 with the reason", () => {
      const err = new Error("fabric import 'cf:pattern/a' in '/y' ...");
      expect(classifyPatternError(err)).toEqual({
        status: 400,
        body: { error: err.message },
      });
    });
    it("maps anything else to 500", () => {
      expect(classifyPatternError(new Error("boom"))).toEqual({
        status: 500,
        body: { error: "Internal server error" },
      });
      expect(classifyPatternError("not an error")).toEqual({
        status: 500,
        body: { error: "Internal server error" },
      });
    });
  });

  describe("CORS headers", () => {
    it("includes CORS headers for cross-origin access", async () => {
      const response = await app.request(
        "/api/patterns/system/default-app.tsx",
      );
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });
});
