import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as path from "@std/path";
import { cors } from "@hono/hono/cors";
import env from "@/env.ts";
import createApp, { createRouter } from "@/lib/create-app.ts";
import { generateETag } from "@commonfabric/static/etag";
import type { DeploymentMetaContent } from "@commonfabric/runner/deployment-meta";
import {
  experimentalPosture,
  publishExperimentalPosture,
} from "@/lib/experimental-posture.ts";
import router, {
  compiledShellRouter,
  shellDeploymentPage,
} from "@/routes/shell/shell.index.ts";
import {
  createShellStaticRouter,
  StaticResponse,
  withDeploymentMeta,
} from "@/routes/shell/shell-static.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const app = createApp().route("/", router);

const INDEX_HTML = "<!doctype html><title>shell</title><body>index</body>";
const APP_JS = "globalThis.__shell = true;\n";
const APP_CSS = "body { color: rebeccapurple; }\n";
const SENTINEL = "TOP_SECRET_OUTSIDE_ROOT";

let tempDir: string;
let sentinelPath: string;

// A static router mounted directly, used for the serving-behavior assertions.
let staticApp: ReturnType<typeof createApp>;
let versionedStaticApp: ReturnType<typeof createApp>;
// The static router behind the same CORS middleware the shell wires up, mounted
// on a fully composed app, used to assert middleware applies to a 200 document.
let composedApp: ReturnType<typeof createApp>;

// Global hooks must be registered before any global describe() below, so the
// fixture setup for the static-router suites lives here at the top of the file.
beforeAll(async () => {
  tempDir = await Deno.makeTempDir();
  await Deno.writeTextFile(path.join(tempDir, "index.html"), INDEX_HTML);
  await Deno.writeTextFile(path.join(tempDir, "app.js"), APP_JS);
  await Deno.writeTextFile(path.join(tempDir, "app.css"), APP_CSS);

  // Sentinel lives outside the static root, in the temp dir's parent, so a
  // traversal request that escaped the root would expose it.
  sentinelPath = path.join(path.dirname(tempDir), "shell-sentinel.txt");
  await Deno.writeTextFile(sentinelPath, SENTINEL);

  staticApp = createApp().route("/", createShellStaticRouter(tempDir));
  versionedStaticApp = createApp().route(
    "/",
    createShellStaticRouter(tempDir, { immutableBuildId: "commit-123" }),
  );

  const corsRouter = createRouter();
  corsRouter.use(
    "/*",
    cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] }),
  );
  corsRouter.route("/", createShellStaticRouter(tempDir));
  composedApp = createApp().route("/", corsRouter);
});

afterAll(async () => {
  await Deno.remove(tempDir, { recursive: true });
  await Deno.remove(sentinelPath);
});

describe("Shell cross-origin isolation posture", () => {
  // The shell document must stay NON-cross-origin-isolated so that untrusted
  // patterns are never handed SharedArrayBuffer / Atomics or a high-resolution
  // clock. A page is cross-origin isolated only when it is served with BOTH
  // `Cross-Origin-Opener-Policy: same-origin` AND a require-corp/credentialless
  // `Cross-Origin-Embedder-Policy`. These tests fail loudly if a future change
  // flips the served document to that isolating combination.
  //
  // See docs/specs/sandboxing/cross-origin-isolation.md.

  it("does not serve the isolating COOP+COEP header combination", async () => {
    const response = await app.request("/");
    // Drain the body so the response does not leak into the test runner.
    await response.text();

    const coop = response.headers.get("Cross-Origin-Opener-Policy");
    const coep = response.headers.get("Cross-Origin-Embedder-Policy");

    const isolatingCoop = coop === "same-origin";
    const isolatingCoep = coep === "require-corp" || coep === "credentialless";

    // Isolation requires BOTH headers; assert we never emit both together.
    expect(isolatingCoop && isolatingCoep).toBe(false);
  });

  it("pins COOP to a non-isolating value", async () => {
    const response = await app.request("/");
    await response.text();

    const coop = response.headers.get("Cross-Origin-Opener-Policy");
    expect(coop).not.toBe("same-origin");
    expect(coop).toBe("same-origin-allow-popups");
  });

  it("pins COEP to a non-isolating value", async () => {
    const response = await app.request("/");
    await response.text();

    const coep = response.headers.get("Cross-Origin-Embedder-Policy");
    expect(coep).not.toBe("require-corp");
    expect(coep).not.toBe("credentialless");
    expect(coep).toBe("unsafe-none");
  });

  it("applies the non-isolating headers to nested paths too", async () => {
    // The posture must hold for every served path, not just the document root,
    // because any same-origin response can establish or reuse the page's agent
    // cluster.

    const response = await app.request("/assets/app.js");
    await response.text();

    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe(
      "same-origin-allow-popups",
    );
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe(
      "unsafe-none",
    );
  });
});

