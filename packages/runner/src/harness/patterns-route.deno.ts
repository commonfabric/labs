/**
 * The patterns route: the server half of a `system:` pattern origin.
 *
 * A piece that records such an origin follows it by fetching a path under
 * {@link PATTERNS_ROUTE_PREFIX} from the host serving its space — the source
 * itself, or, with `?identity`, the content identity of that source's whole
 * authored import closure. This is what answers.
 *
 * Both halves of that exchange belong to the runner. The route prefix is part
 * of a pattern's content identity, because a compiled module is named by its
 * URL pathname; and the identity a request asks for is the value a worker
 * stores as `patternIdentity.identity` when it compiles the same source over
 * HTTP. A host serving this route has to reproduce both exactly, and an answer
 * that reproduces them imperfectly is one no runtime can adopt. So the route
 * is defined once here, and each host — the toolshed, a test harness hosting
 * storage in its own process — supplies its directories and composes the
 * answer with whatever else it serves.
 *
 * Deno-only: it reads files. Single-file reads only, never a directory
 * listing, so it behaves the same in a compiled binary's embedded file system
 * as it does on a source tree.
 */

import { toFileUrl } from "@std/path/to-file-url";

import {
  compareETags,
  createCacheHeaders,
  generateETag,
} from "@commonfabric/static/etag";
import { LRUCache } from "@commonfabric/utils/cache";
import { decode } from "@commonfabric/utils/encoding";
import { stringTupleKey } from "@commonfabric/utils/string-tuple-key";

import { PATTERNS_ROUTE_PREFIX } from "../pattern-source-scheme.ts";
import { resolveEntryIdentity } from "./entry-identity.ts";

/**
 * A directory of pattern source files reached under a route path prefix. The
 * prefix is stripped before the rest of the path is resolved inside the
 * directory, so a connector's patterns answer at a stable route of their own
 * whatever their location on disk.
 */
export interface PatternSourceDirectory {
  /** The route path prefix, ending in `/`, e.g. `github-activity/`. */
  readonly routePrefix: string;

  /** The directory on disk holding the files that prefix names. */
  readonly directory: string;
}

/** What a single-file request asks for beyond the file itself. */
export interface PatternFileRequest {
  /** Answer with the entry closure's identity rather than the source. */
  identity?: boolean;

  /** Retained source entries, named by their full patterns-route pathname. */
  sourceRoots?: readonly string[];

  /** The request's `If-None-Match`, which a matching ETag answers 304 to. */
  ifNoneMatch?: string | null;
}

/** The route over one set of directories, and everything it answers. */
export class PatternsRoute {
  #baseUrl: URL;
  #extraSources: Array<{ routePrefix: string; baseUrl: URL }>;

  /**
   * Each requested program's content identity. Pattern files are fixed for
   * the process's lifetime; request-selected root combinations have bounded
   * retention. A rejected computation is evicted so a transient
   * failure (e.g. an incomplete closure during a partial deploy) can be
   * retried.
   */
  #identityCache = new LRUCache<string, Promise<string>>({ capacity: 256 });

