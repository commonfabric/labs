import * as path from "@std/path";

import {
  compareETags,
  createCacheHeaders,
  generateETag,
} from "@commonfabric/static/etag";
import { MEMORY_URL_META_NAME } from "@commonfabric/runner/deployment-meta";

import { createRouter } from "@/lib/create-app.ts";
import { getMimeType } from "@/lib/mime-type.ts";

/**
 * Inputs the static router reads files and computes ETags with. Injectable so
 * the serving logic can be exercised against an in-memory or fixture file set.
 */
export interface ShellStaticDeps {
  readFile: (filePath: string) => Promise<Uint8Array<ArrayBuffer>>;
  generateETag: (content: Uint8Array) => Promise<string>;
}

export interface ShellStaticOptions {
  deps?: ShellStaticDeps;

  /**
   * Build identifier embedded in a compiled toolshed binary. Its immutable
   * `/builds/<id>/` URL namespace aliases the binary's single static graph.
   */
  immutableBuildId?: string | null;

  /**
   * The response for every request that resolves to `index.html`, however the
   * path spells it, the `/builds/<id>/` alias and the client-routing fallback
   * included. A compiled toolshed builds it once at startup with
   * {@link loadShellIndex}, so that the page it serves always carries the
   * deployment's memory URL. Absent, `index.html` is read and served as
   * built.
   */
  index?: StaticResponse;
}

const defaultDeps: ShellStaticDeps = {
  readFile: Deno.readFile,
  generateETag,
};

/**
 * A static file's content, held for as long as the file is cached, together
 * with what serving it needs: its MIME type and a strong ETag over the content.
 * Builds both 200 (full content) and 304 (not modified) responses.
 */
export class StaticResponse {
  #blob: Blob;
  #mimeType: string;
  #etag: string;

  /**
   * Constructs an instance which serves `blob` as `mimeType`, and validates a
   * client's cached copy against `etag`.
   */
  constructor(blob: Blob, mimeType: string, etag: string) {
    this.#blob = blob;
    this.#mimeType = mimeType;
    this.#etag = etag;
  }

  /**
   * The content served. A `Blob` is immutable, so what a response carries is
   * always what `.etag` was computed over.
   */
  get blob(): Blob {
    return this.#blob;
  }

  /** Strong ETag over `.blob`. */
  get etag(): string {
    return this.#etag;
  }

  /** MIME type the content is served as. */
  get mimeType(): string {
    return this.#mimeType;
  }