describe("Shell route CORS", () => {
  // The shell routes serve read-only content to any origin. These pin that
  // permissive CORS keeps working alongside the isolation headers, so a future
  // change to one does not silently disturb the other.

  it("allows a cross-origin GET with a wildcard origin", async () => {
    const response = await app.request("/", {
      headers: { Origin: "https://example.com" },
    });
    await response.text();

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("answers an OPTIONS preflight", async () => {
    const response = await app.request("/", {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    await response.text();

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("Shell dev fallback without a compiled build or proxy", () => {
  // With no compiled frontend and no SHELL_URL proxy target — the unit-test
  // environment — the shell router answers with a 404 that tells an operator
  // how to bring the shell up. This guards that operator hint and its port.

  it("returns 404 with a hint naming SHELL_URL and the shell port", async () => {
    const response = await app.request("/anything");
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(/Shell app not available/.test(body)).toBe(true);
    expect(/SHELL_URL=http:\/\/localhost:\d+/.test(body)).toBe(true);
  });
});

describe("createShellStaticRouter", () => {
  it("serves index.html at the root with status 200, text/html, and an ETag", async () => {
    const response = await staticApp.request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html");
    expect(response.headers.get("ETag")).toBeTruthy();
    expect(await response.text()).toBe(INDEX_HTML);
  });

  it("serves an asset with a JS MIME type and its own ETag", async () => {
    const response = await staticApp.request("/app.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/javascript");
    expect(response.headers.get("ETag")).toBeTruthy();
    expect(await response.text()).toBe(APP_JS);

    // The asset's ETag differs from index.html's (different content).
    const indexResponse = await staticApp.request("/");
    expect(response.headers.get("ETag")).not.toBe(
      indexResponse.headers.get("ETag"),
    );
  });

  it("serves a CSS asset with the text/css MIME type", async () => {
    const response = await staticApp.request("/app.css");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/css");
    expect(await response.text()).toBe(APP_CSS);
  });

  it("serves the embedded graph through its exact immutable build namespace", async () => {
    const response = await versionedStaticApp.request(
      "/builds/commit-123/app.js",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/javascript");
    expect(await response.text()).toBe(APP_JS);
  });

  it("does not alias a different build identifier", async () => {
    const response = await versionedStaticApp.request(
      "/builds/another-commit/app.js",
    );
    expect(response.headers.get("Content-Type")).toBe("text/html");
    expect(await response.text()).toBe(INDEX_HTML);
  });

  it("returns 304 with empty body and the same ETag for If-None-Match", async () => {
    const first = await staticApp.request("/app.js");
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();

    const second = await staticApp.request("/app.js", {
      headers: { "If-None-Match": etag! },
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("ETag")).toBe(etag);
  });

  it("falls back to index.html for a path with no matching file", async () => {
    const response = await staticApp.request("/notes/42");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html");
    expect(await response.text()).toBe(INDEX_HTML);
  });

  it("does not serve files outside the static root via traversal", async () => {
    // The request resolves outside the static root; the traversal guard (and
    // URL normalization) keep it from reaching the sentinel, so the client-side
    // routing fallback serves index.html instead.

    const response = await staticApp.request("/../shell-sentinel.txt");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe(INDEX_HTML);
    expect(body).not.toContain(SENTINEL);
  });

  it("returns a stable ETag across repeated requests for the same file", async () => {
    const first = await staticApp.request("/app.js");
    const second = await staticApp.request("/app.js");
    expect(first.headers.get("ETag")).toBe(second.headers.get("ETag"));
  });
});

describe("a compiled toolshed's shell router", () => {
  const PAGE =
    "<!doctype html><html><head><title>shell</title></head><body>index</body></html>";
  /** `PAGE` carrying `content`, as a compiled toolshed serves it. */
  const pageWith = (content: DeploymentMetaContent) =>
    new TextDecoder().decode(
      withDeploymentMeta(new TextEncoder().encode(PAGE), content),
    );
  /** A compiled toolshed's posture, before any Runtime exists. */
  const NO_RUNTIME = () => null;
  const PUBLISHED = pageWith({
    memoryUrl: "https://router.test",
    experimental: { sharedMemoryConnection: true },
  });
  let pageDir: string;
  let plain: ReturnType<typeof createApp>;
  let published: ReturnType<typeof createApp>;
  let unpublished: ReturnType<typeof createApp>;

  beforeAll(async () => {
    pageDir = await Deno.makeTempDir();
    await Deno.writeTextFile(path.join(pageDir, "index.html"), PAGE);
    await Deno.writeTextFile(path.join(pageDir, "app.js"), APP_JS);
    plain = createApp().route("/", createShellStaticRouter(pageDir));
    published = createApp().route(
      "/",
      await compiledShellRouter(
        pageDir,
        { ENV: "production", MEMORY_PUBLIC_URL: "https://router.test" },
        "commit-123",
        undefined,
        () => ({ sharedMemoryConnection: true, serverExecution: true }),
      ),
    );
    unpublished = createApp().route(
      "/",
      await compiledShellRouter(
        pageDir,
        { ENV: "production", MEMORY_PUBLIC_URL: undefined },
        null,
        undefined,
        NO_RUNTIME,
      ),
    );
  });

  afterAll(async () => {
    await Deno.remove(pageDir, { recursive: true });
  });

  it("serves the page as built from a router given no index", async () => {
    expect(await (await plain.request("/")).text()).toBe(PAGE);
  });

  it("publishes the deployment on every path that resolves to index.html", async () => {
    for (
      const url of [
        "/",
        "/index.html",
        "//index.html",
        "///index.html",
        "/.//index.html",
        "/notes/42",
        "/builds/commit-123/",
        "/builds/commit-123/index.html",
        "/builds/commit-123//index.html",
      ]
    ) {
      const response = await published.request(url);
      expect(response.headers.get("Content-Type")).toBe("text/html");
      expect(await response.text(), url).toBe(PUBLISHED);
    }
  });

  it("publishes no memory URL and no posture where the deployment has neither", async () => {
    // The shell takes it as conclusive and requests nothing more.
    for (const url of ["/", "//index.html", "/builds/production/"]) {
      expect(await (await unpublished.request(url)).text(), url).toBe(
        pageWith({ memoryUrl: null, experimental: null }),
      );
    }
  });

  it("publishes the posture's sharedMemoryConnection as /api/meta publishes it", async () => {
    // The real seam: the page reads the posture the Runtime published, as
    // the meta route does, and only on the first request, by which time a
    // compiled toolshed has constructed its Runtime.
    const before = experimentalPosture();
    try {
      for (
        const [posture, experimental] of [
          [{ sharedMemoryConnection: true, serverExecution: false }, {
            sharedMemoryConnection: true,
          }],
          [{ sharedMemoryConnection: false }, {
            sharedMemoryConnection: false,
          }],
          // A flag the Runtime left unresolved is not published as false.
          [{ serverExecution: true }, {}],
        ] as const
      ) {
        publishExperimentalPosture(null);
        const served = createApp().route(
          "/",
          await compiledShellRouter(
            pageDir,
            { ENV: "production", MEMORY_PUBLIC_URL: "https://router.test" },
            "commit-123",
          ),
        );
        publishExperimentalPosture(posture);
        expect(await (await served.request("/")).text()).toBe(
          pageWith({ memoryUrl: "https://router.test", experimental }),
        );
      }
    } finally {
      publishExperimentalPosture(before);
    }
  });

  it("builds the page once, on its first request, and reads each other file once", async () => {
    // Reads by file name, through a router of its own so that no other
    // test's requests fill its cache first.
    const reads = new Map<string, number>();
    let asked = 0;
    const counted = createApp().route(
      "/",
      await compiledShellRouter(
        pageDir,
        { ENV: "production", MEMORY_PUBLIC_URL: "https://router.test" },
        "commit-123",
        {
          readFile: (filePath) => {
            const name = path.basename(filePath);
            reads.set(name, (reads.get(name) ?? 0) + 1);
            return Deno.readFile(filePath);
          },
          generateETag,
        },
        () => {
          asked++;
          return { sharedMemoryConnection: true };
        },
      ),
    );
    // Read at startup, built on the first request.
    expect(reads.get("index.html")).toBe(1);
    expect(asked).toBe(0);
    // Three spellings of one file, each of which must find what the first
    // cached under the path it resolves to.
    for (
      const url of [
        "/",
        "/notes/1",
        "//index.html",
        "//app.js",
        "/app.js",
        "///app.js",
      ]
    ) {
      await counted.request(url);
    }
    expect(reads.get("index.html")).toBe(1);
    expect(asked).toBe(1);
    expect(reads.get("app.js")).toBe(1);
  });

  it("does not keep a page built before a Runtime exists", async () => {
    // The startup order serves no request before the Runtime is constructed;
    // a request that arrived anyway must not fix the page at null.
    let posture: Record<string, boolean> | null = null;
    const served = createApp().route(
      "/",
      await compiledShellRouter(
        pageDir,
        { ENV: "production", MEMORY_PUBLIC_URL: undefined },
        null,
        undefined,
        () => posture,
      ),
    );
    expect(await (await served.request("/")).text()).toBe(
      pageWith({ memoryUrl: null, experimental: null }),
    );
    posture = { sharedMemoryConnection: true };
    const published = pageWith({
      memoryUrl: null,
      experimental: { sharedMemoryConnection: true },
    });
    expect(await (await served.request("/")).text()).toBe(published);
    posture = { sharedMemoryConnection: false };
    expect(await (await served.request("/")).text()).toBe(published);
  });

  it("does not keep a build that failed", async () => {
    let failures = 1;
    const served = createApp().route(
      "/",
      await compiledShellRouter(
        pageDir,
        { ENV: "production", MEMORY_PUBLIC_URL: undefined },
        null,
        {
          readFile: Deno.readFile,
          generateETag: (content) =>
            failures-- > 0
              ? Promise.reject(new Error("no digest"))
              : generateETag(content),
        },
        () => ({ sharedMemoryConnection: true }),
      ),
    );
    expect((await served.request("/")).status).toBe(500);
    const second = await served.request("/");
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(
      pageWith({
        memoryUrl: null,
        experimental: { sharedMemoryConnection: true },
      }),
    );
  });

  it("refuses to start on a bundle whose page has no </head>", async () => {
    const bare = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(path.join(bare, "index.html"), INDEX_HTML);
      await expect(compiledShellRouter(
        bare,
        { ENV: "production", MEMORY_PUBLIC_URL: undefined },
        null,
        undefined,
        NO_RUNTIME,
      )).rejects.toThrow("no </head>");
    } finally {
      await Deno.remove(bare, { recursive: true });
    }
  });

  it("leaves other files alone", async () => {
    expect(await (await published.request("/app.js")).text()).toBe(APP_JS);
  });

  it("validates a cached page against the ETag of what it served", async () => {
    const first = await published.request("/");
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();
    expect(etag).not.toBe((await plain.request("/")).headers.get("ETag"));
    const second = await published.request("/notes/42", {
      headers: { "If-None-Match": etag! },
    });
    expect(second.status).toBe(304);
  });
});

describe("shellDeploymentPage", () => {
  const environment = { MEMORY_PUBLIC_URL: "https://router.test" };

  it("carries the memory URL, or null where the deployment has none", () => {
    expect(shellDeploymentPage(environment, null)).toEqual({
      memoryUrl: "https://router.test",
      experimental: null,
    });
    expect(shellDeploymentPage({ MEMORY_PUBLIC_URL: undefined }, null))
      .toEqual({ memoryUrl: null, experimental: null });
  });

  it("carries the flags the shell takes from its deployment, out of the posture", () => {
    expect(
      shellDeploymentPage(environment, {
        serverExecution: true,
        sharedMemoryConnection: true,
      }).experimental,
    ).toEqual({ sharedMemoryConnection: true });
    expect(
      shellDeploymentPage(environment, { sharedMemoryConnection: false })
        .experimental,
    ).toEqual({ sharedMemoryConnection: false });
    expect(
      shellDeploymentPage(environment, { serverExecution: true })
        .experimental,
    ).toEqual({});
  });
});

describe("withDeploymentMeta", () => {
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const encode = (text: string) => new TextEncoder().encode(text);
  const page: DeploymentMetaContent = {
    memoryUrl: "https://router.test",
    experimental: { sharedMemoryConnection: true },
  };
  const CONTENT = "{&#34;memoryUrl&#34;:&#34;https://router.test&#34;," +
    "&#34;experimental&#34;:{&#34;sharedMemoryConnection&#34;:true}}";

  it("inserts the element before </head>, whatever its case", () => {
    expect(decode(withDeploymentMeta(
      encode("<HEAD><title>t</title></HEAD ><body></body>"),
      page,
    ))).toBe(
      `<HEAD><title>t</title><meta name="cf-deployment" content="${CONTENT}">` +
        "</HEAD ><body></body>",
    );
  });

  it("carries nulls for a deployment without a memory URL or a Runtime", () => {
    expect(decode(withDeploymentMeta(
      encode("<head></head>"),
      { memoryUrl: null, experimental: null },
    ))).toBe(
      '<head><meta name="cf-deployment" content="{&#34;memoryUrl&#34;:null,' +
        '&#34;experimental&#34;:null}"></head>',
    );
  });

  it("escapes the value for an attribute", () => {
    expect(decode(withDeploymentMeta(
      encode("<head></head>"),
      { memoryUrl: `https://a.test/"><script>&'`, experimental: {} },
    ))).toBe(
      '<head><meta name="cf-deployment" content="{&#34;memoryUrl&#34;:' +
        "&#34;https://a.test/\\&#34;&#62;&#60;script&#62;&#38;&#39;&#34;," +
        '&#34;experimental&#34;:{}}"></head>',
    );
  });

  it("finds </head> in the shell's own page", async () => {
    const html = await Deno.readFile(
      new URL("../../../shell/public/index.html", import.meta.url),
    );
    expect(decode(withDeploymentMeta(html, page))).toContain(
      `<meta name="cf-deployment" content="${CONTENT}"></head>`,
    );
  });

  it("refuses a page with no </head>", () => {
    expect(() => withDeploymentMeta(encode(INDEX_HTML), page))
      .toThrow("no </head>");
  });
});

describe("createShellStaticRouter behind composed app middleware", () => {
  it("applies the cross-origin middleware to a served 200 document", async () => {
    // Exercises middleware ordering on a real 200 document rather than only on
    // the dev 404 fallback: the served index.html must still carry the
    // cross-origin header the shell wires up ahead of the static router.

    const response = await composedApp.request("/");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(INDEX_HTML);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("StaticResponse", () => {
  const encoder = new TextEncoder();

  // In-memory file set so StaticResponse can be exercised without touching
  // disk.
  const files: Record<string, Uint8Array<ArrayBuffer>> = {
    "/root/index.html": encoder.encode(INDEX_HTML),
    "/root/app.js": encoder.encode(APP_JS),
  };
  const deps = {
    readFile: (filePath: string) => {
      const content = files[filePath];
      if (!content) return Promise.reject(new Deno.errors.NotFound(filePath));
      return Promise.resolve(content);
    },
    generateETag: (content: Uint8Array) =>
      Promise.resolve(`"len-${content.byteLength}"`),
  };

  it("derives MIME type and ETag from the file via injected deps", async () => {
    const res = await StaticResponse.fromFile("/root/app.js", deps);
    expect(res.mimeType).toBe("text/javascript");
    expect(res.etag).toBe(`"len-${files["/root/app.js"].byteLength}"`);
    expect(await res.blob.text()).toBe(APP_JS);

    const response = res.response();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/javascript");
    expect(response.headers.get("Content-Length")).toBe(
      String(files["/root/app.js"].byteLength),
    );
    expect(response.headers.get("ETag")).toBe(res.etag);
    expect(await response.text()).toBe(APP_JS);
  });

  it("serves the content as read, after the source bytes are overwritten", async () => {
    const source = encoder.encode(APP_JS);
    const res = await StaticResponse.fromFile("/root/app.js", {
      ...deps,
      readFile: () => Promise.resolve(source),
    });
    source.fill(0);
    expect(await res.response().text()).toBe(APP_JS);
  });

  it("returns 304 with no body when the ETag matches If-None-Match", async () => {
    const res = await StaticResponse.fromFile("/root/index.html", deps);
    const response = res.response(res.etag);
    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe(res.etag);
    expect(await response.text()).toBe("");
  });

  it("returns 200 when the If-None-Match ETag does not match", async () => {
    const res = await StaticResponse.fromFile("/root/index.html", deps);
    const response = res.response('"some-other-etag"');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(INDEX_HTML);
  });
});
