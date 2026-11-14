import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { signFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import { createTestApp } from "@/lib/create-app.ts";
import { hostIsBlocked, type ResolveDns } from "./web-search.handlers.ts";
import { createWebSearchRouter } from "./web-search.index.ts";

const PATH = "/api/agent-tools/web-search";
const GATEWAY = "http://gateway.test/v1/chat/completions";
const PUBLIC_IP = "93.184.215.14";
const signer = await Identity.fromPassphrase("toolshed web-search test");

/** The grounding redirect for chunk `n`. */
const redirectUri = (n: number) =>
  `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${n}`;

const redirectTo = (location: string) =>
  new Response(null, { status: 302, headers: { location } });

const html = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html" } });

const grounding = (chunks: unknown[]) =>
  Response.json({
    choices: [{ message: { grounding_metadata: { groundingChunks: chunks } } }],
  });

/** A grounding chunk whose redirect leads to `n`'s page. */
const chunk = (n: number, title?: string) => ({
  web: { uri: redirectUri(n), title },
});

describe("web-search", () => {
  let cacheDir: string;
  let requests: Request[];
  let gatewayReply: () => Response | Promise<Response>;
  // Answers by URL. Each call receives how many times that URL was requested
  // before, so a page can answer its resolution and its content fetch
  // differently.
  let pages: Map<string, (previous: number) => Response | Promise<Response>>;
  let dns: Map<string, string[]>;

  beforeEach(async () => {
    cacheDir = await Deno.makeTempDir();
    requests = [];
    gatewayReply = () => grounding([]);
    pages = new Map();
    dns = new Map();
  });

  afterEach(async () => {
    await Deno.remove(cacheDir, { recursive: true });
  });

  /** Makes chunk `n`'s redirect lead to `url`, which answers `page`. */
  const site = (
    n: number,
    url: string,
    page: (previous: number) => Response | Promise<Response> = () =>
      html("<p>hi</p>"),
  ) => {
    pages.set(redirectUri(n), () => redirectTo(url));
    pages.set(url, page);
  };

  const requested = (url: string) =>
    requests.filter((request) => request.url === url).length;

  const app = () =>
    createTestApp(createWebSearchRouter({
      fetch: (input, init) => {
        const request = new Request(input, init);
        const previous = requested(request.url);
        requests.push(request);
        if (request.url === GATEWAY) return Promise.resolve(gatewayReply());
        const page = pages.get(request.url);
        return Promise.resolve(
          page ? page(previous) : new Response("missing", { status: 404 }),
        );
      },
      resolveDns: (host) => Promise.resolve(dns.get(host) ?? [PUBLIC_IP]),
      gatewayUrl: "http://gateway.test//",
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

  const search = async (payload: Record<string, unknown>) => {
    const res = await post({ query: "bakeries", ...payload });
    expect(res.status).toBe(200);
    return await res.json();
  };

  const urls = (result: { results: Array<{ url: string }> }) =>
    result.results.map((r) => r.url);

  it("returns 401 for a request without a proof and fetches nothing", async () => {
    const res = await post({ query: "bakeries" }, false);

    expect(res.status).toBe(401);
    expect(requests).toHaveLength(0);
  });

  it("returns 422 for an empty query and fetches nothing", async () => {
    const res = await post({ query: "" });

    expect(res.status).toBe(422);
    expect(requests).toHaveLength(0);
  });

  it("sends the query to the gateway's chat completions with Google Search grounding", async () => {
    await post({ query: "bakeries" });

    const [request] = requests;
    expect(request.url).toBe(GATEWAY);
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe(
      "Bearer gateway-internal",
    );
    expect(request.headers.get("x-cf-harness-command")).toBe("web-search");
    expect(await request.json()).toEqual({
      model: "gemini-3.5-flash",
      messages: [{ role: "user", content: "bakeries" }],
      tools: [{ type: "google_search", google_search: {} }],
      stream: false,
    });
  });

  describe("results", () => {
    it("returns each grounding redirect's destination under the chunk's title", async () => {
      site(1, "https://bread.example/");
      site(2, "https://cake.example/menu");
      gatewayReply = () =>
        grounding([chunk(1, "  Bread Co  "), chunk(2, "Cake Shop")]);

      const res = await post({ query: "bakeries" });

      expect(res.status).toBe(200);
      expect(res.headers.get("X-Disk-Cache")).toBe("MISS");
      expect(await res.json()).toEqual({
        query: "bakeries",
        results: [
          {
            title: "Bread Co",
            url: "https://bread.example/",
            description: "",
            content: "",
          },
          {
            title: "Cake Shop",
            url: "https://cake.example/menu",
            description: "",
            content: "",
          },
        ],
        total_results: 2,
      });
    });

    it("titles a result with its host when the chunk's title is blank or absent", async () => {
      site(1, "https://bread.example/");
      site(2, "https://cake.example/");
      gatewayReply = () => grounding([chunk(1, "   "), chunk(2)]);

      const result = await search({});

      expect(result.results.map((r: { title: string }) => r.title)).toEqual([
        "bread.example",
        "cake.example",
      ]);
    });

    it("skips chunks that carry no usable redirect", async () => {
      site(1, "https://bread.example/");
      gatewayReply = () =>
        grounding([
          "not a chunk",
          {},
          { web: { title: "No URI" } },
          { web: { uri: 7 } },
          { web: { uri: "" } },
          chunk(1),
        ]);

      const result = await search({});

      expect(urls(result)).toEqual(["https://bread.example/"]);
    });

    it("skips a chunk whose title is not a string without resolving its redirect", async () => {
      site(1, "https://bread.example/");
      site(2, "https://cake.example/");
      gatewayReply = () =>
        grounding([{ web: { uri: redirectUri(1), title: 7 } }, chunk(2)]);

      const result = await search({});

      expect(urls(result)).toEqual(["https://cake.example/"]);
      expect(requested(redirectUri(1))).toBe(0);
    });

    it("skips destinations on review, directory and social sites", async () => {
      site(1, "https://www.yelp.com/biz/bread");
      site(2, "https://www.yellowpages.do/bread");
      site(3, "https://bread.example/");
      gatewayReply = () => grounding([chunk(1), chunk(2), chunk(3)]);

      const result = await search({});

      expect(urls(result)).toEqual(["https://bread.example/"]);
    });

    it("skips a redirect that answers itself and a destination that answers an error", async () => {
      pages.set(redirectUri(1), () => html("stuck"));
      site(2, "https://gone.example/", () => new Response("", { status: 404 }));
      site(3, "https://bread.example/");
      gatewayReply = () => grounding([chunk(1), chunk(2), chunk(3)]);

      const result = await search({});

      expect(urls(result)).toEqual(["https://bread.example/"]);
    });

    it("keeps the first result per host, in order, up to max_results", async () => {
      site(1, "https://bread.example/a");
      site(2, "https://bread.example/b");
      site(3, "https://cake.example/");
      site(4, "https://pie.example/");
      gatewayReply = () => grounding([chunk(1), chunk(2), chunk(3), chunk(4)]);

      const result = await search({ max_results: 2 });

      expect(urls(result)).toEqual([
        "https://bread.example/a",
        "https://cake.example/",
      ]);
      expect(result.total_results).toBe(2);
    });

    it("resolves at most eight chunks for a small max_results", async () => {
      const chunks = Array.from({ length: 12 }, (_, i) => chunk(i));
      gatewayReply = () => grounding(chunks);

      await search({ max_results: 1 });

      const resolved = chunks.filter((c) => requested(c.web.uri) > 0);
      expect(resolved).toEqual(chunks.slice(0, 8));
    });

    it("resolves at most three chunks per result for a larger max_results", async () => {
      const chunks = Array.from({ length: 12 }, (_, i) => chunk(i));
      gatewayReply = () => grounding(chunks);

      await search({ max_results: 3 });

      const resolved = chunks.filter((c) => requested(c.web.uri) > 0);
      expect(resolved).toEqual(chunks.slice(0, 9));
    });
  });

  describe("redirect safety", () => {
    it("never requests a destination on a private or internal host", async () => {
      dns.set("intranet.example", [PUBLIC_IP, "192.168.1.10"]);
      const blocked = [
        "http://10.0.0.5/",
        "http://localhost:8000/",
        "http://intranet.example/",
        "http://[::ffff:127.0.0.1]/",
      ];
      blocked.forEach((url, i) => site(i, url));
      site(9, "https://bread.example/");
      gatewayReply = () =>
        grounding([...blocked.map((_, i) => chunk(i)), chunk(9)]);

      const result = await search({ max_results: 10 });

      expect(urls(result)).toEqual(["https://bread.example/"]);
      expect(requests.map((r) => r.url).sort()).toEqual(
        [
          GATEWAY,
          ...blocked.map((_, i) => redirectUri(i)),
          redirectUri(9),
          "https://bread.example/",
        ].sort(),
      );
    });

    it("never requests a URL that is not http or https, or not a URL at all", async () => {
      site(1, "ftp://bread.example/menu");
      site(2, "https://bread.example/");
      gatewayReply = () =>
        grounding([
          { web: { uri: "not a url" } },
          { web: { uri: "file:///etc/passwd" } },
          chunk(1),
          chunk(2),
        ]);

      const result = await search({});

      expect(urls(result)).toEqual(["https://bread.example/"]);
      expect(requests.map((r) => r.url)).toEqual([
        GATEWAY,
        redirectUri(1),
        redirectUri(2),
        "https://bread.example/",
      ]);
    });

    it("follows a relative redirect against the URL that sent it", async () => {
      pages.set(redirectUri(1), () => redirectTo("https://bread.example/old"));
      pages.set("https://bread.example/old", () => redirectTo("/new"));
      pages.set("https://bread.example/new", () => html("ok"));
      gatewayReply = () => grounding([chunk(1)]);

      const result = await search({});

      expect(urls(result)).toEqual(["https://bread.example/new"]);
    });

    it("follows five redirects and gives up at the sixth", async () => {
      const chain = (n: number, redirects: number) => {
        const hop = (i: number) => `https://chain${n}.example/${i}`;
        pages.set(redirectUri(n), () => redirectTo(hop(1)));
        for (let i = 1; i < redirects; i++) {
          pages.set(hop(i), () => redirectTo(hop(i + 1)));
        }
        pages.set(hop(redirects), () => html("end"));
      };
      chain(1, 5);
      chain(2, 6);
      gatewayReply = () => grounding([chunk(1), chunk(2)]);

      const result = await search({});

      expect(urls(result)).toEqual(["https://chain1.example/5"]);
      expect(requested("https://chain2.example/5")).toBe(1);
      expect(requested("https://chain2.example/6")).toBe(0);
    });

    it("skips a redirect without a location and a request that fails", async () => {
      pages.set(redirectUri(1), () => new Response(null, { status: 302 }));
      site(2, "https://down.example/", () => {
        throw new TypeError("connection refused");
      });
      site(3, "https://bread.example/");
      gatewayReply = () => grounding([chunk(1), chunk(2), chunk(3)]);

      const result = await search({});

      expect(urls(result)).toEqual(["https://bread.example/"]);
    });
  });

  describe("include_content", () => {
    it("returns each page's text without markup, scripts or styles", async () => {
      site(1, "https://bread.example/", () =>
        html(
          "<html><head><style>p { color: red }</style>" +
            "<script>alert(1)</script></head>" +
            "<body><h1>Bread</h1>\n\n<p>Fresh   daily</p></body></html>",
        ));
      gatewayReply = () => grounding([chunk(1)]);

      const result = await search({ include_content: true });

      expect(result.results[0].content).toBe("Bread Fresh daily");
    });

    it("cuts a page's text at 4000 characters", async () => {
      site(1, "https://bread.example/", () => html("x".repeat(5000)));
      gatewayReply = () => grounding([chunk(1)]);

      const result = await search({ include_content: true });

      expect(result.results[0].content).toBe("x".repeat(4000));
    });

    it("returns plain text pages as they are", async () => {
      site(1, "https://bread.example/", () =>
        new Response("Fresh bread", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }));
      gatewayReply = () => grounding([chunk(1)]);

      const result = await search({ include_content: true });

      expect(result.results[0].content).toBe("Fresh bread");
    });

    it("returns empty content for a page that is not text or fails on the second request", async () => {
      site(1, "https://pdf.example/", () =>
        new Response("%PDF", {
          headers: { "content-type": "application/pdf" },
        }));
      site(
        2,
        "https://flaky.example/",
        (previous) =>
          previous === 0 ? html("ok") : new Response("", { status: 503 }),
      );
      site(3, "https://down.example/", (previous) => {
        if (previous === 0) return html("ok");
        throw new TypeError("connection reset");
      });
      site(
        4,
        "https://broken.example/",
        (previous) =>
          previous === 0 ? html("ok") : new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new Error("stream broke"));
              },
            }),
            { headers: { "content-type": "text/html" } },
          ),
      );
      gatewayReply = () => grounding([chunk(1), chunk(2), chunk(3), chunk(4)]);

      const result = await search({ include_content: true });

      expect(result.results).toEqual([
        expect.objectContaining({ url: "https://pdf.example/", content: "" }),
        expect.objectContaining({ url: "https://flaky.example/", content: "" }),
        expect.objectContaining({ url: "https://down.example/", content: "" }),
        expect.objectContaining({
          url: "https://broken.example/",
          content: "",
        }),
      ]);
    });

    it("does not fetch page content unless asked", async () => {
      site(1, "https://bread.example/");
      gatewayReply = () => grounding([chunk(1)]);

      await search({});

      expect(requested("https://bread.example/")).toBe(1);
    });
  });

  describe("failures", () => {
    it("returns 500 when the gateway answers with an error status", async () => {
      gatewayReply = () => new Response("overloaded", { status: 503 });

      const res = await post({ query: "bakeries" });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Search failed" });
    });

    it("returns 500 when the request to the gateway fails", async () => {
      gatewayReply = () => Promise.reject(new TypeError("connection refused"));

      const res = await post({ query: "bakeries" });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Search failed" });
    });

    it("returns no results when the completion carries no grounding", async () => {
      gatewayReply = () =>
        Response.json({ choices: [{ finish_reason: "SAFETY", message: {} }] });

      expect(await search({})).toEqual({
        query: "bakeries",
        results: [],
        total_results: 0,
      });
    });

    it("returns no results when the completion is not shaped like one", async () => {
      gatewayReply = () => Response.json({ choices: "none" });

      expect(await search({})).toEqual({
        query: "bakeries",
        results: [],
        total_results: 0,
      });
    });
  });

  describe("cache", () => {
    const cacheEntries = async () => {
      const names: string[] = [];
      try {
        for await (
          const entry of Deno.readDir(`${cacheDir}/agent-tools-web-search`)
        ) {
          names.push(entry.name);
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      return names;
    };

    beforeEach(() => {
      site(1, "https://bread.example/");
      gatewayReply = () => grounding([chunk(1)]);
    });

    it("serves a repeated search from the cache without fetching again", async () => {
      const first = await search({});
      const count = requests.length;

      const res = await post({ query: "bakeries" });

      expect(res.headers.get("X-Disk-Cache")).toBe("HIT");
      expect(await res.json()).toEqual(first);
      expect(requests).toHaveLength(count);
    });

    it("searches again for the same query with a different max_results", async () => {
      await search({});

      const res = await post({ query: "bakeries", max_results: 2 });

      expect(res.headers.get("X-Disk-Cache")).toBe("MISS");
      expect(requested(GATEWAY)).toBe(2);
    });

    it("searches again once the cached entry is older than ten minutes", async () => {
      await search({});
      const [name] = await cacheEntries();
      const old = new Date(Date.now() - 11 * 60 * 1000);
      await Deno.utime(`${cacheDir}/agent-tools-web-search/${name}`, old, old);

      const res = await post({ query: "bakeries" });

      expect(res.headers.get("X-Disk-Cache")).toBe("MISS");
      expect(requested(GATEWAY)).toBe(2);
    });

    it("does not cache a search with no results", async () => {
      gatewayReply = () => grounding([]);
      await search({});

      const res = await post({ query: "bakeries" });

      expect(res.headers.get("X-Disk-Cache")).toBe("MISS");
      expect(requested(GATEWAY)).toBe(2);
      expect(await cacheEntries()).toEqual([]);
    });
  });

  describe("hostIsBlocked()", () => {
    const noLookup: ResolveDns = () => {
      throw new Error("an address literal needs no lookup");
    };
    const resolvingTo =
      (a: string[], aaaa: string[]): ResolveDns => (_, type) =>
        Promise.resolve(type === "A" ? a : aaaa);

    it("returns true for empty, localhost and internal-only names", async () => {
      for (
        const host of [
          "",
          "localhost",
          "LOCALHOST",
          "app.localhost",
          "printer.local",
          "db.internal",
        ]
      ) {
        expect({ host, blocked: await hostIsBlocked(host, noLookup) })
          .toEqual({ host, blocked: true });
      }
    });

    it("returns true for private, loopback, link-local and shared IPv4 addresses", async () => {
      for (
        const host of [
          "0.0.0.0",
          "10.1.2.3",
          "127.0.0.1",
          "169.254.169.254",
          "172.16.0.1",
          "172.31.255.255",
          "192.168.0.1",
          "100.64.0.1",
          "100.127.255.255",
        ]
      ) {
        expect({ host, blocked: await hostIsBlocked(host, noLookup) })
          .toEqual({ host, blocked: true });
      }
    });

    it("returns false for public IPv4 addresses beside the private ranges", async () => {
      for (
        const host of [
          "8.8.8.8",
          "172.15.0.1",
          "172.32.0.1",
          "192.169.0.1",
          "169.253.0.1",
          "100.63.0.1",
          "100.128.0.1",
        ]
      ) {
        expect({ host, blocked: await hostIsBlocked(host, noLookup) })
          .toEqual({ host, blocked: false });
      }
    });

    it("returns true for private and IPv4-mapped private IPv6 addresses", async () => {
      for (
        const host of [
          "[::1]",
          "::",
          "fc00::1",
          "fd12:3456::1",
          "fe80::1",
          "[feb0::1]",
          "::ffff:10.0.0.1",
          "[::ffff:7f00:1]",
          "::ffff:a9fe:a9fe",
        ]
      ) {
        expect({ host, blocked: await hostIsBlocked(host, noLookup) })
          .toEqual({ host, blocked: true });
      }
    });

    it("returns false for public and IPv4-mapped public IPv6 addresses", async () => {
      for (
        const host of ["2606:4700::1111", "::ffff:8.8.8.8", "[::ffff:808:808]"]
      ) {
        expect({ host, blocked: await hostIsBlocked(host, noLookup) })
          .toEqual({ host, blocked: false });
      }
    });

    it("returns false for a name whose addresses are all public", async () => {
      expect(
        await hostIsBlocked(
          "bread.example",
          resolvingTo([PUBLIC_IP], ["2606:4700::1111"]),
        ),
      ).toBe(false);
    });

    it("returns true for a name with any private address", async () => {
      expect(
        await hostIsBlocked("a.example", resolvingTo([PUBLIC_IP], ["::1"])),
      ).toBe(true);
      expect(
        await hostIsBlocked("b.example", resolvingTo(["10.0.0.1"], [])),
      ).toBe(true);
    });

    it("returns true for a name whose resolver answers something that is not an address", async () => {
      expect(
        await hostIsBlocked("odd.example", resolvingTo(["not-an-ip"], [])),
      ).toBe(true);
    });

    it("returns true for a name with no addresses", async () => {
      expect(await hostIsBlocked("void.example", resolvingTo([], []))).toBe(
        true,
      );
    });

    it("judges a name by the lookup that succeeds when the other fails", async () => {
      const failing = (a: string[]): ResolveDns => (_, type) =>
        type === "A"
          ? Promise.resolve(a)
          : Promise.reject(new Deno.errors.NotFound("no AAAA"));

      expect(await hostIsBlocked("v4.example", failing([PUBLIC_IP]))).toBe(
        false,
      );
      expect(await hostIsBlocked("v4.example", failing(["127.0.0.1"]))).toBe(
        true,
      );
    });

    it("returns true for a name whose lookups both throw", async () => {
      const throwing: ResolveDns = () => {
        throw new Error("resolver unavailable");
      };

      expect(await hostIsBlocked("bread.example", throwing)).toBe(true);
    });
  });
});