  /**
   * Builds the response to a request carrying `ifNoneMatch`: a 304 with no
   * body when that matches `.etag`, and otherwise a 200 with the content.
   * Either way the response tells the client to revalidate against the ETag
   * on every request.
   */
  response(ifNoneMatch?: string | null): Response {
    if (ifNoneMatch && compareETags(this.#etag, ifNoneMatch)) {
      return new Response(null, {
        status: 304,
        headers: {
          "ETag": this.#etag,
        },
      });
    }

    return new Response(this.#blob, {
      status: 200,
      headers: {
        "Content-Type": this.#mimeType,
        // Without this a `Blob` body goes out chunked, which leaves the client
        // with no length to show progress against.
        "Content-Length": String(this.#blob.size),
        ...createCacheHeaders(this.#etag),
      },
    });
  }

  /**
   * Reads the file at `filePath` through `deps`, and returns an instance which
   * serves its content with the MIME type its extension maps to.
   */
  static async fromFile(
    filePath: string,
    deps: ShellStaticDeps = defaultDeps,
  ): Promise<StaticResponse> {
    return StaticResponse.fromBytes(
      await deps.readFile(filePath),
      getMimeType(filePath),
      deps,
    );
  }

  /**
   * Returns an instance which serves `bytes` as `mimeType`, with an ETag
   * computed over them through `deps`.
   */
  static async fromBytes(
    bytes: Uint8Array<ArrayBuffer>,
    mimeType: string,
    deps: ShellStaticDeps = defaultDeps,
  ): Promise<StaticResponse> {
    const etag = await deps.generateETag(bytes);

    // The `Blob` constructor copies, so the cached content is reachable only
    // through the `Blob`, which cannot be written to.
    return new StaticResponse(new Blob([bytes]), mimeType, etag);
  }
}

const escapeHtmlAttribute = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * Returns `html` with the `<meta>` element named `MEMORY_URL_META_NAME`
 * inserted before its `</head>`, carrying `memoryUrl`, or empty content where
 * the deployment has none. The shell takes an empty element as the
 * deployment saying it has none, so a deployment without a memory router
 * costs it no request.
 *
 * @throws If `html` has no `</head>`, since the shell would then never see
 * the element and would ask the API host for the memory URL on every load.
 */
export function withMemoryUrlMeta(
  html: Uint8Array,
  memoryUrl: string | undefined,
): Uint8Array<ArrayBuffer> {
  const text = new TextDecoder().decode(html);
  const at = text.search(/<\/head\s*>/i);
  if (at === -1) {
    throw new Error("The shell's index.html has no </head> to publish in");
  }
  const meta = `<meta name="${MEMORY_URL_META_NAME}" content="${
    escapeHtmlAttribute(memoryUrl ?? "")
  }">`;
  return new TextEncoder().encode(text.slice(0, at) + meta + text.slice(at));
}

/**
 * Reads `index.html` under `staticRoot` once and returns the response that
 * serves it with the deployment's memory URL ({@link withMemoryUrlMeta}),
 * the ETag computed over what is served.
 *
 * @throws If the file cannot be read or has no `</head>`. A compiled toolshed
 * calls this at startup, so a bundle the shell could not learn its memory URL
 * from refuses to start rather than failing each page request.
 */
export async function loadShellIndex(
  staticRoot: string,
  memoryUrl: string | undefined,
  deps: ShellStaticDeps = defaultDeps,
): Promise<StaticResponse> {
  const indexPath = path.join(staticRoot, "index.html");
  return StaticResponse.fromBytes(
    withMemoryUrlMeta(await deps.readFile(indexPath), memoryUrl),
    getMimeType(indexPath),
    deps,
  );
}

/**
 * Build a router that serves the compiled shell frontend out of `staticRoot`.
 *
 * Responses carry ETag-based caching: a 200 with the file bytes and cache
 * headers, or a 304 when the client's `If-None-Match` matches. Requests that
 * do not resolve to a file fall back to `index.html` for client-side routing.
 * Paths resolving outside `staticRoot` are rejected by the traversal guard and
 * fall through to the same `index.html` fallback. Files are cached by the
 * path they resolve to, so `//app.js` and `/app.js` share one entry, and
 * every spelling of `index.html` gets `options.index` where one is given.
 */
export function createShellStaticRouter(
  staticRoot: string,
  options: ShellStaticOptions = {},
) {
  const deps = options.deps ?? defaultDeps;
  const immutableBuildPrefix = options.immutableBuildId
    ? `builds/${encodeURIComponent(options.immutableBuildId)}/`
    : undefined;
  const router = createRouter();
  const cache = new Map<string, StaticResponse>();
  const indexPath = path.join(staticRoot, "index.html");
  // The page itself: the one built at startup, or the file as built, read
  // once.
  const index = async (): Promise<StaticResponse> => {
    if (options.index !== undefined) return options.index;
    const cached = cache.get("index.html");
    if (cached) return cached;
    const res = await StaticResponse.fromFile(indexPath, deps);
    cache.set("index.html", res);
    return res;
  };

  router.get("/*", async (c) => {
    let reqPath = c.req.path.slice(1); // Remove leading slash

    // GCS retains a physical copy of every deployed graph under this URL.
    // A compiled toolshed contains exactly one graph, so expose that same
    // contract as an exact-build alias without embedding the bytes twice.
    if (immutableBuildPrefix && reqPath.startsWith(immutableBuildPrefix)) {
      reqPath = reqPath.slice(immutableBuildPrefix.length);
    }

    // Get If-None-Match header for ETag validation
    const ifNoneMatch = c.req.header("If-None-Match");

    // Default to index.html for root path. The path is resolved before
    // anything else, so that `//index.html` and `/./index.html` are the page
    // and not a second, uncached copy of it.
    const filePath = path.join(staticRoot, reqPath || "index.html");
    // Reject anything that resolves outside the static root. A relative path
    // that climbs out of the root starts with "..", and an unrelated
    // absolute path has no relative route into the root; a plain prefix
    // check would also accept sibling directories like
    // `${staticRoot}-dev/...`.
    const relative = path.relative(staticRoot, filePath);
    const outside = relative.startsWith("..") || path.isAbsolute(relative);
    if (outside || relative === "index.html") {
      return (await index()).response(ifNoneMatch);
    }

    const cached = cache.get(relative);
    if (cached) {
      return cached.response(ifNoneMatch);
    }

    try {
      const res = await StaticResponse.fromFile(filePath, deps);
      cache.set(relative, res);
      return res.response(ifNoneMatch);
    } catch {
      // Serve index.html for client-side routing
      return (await index()).response(ifNoneMatch);
    }
  });

  return router;
}