  /**
   * `root` holds the patterns every route path reaches by default.
   * `extraSources` name directories answering for a prefix of their own, and
   * are consulted before `root`.
   */
  constructor(
    root: string,
    extraSources: readonly PatternSourceDirectory[] = [],
  ) {
    this.#baseUrl = directoryUrl(root);
    this.#extraSources = extraSources.map((source) => ({
      routePrefix: source.routePrefix,
      baseUrl: directoryUrl(source.directory),
    }));
  }

  /**
   * A pattern file's content as bytes.
   *
   * A path that names no file is not found, whichever of the three ways it
   * fails to name one: nothing is there, it names a directory, or it
   * continues below a file. The read reports each differently, and a caller
   * asking for a pattern has the same answer for all three.
   */
  async get(filename: string): Promise<Uint8Array> {
    const url = this.#resolve(filename);

    try {
      return await Deno.readFile(url);
    } catch (error) {
      if (
        error instanceof Deno.errors.NotFound ||
        error instanceof Deno.errors.IsADirectory ||
        error instanceof Deno.errors.NotADirectory
      ) {
        throw new Error(`Pattern file not found: ${filename}`);
      }
      throw error;
    }
  }

  /** A pattern file's content as text. */
  async getText(filename: string): Promise<string> {
    const buffer = await this.get(filename);
    return decode(buffer);
  }

  /**
   * The content-addressed identity of a pattern entry — the value advertised
   * to runtimes through `?identity`. Walks the entry's authored import closure
   * via `getText` and hashes the pristine bytes; no compiler, runtime, or
   * storage is involved. An updater independently compiles the downloaded
   * closure and requires its entry ref to have this identity before replacing
   * a root.
   *
   * `filename` is the same root-relative path `getText` accepts, e.g.
   * `system/default-app.tsx`. Rejects if the closure is incomplete or reaches
   * a `cf:` fabric import, which the light path does not model.
   */
  identity(
    filename: string,
    sourceRoots: readonly string[] = [],
  ): Promise<string> {
    const roots = [...new Set(sourceRoots)].sort();
    if (roots.length > 32 || !roots.every(validSourceRoot)) {
      throw new Error("Invalid source root path");
    }
    const key = stringTupleKey([filename, ...roots]);
    let cached = this.#identityCache.get(key);
    if (!cached) {
      // Name modules by their URL pathname so the identity equals the one the
      // worker computes when it compiles the same source over HTTP.
      cached = resolveEntryIdentity(
        `${PATTERNS_ROUTE_PREFIX}${filename}`,
        (name) => this.getText(name.slice(PATTERNS_ROUTE_PREFIX.length)),
        { sourceRoots: roots },
      );
      this.#identityCache.put(key, cached);
      const pending = cached;
      cached.catch(() => {
        if (this.#identityCache.get(key) === pending) {
          this.#identityCache.delete(key);
        }
      });
    }
    return cached;
  }

  /**
   * This route's answer to `request`, or `undefined` when the request does not
   * address the route — a path outside the prefix, or a method the route does
   * not serve. A host composes that answer with whatever else it serves, and
   * answers the leftovers itself.
   */
  async serve(request: Request): Promise<Response | undefined> {
    if (request.method !== "GET" && request.method !== "HEAD") return undefined;
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PATTERNS_ROUTE_PREFIX)) return undefined;
    const encoded = url.pathname.slice(PATTERNS_ROUTE_PREFIX.length);
    if (encoded.length === 0) return undefined;

    // The route's own router decodes the path once, so `serveFile` receives
    // the same shape from either entry point.
    let filename: string;
    try {
      filename = decodeURIComponent(encoded);
    } catch {
      return invalidPatternPath();
    }
    return await this.serveFile(filename, {
      identity: url.searchParams.has("identity"),
      sourceRoots: url.searchParams.getAll("sourceRoot"),
      ifNoneMatch: request.headers.get("If-None-Match"),
    });
  }

  /**
   * The route's answer for one file, named by its path under the route prefix.
   * A host whose own router has already picked the path apart calls this
   * instead of {@link serve}.
   *
   * The path is checked before it is resolved. A `..` sequence would escape
   * the directory, a leading `/` would make the name absolute in URL
   * resolution, and a `:` would introduce a URL scheme
   * (`file:///etc/passwd`). An internal `/` is allowed, because patterns are
   * served from subdirectories. The check decodes first, so an encoded
   * sequence is caught as the sequence it denotes.
   */
  async serveFile(
    filename: string,
    options: PatternFileRequest = {},
  ): Promise<Response> {
    const ifNoneMatch = options.ifNoneMatch ?? null;
    try {
      const decoded = decodeURIComponent(filename);
      if (
        decoded.includes("..") || decoded.startsWith("/") ||
        decoded.includes(":")
      ) {
        return invalidPatternPath();
      }

      if (options.identity) {
        const identity = await this.identity(filename, options.sourceRoots);
        return patternResponse(
          identity,
          "text/plain; charset=utf-8",
          `"${identity}"`,
          ifNoneMatch,
        );
      }

      // Hash and serve the exact bytes so the ETag is a strong validator for
      // the representation the client caches.
      const content = await this.get(filename);
      return patternResponse(
        content as BodyInit,
        "text/typescript-jsx; charset=utf-8",
        await generateETag(content),
        ifNoneMatch,
      );
    } catch (error) {
      const { status, body } = classifyPatternError(error);
      if (status === 500) console.error("Error serving pattern file:", error);
      return Response.json(body, { status });
    }
  }

  #resolve(filename: string): URL {
    const source = this.#extraSources.find(({ routePrefix }) =>
      filename.startsWith(routePrefix)
    );
    const baseUrl = source?.baseUrl ?? this.#baseUrl;
    const relative = source === undefined
      ? filename
      : filename.slice(source.routePrefix.length);
    const url = new URL(relative, baseUrl);

    if (!url.href.startsWith(baseUrl.href)) {
      throw new Error("Path traversal detected");
    }
    return url;
  }
}

/** Headers shared by source and `?identity` responses. */
export function patternResponseHeaders(
  contentType: string,
  etag: string,
): Record<string, string> {
  return {
    "Content-Type": contentType,
    ...createCacheHeaders(etag),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "ETag",
  };
}

/**
 * Map a pattern-serving error to an HTTP status and body: a missing file →
 * 404; a structurally invalid entry (incomplete import closure, or a `cf:`
 * fabric import the light `?identity` path does not model) → 400 with the
 * reason; anything else → 500.
 */
export function classifyPatternError(
  error: unknown,
): { status: 404 | 400 | 500; body: { error: string } } {
  if (error instanceof Error && error.message.includes("not found")) {
    return { status: 404, body: { error: "File not found" } };
  }
  if (
    error instanceof Error &&
    (error.message.includes("Invalid source root path") ||
      error.message.includes("incomplete closure") ||
      error.message.includes("fabric import"))
  ) {
    return { status: 400, body: { error: error.message } };
  }
  return { status: 500, body: { error: "Internal server error" } };
}

function patternResponse(
  body: BodyInit,
  contentType: string,
  etag: string,
  ifNoneMatch: string | null,
): Response {
  const headers = patternResponseHeaders(contentType, etag);
  if (compareETags(etag, ifNoneMatch)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status: 200, headers });
}

function invalidPatternPath(): Response {
  return Response.json({ error: "Invalid file path" }, { status: 400 });
}

function directoryUrl(directory: string): URL {
  const url = toFileUrl(directory);
  if (!url.href.endsWith("/")) url.href += "/";
  return url;
}

/** Whether an attached entry stays within the public patterns namespace. */
function validSourceRoot(name: string): boolean {
  if (!name.startsWith(PATTERNS_ROUTE_PREFIX)) return false;
  const path = name.slice(PATTERNS_ROUTE_PREFIX.length);
  return path.length > 0 && path.length <= 2048 && !/[\\:%?#]/.test(path) &&
    !path.startsWith("/") &&
    !path.split("/").some((part) => part === "." || part === "..");
}
