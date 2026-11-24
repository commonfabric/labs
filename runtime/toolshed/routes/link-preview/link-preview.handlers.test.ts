import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { createLinkPreviewRouter } from "./link-preview.index.ts";
import { createTestApp } from "@/lib/create-app.ts";

const PAGE_URL = "https://example.com/article";
const PROSE = "This is the first real paragraph of the article body.";

describe("link-preview.handlers", () => {
  let tempDir: string;
  let cacheDir: string;
  let requests: Request[];
  let jina: () => Promise<Response>;

  function jinaData(data: unknown) {
    jina = () => Promise.resolve(Response.json({ data }));
  }

  function preview(url: string, suffix = "") {
    const app = createTestApp(createLinkPreviewRouter({
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        return jina();
      },
      jinaApiKey: "test-jina-key",
      cacheDir,
    }));
    return app.request(
      `/api/link-preview/${encodeURIComponent(url)}${suffix}`,
    );
  }

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    cacheDir = `${tempDir}/link-preview`;
    requests = [];
    jinaData({
      title: "An article",
      content: PROSE,
      screenshotUrl: "https://jina.example/shot.png",
    });
  });

  afterEach(async () => {
    await Deno.remove(tempDir, { recursive: true });
  });

  it("asks Jina for a screenshot of the page and returns its title, description and image", async () => {
    const response = await preview(PAGE_URL);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Disk-Cache")).toBe("MISS");
    expect(await response.json()).toEqual({
      title: "An article",
      description: PROSE,
      image: "https://jina.example/shot.png",
      url: PAGE_URL,
    });
    expect(requests.length).toBe(1);
    const [request] = requests;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://r.jina.ai/");
    expect(request.headers.get("Authorization")).toBe("Bearer test-jina-key");
    expect(request.headers.get("X-Respond-With")).toBe("screenshot");
    expect(await request.json()).toEqual({ url: PAGE_URL });
  });

  it("passes on a URL holding percent escapes exactly as given", async () => {
    const url = "https://example.com/search?q=100%25&path=a%2Fb";
    const response = await preview(url);

    expect((await response.json()).url).toBe(url);
    expect(await requests[0].json()).toEqual({ url });
  });

  it("drops a `{.+}` suffix from the URL", async () => {
    const response = await preview(PAGE_URL, "{.+}");

    expect((await response.json()).url).toBe(PAGE_URL);
    expect(await requests[0].json()).toEqual({ url: PAGE_URL });
  });

  describe("description", () => {
    it("is the first trimmed line longer than 20 characters that is not a heading, image or link", async () => {
      jinaData({
        content: [
          "# A heading that is long enough to count",
          "![An image alt text that is long](https://x/y.png)",
          "[A link with a long enough label](https://x/)",
          "Too short.",
          `   ${PROSE}   `,
          "A later paragraph that is also long enough.",
        ].join("\n"),
      });
      const response = await preview(PAGE_URL);

      expect((await response.json()).description).toBe(PROSE);
    });

    it("is cut to 200 characters", async () => {
      jinaData({ content: "x".repeat(250) });
      const response = await preview(PAGE_URL);

      expect((await response.json()).description).toBe("x".repeat(200));
    });

    it("is absent when no line qualifies or there is no content", async () => {
      for (const content of ["# Heading only\nshort", undefined, ""]) {
        jinaData({ content });
        const response = await preview(`${PAGE_URL}/${content?.length}`);
        expect(await response.json()).not.toHaveProperty("description");
      }
    });
  });

  it("leaves out a title and image Jina does not supply", async () => {
    jinaData({ title: "", content: PROSE, screenshotUrl: "" });
    const response = await preview(PAGE_URL);

    expect(await response.json()).toEqual({
      description: PROSE,
      url: PAGE_URL,
    });
  });

  describe("cache", () => {
    it("serves a repeated request from the cache without calling Jina", async () => {
      await (await preview(PAGE_URL)).json();
      const cached = await preview(PAGE_URL);

      expect(cached.status).toBe(200);
      expect(cached.headers.get("X-Disk-Cache")).toBe("HIT");
      expect((await cached.json()).title).toBe("An article");
      expect(requests.length).toBe(1);
    });

    it("calls Jina again once the cached preview is more than ten minutes old", async () => {
      await (await preview(PAGE_URL)).json();
      const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000);
      for (const entry of Deno.readDirSync(cacheDir)) {
        const path = `${cacheDir}/${entry.name}`;
        Deno.utimeSync(path, elevenMinutesAgo, elevenMinutesAgo);
      }
      jinaData({ title: "Updated" });
      const refreshed = await preview(PAGE_URL);

      expect(refreshed.headers.get("X-Disk-Cache")).toBe("MISS");
      expect((await refreshed.json()).title).toBe("Updated");
      expect(requests.length).toBe(2);
    });

    it("calls Jina again when the cached file is not valid JSON", async () => {
      await (await preview(PAGE_URL)).json();
      for (const entry of Deno.readDirSync(cacheDir)) {
        Deno.writeTextFileSync(`${cacheDir}/${entry.name}`, "{not json");
      }
      const response = await preview(PAGE_URL);

      expect(response.headers.get("X-Disk-Cache")).toBe("MISS");
      expect(requests.length).toBe(2);
    });
  });

  describe("refused URLs", () => {
    it("returns 400 without calling Jina for a scheme other than http or https", async () => {
      for (const url of ["ftp://example.com/file", "javascript:alert(1)"]) {
        const response = await preview(url);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: "Only http and https URLs are supported",
        });
      }
      expect(requests).toEqual([]);
    });

    it("returns 400 without calling Jina for text that is not a URL", async () => {
      const response = await preview("not a url");

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid URL format" });
      expect(requests).toEqual([]);
    });
  });

  describe("upstream failures", () => {
    it("returns 500 and caches nothing when Jina answers with an error status", async () => {
      jina = () =>
        Promise.resolve(new Response("rate limited", { status: 429 }));
      const response = await preview(PAGE_URL);

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Failed to fetch link preview",
      });
      await expect(Deno.stat(cacheDir)).rejects.toThrow(Deno.errors.NotFound);
    });

    it("returns 500 when the Jina response has no data", async () => {
      jina = () => Promise.resolve(Response.json({ code: 200 }));
      const response = await preview(PAGE_URL);

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Failed to extract link preview",
      });
    });

    it("returns 500 when the request to Jina fails", async () => {
      jina = () => Promise.reject(new TypeError("connection refused"));
      const response = await preview(PAGE_URL);

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Failed to extract link preview",
      });
    });
  });
});
