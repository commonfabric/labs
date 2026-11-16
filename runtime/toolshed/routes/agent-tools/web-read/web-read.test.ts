import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { signFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import { createTestApp } from "@/lib/create-app.ts";
import { createWebReadRouter } from "./web-read.index.ts";

const PATH = "/api/agent-tools/web-read";
const signer = await Identity.fromPassphrase("toolshed web-read test");

describe("web-read", () => {
  let cacheDir: string;
  let requests: Request[];
  let respond: (request: Request) => Response | Promise<Response>;

  beforeEach(async () => {
    cacheDir = await Deno.makeTempDir();
    requests = [];
    respond = () => jinaResponse({ tokens: 12 });
  });

  afterEach(async () => {
    await Deno.remove(cacheDir, { recursive: true });
  });

  const app = () =>
    createTestApp(createWebReadRouter({
      fetch: (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Promise.resolve(respond(request));
      },
      jinaApiKey: "jina-test-key",
      cacheDir,
    }));

  const post = async (payload: unknown, sign = true) => {
    const body = JSON.stringify(payload);
    const headers = sign
      ? await signFirstPartyHttpRequest({
        url: new URL(PATH, "http://localhost"),
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signer,
      })
      : new Headers({ "Content-Type": "application/json" });
    return await app().request(PATH, { method: "POST", headers, body });
  };

  const cacheFiles = async () => {
    const names: string[] = [];
    try {
      for await (
        const entry of Deno.readDir(`${cacheDir}/agent-tools-web-read`)
      ) {
        names.push(entry.name);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return names;
  };

  it("returns 401 for a request without a proof and fetches nothing", async () => {
    const res = await post({ url: "https://example.com/a" }, false);

    expect(res.status).toBe(401);
    expect(requests).toHaveLength(0);
  });

  it("returns 422 for a body whose url is not a URL and fetches nothing", async () => {
    const res = await post({ url: "not a url" });

    expect(res.status).toBe(422);
    expect(requests).toHaveLength(0);
  });

  it("posts the URL and options to the Jina reader with the configured key", async () => {
    await post({ url: "https://example.com/a", max_tokens: 500 });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.url).toBe("https://r.jina.ai/");
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe("Bearer jina-test-key");
    expect(request.headers.get("accept")).toBe("application/json");
    expect(await request.json()).toEqual({
      url: "https://example.com/a",
      max_tokens: 500,
    });
  });

  it("maps the Jina reply into content and metadata", async () => {
    const res = await post({ url: "https://example.com/a" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Disk-Cache")).toBe("MISS");
    expect(await res.json()).toEqual({
      content: "extracted content",
      metadata: {
        title: "A page",
        date: "2026-06-22",
        word_count: 9,
      },
    });
  });

  describe("cache", () => {
    it("serves a repeated URL from the cache without fetching again", async () => {
      const first = await (await post({ url: "https://example.com/a" })).json();
      respond = () => {
        throw new Error("fetch should not be called");
      };

      const res = await post({ url: "https://example.com/a" });

      expect(res.status).toBe(200);
      expect(res.headers.get("X-Disk-Cache")).toBe("HIT");
      expect(await res.json()).toEqual(first);
      expect(requests).toHaveLength(1);
    });

    it("fetches a different URL rather than serving another URL's entry", async () => {
      await post({ url: "https://example.com/a" });
      respond = () => jinaResponse({ tokens: 40 });

      const res = await post({ url: "https://example.com/b" });

      expect(res.headers.get("X-Disk-Cache")).toBe("MISS");
      expect((await res.json()).metadata.word_count).toBe(30);
      expect(requests).toHaveLength(2);
    });

    it("serves a repeated request with the same options from the cache", async () => {
      const payload = { url: "https://example.com/a", max_tokens: 5000 };
      await post(payload);

      const res = await post(payload);

      expect(res.headers.get("X-Disk-Cache")).toBe("HIT");
      expect(requests).toHaveLength(1);
    });

    it("fetches again for the same URL with a different forwarded option", async () => {
      await post({ url: "https://example.com/a", max_tokens: 500 });
      respond = () => jinaResponse({ tokens: 40 });

      const res = await post({
        url: "https://example.com/a",
        max_tokens: 5000,
      });

      expect(res.headers.get("X-Disk-Cache")).toBe("MISS");
      expect((await res.json()).metadata.word_count).toBe(30);
      expect(
        await Promise.all(
          requests.map(async (r) => (await r.json()).max_tokens),
        ),
      ).toEqual([500, 5000]);
    });

    it("fetches again once the cached entry is older than ten minutes", async () => {
      await post({ url: "https://example.com/a" });
      const [name] = await cacheFiles();
      const old = new Date(Date.now() - 11 * 60 * 1000);
      await Deno.utime(`${cacheDir}/agent-tools-web-read/${name}`, old, old);
      respond = () => jinaResponse({ tokens: 40 });

      const res = await post({ url: "https://example.com/a" });

      expect(res.headers.get("X-Disk-Cache")).toBe("MISS");
      expect((await res.json()).metadata.word_count).toBe(30);
      expect(requests).toHaveLength(2);
    });
  });

  describe("failures", () => {
    it("returns 500 and caches nothing when the reader answers with an error status", async () => {
      respond = () => new Response("rate limited", { status: 429 });

      const res = await post({ url: "https://example.com/a" });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Failed to extract content" });
      expect(await cacheFiles()).toEqual([]);
    });

    it("returns 500 and caches nothing when the reply has no data", async () => {
      respond = () => Response.json({ code: 200 });

      const res = await post({ url: "https://example.com/a" });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Failed to extract content" });
      expect(await cacheFiles()).toEqual([]);
    });

    it("returns 500 when the request to the reader fails", async () => {
      respond = () => Promise.reject(new TypeError("connection refused"));

      const res = await post({ url: "https://example.com/a" });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Failed to extract content" });
    });
  });
});

function jinaResponse({ tokens }: { tokens: number }): Response {
  return Response.json({
    data: {
      content: "extracted content",
      title: "A page",
      publishedTime: "2026-06-22",
      usage: { tokens },
    },
  });
}
