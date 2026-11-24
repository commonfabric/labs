import { ensureDir } from "@std/fs";
import { z } from "zod";

import type { WebSearchRoute } from "./web-search.routes.ts";
import { gatewayProvenanceHeaders } from "@/lib/gateway-provenance.ts";
import { sha256 } from "@/lib/sha2.ts";
import type { AppRouteHandler } from "@/lib/types.ts";

const CACHE_TTL = 10 * 60 * 1000; // 10 minutes in milliseconds

// Web search is backed by Google Search grounding via the gateway (Gemini).
// We send the query with the `google_search` tool and read the REAL search
// hits from the response's `grounding_metadata.groundingChunks` — these are
// actual results, not the model's prose (which hallucinates URLs). Each chunk's `web.uri` is a Google
// redirect that we follow to the real destination (which also validates it).
const GROUNDED_SEARCH_MODEL = "gemini-3.5-flash";
const RESOLVE_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146 Safari/537.36";

// Review/directory/aggregator/social brands to skip so we prefer a business's
// OWN site. Grounding sometimes ranks these above the official homepage; when a
// chunk resolves to one, we fall through to the next chunk. Matched by domain
// *label* (any TLD), so `yellowpages.do`, `yellowpages.ca`, etc. all count.
const AGGREGATOR_BRANDS: ReadonlySet<string> = new Set([
  "yelp",
  "tripadvisor",
  "opentable",
  "threebestrated",
  "checkle",
  "wanderboat",
  "placejoys",
  "restaurantji",
  "yellowpages",
  "mapquest",
  "grubhub",
  "doordash",
  "ubereats",
  "postmates",
  "seamless",
  "zomato",
  "allmenus",
  "menupix",
  "foursquare",
  "facebook",
  "instagram",
  "nextdoor",
  "reddit",
  "wikipedia",
  "google",
  "bing",
  "yahoo",
  "mapcarta",
  "chamberofcommerce",
  "loopnet",
  "bbb",
  "trustpilot",
  "interstatelogos",
  "menuism",
  "menupages",
  "zmenu",
  "sirved",
  "yellowbook",
  "manta",
  "citysearch",
  "ezlocal",
  "hotfrog",
  "n49",
  "twitter",
  "linkedin",
  "pinterest",
  "tiktok",
  "youtube",
]);

function isAggregatorHost(host: string): boolean {
  // Any label of the host matching a known aggregator brand disqualifies it
  // (e.g. "www.yellowpages.do" → label "yellowpages").
  return host.toLowerCase().split(".").some((label) =>
    AGGREGATOR_BRANDS.has(label)
  );
}

const CompletionSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.unknown().optional(),
    message: z.object({
      grounding_metadata: z.object({
        groundingChunks: z.array(z.unknown()).optional(),
      }).optional(),
    }).optional(),
  })).optional(),
});

const GroundingChunkSchema = z.object({
  web: z.object({
    uri: z.string().optional(),
    title: z.string().optional(),
  }).optional(),
});

//
// SSRF guard
//
// This route fetches URLs that come from search results (and follows their
// redirects), so it must never be coaxed into reaching internal hosts. We
// validate every hop's host (name + resolved IP) against private/reserved
// ranges before connecting.
//

function isPrivateIpv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return true; // not an address, so it cannot be vetted
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true; // unspecified/private/loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateIp(ip: string): boolean {
  const h = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (h.includes(":")) {
    if (h === "::1" || h === "::") return true; // loopback/unspecified
    if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local fc00::/7
    if (/^fe[89ab]/.test(h)) return true; // link-local fe80::/10
    // IPv4-mapped, written either dotted (as DNS answers print it) or as two
    // hex groups (as a URL serializes it: `[::ffff:127.0.0.1]` has the
    // hostname `[::ffff:7f00:1]`).
    const dotted = h.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (dotted) return isPrivateIpv4(dotted[1]);
    const hex = h.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      return isPrivateIpv4(
        `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
      );
    }
    return false;
  }
  return isPrivateIpv4(h);
}

function isIpLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
}

/** Looks up the addresses a host name has for one record type. */
export type ResolveDns = (
  host: string,
  recordType: "A" | "AAAA",
) => Promise<string[]>;

/** True if `host` is (or resolves to) an internal/private/loopback target. */
export async function hostIsBlocked(
  host: string,
  resolveDns: ResolveDns,
): Promise<boolean> {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !h || h === "localhost" || h.endsWith(".localhost") ||
    h.endsWith(".local") || h.endsWith(".internal")
  ) {
    return true;
  }
  if (isIpLiteral(h)) return isPrivateIp(h);
  // Resolve and block if ANY address is private. A failed lookup contributes
  // no addresses, and a host with none is blocked too (don't fetch a host we
  // can't vet).
  const lookup = async (recordType: "A" | "AAAA") => {
    try {
      return await resolveDns(h, recordType);
    } catch {
      return [];
    }
  };
  const [a, aaaa] = await Promise.all([lookup("A"), lookup("AAAA")]);
  const ips = [...a, ...aaaa];
  return ips.length === 0 || ips.some(isPrivateIp);
}

/** What the outbound requests of a web search go through. */
export interface WebSearchDeps {
  /** Sends the gateway request and every page request. */
  fetch: typeof fetch;
  /** Resolves page hosts for the SSRF guard. */
  resolveDns: ResolveDns;
  /** The LLM gateway's base URL. */
  gatewayUrl: string;
  /** The directory search results are cached in. */
  cacheDir: string;
}

/**
 * GET a URL, following redirects MANUALLY so each hop's host is SSRF-validated
 * before we connect. Returns the response (caller reads/cancels the body) plus
 * a `cleanup` that clears the timeout — call it only after the body is handled,
 * so the timeout budget spans the body read, not just the headers.
 */
async function ssrfSafeGet(
  deps: WebSearchDeps,
  initialUrl: string,
  timeoutMs: number,
): Promise<{ res: Response; finalUrl: string; cleanup: () => void } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const cleanup = () => clearTimeout(timer);
  let url = initialUrl;
  try {
    for (let hop = 0; hop < 6; hop++) {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") break;
      if (await hostIsBlocked(u.hostname, deps.resolveDns)) break;
      const res = await deps.fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": RESOLVE_UA },
        signal: ctrl.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel();
        if (!loc) break;
        url = new URL(loc, url).toString();
        continue;
      }
      return { res, finalUrl: url, cleanup };
    }
  } catch {
    // An unparseable URL or a failed request refuses the URL, as a blocked
    // hop, a redirect without a location and too many redirects do.
  }
  cleanup();
  return null;
}

/**
 * Follow a Google grounding redirect to its real destination, returning the
 * final URL only if it resolves to a reachable, non-Google, non-aggregator
 * http(s) page. De-references the redirect AND validates the candidate.
 */
async function resolveGroundingUrl(
  deps: WebSearchDeps,
  redirectUrl: string,
): Promise<string | null> {
  const got = await ssrfSafeGet(deps, redirectUrl, 8000);
  if (!got) return null;
  const { res, finalUrl, cleanup } = got;
  await res.body?.cancel();
  cleanup();
  if (res.status >= 400) return null;
  const host = new URL(finalUrl).host.toLowerCase();
  if (host.includes("vertexaisearch")) return null; // never left the redirect
  if (isAggregatorHost(host)) return null; // prefer the business's own site
  return finalUrl;
}

/**
 * Best-effort plain-text extraction of a page, for `include_content` requests.
 * Not a full reader (that's the web-read route's job) — crude tag-strip with a
 * length cap; returns "" on any error or non-text response.
 */
async function fetchPageText(
  deps: WebSearchDeps,
  url: string,
): Promise<string> {
  const got = await ssrfSafeGet(deps, url, 8000);
  if (!got) return "";
  const { res, cleanup } = got;
  try {
    const contentType = res.headers.get("content-type") ?? "";
    if (
      !res.ok ||
      (!contentType.includes("text/html") &&
        !contentType.includes("text/plain"))
    ) {
      await res.body?.cancel();
      return "";
    }
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000);
  } catch {
    return "";
  } finally {
    cleanup();
  }
}

/** Builds the web search handler over `deps`. */
export function createWebSearchHandlers(deps: WebSearchDeps): {
  webSearch: AppRouteHandler<WebSearchRoute>;
} {
  const cacheDir = `${deps.cacheDir}/agent-tools-web-search`;

  const webSearch: AppRouteHandler<WebSearchRoute> = async (c) => {
    const logger = c.get("logger");
    const verifiedUserDid = c.get("verifiedUserDid");
    const { query, max_results, include_content } = c.req.valid("json");

    const cacheKey = `${query}-${max_results}-${include_content}`;
    const promptSha = await sha256(cacheKey);
    const cachePath = `${cacheDir}/${promptSha}.json`;

    logger.info(
      { query, max_results, include_content, promptSha, verifiedUserDid },
      "Starting web search",
    );

    // Check cache first
    try {
      const { mtime } = await Deno.stat(cachePath);
      if (Date.now() - (mtime?.getTime() ?? 0) >= CACHE_TTL) {
        logger.info(
          { promptSha, path: cachePath },
          "Cache expired - Performing new search",
        );
        throw new Error("Cache expired");
      }
      const cachedContent = await Deno.readFile(cachePath);

      logger.info(
        { promptSha, bytes: cachedContent.byteLength, path: cachePath },
        "🎯 Cache HIT - Serving cached search results",
      );
      return c.json(JSON.parse(new TextDecoder().decode(cachedContent)), {
        headers: {
          "X-Disk-Cache": "HIT",
        },
      });
    } catch {
      logger.info(
        { promptSha, path: cachePath },
        "❌ Cache MISS - Performing new search",
      );
    }

    try {
      // Grounded search: send the query to Gemini with the `google_search`
      // tool and read the REAL search hits from
      // `grounding_metadata.groundingChunks` (NOT the model's prose, which
      // hallucinates URLs). Each chunk's `web.uri` is a Google redirect we
      // follow to the real destination — which also validates reachability.
      const gatewayUrl = deps.gatewayUrl.replace(/\/+$/, "");

      const res = await deps.fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer gateway-internal",
          ...gatewayProvenanceHeaders("web-search"),
        },
        body: JSON.stringify({
          model: GROUNDED_SEARCH_MODEL,
          messages: [{ role: "user", content: query }],
          tools: [{ type: "google_search", google_search: {} }],
          stream: false,
        }),
      });
      if (!res.ok) {
        throw new Error(`gateway ${res.status}: ${await res.text()}`);
      }
      const completion = CompletionSchema.safeParse(await res.json());
      const choice = completion.data?.choices?.[0];
      const chunks = choice?.message?.grounding_metadata?.groundingChunks ??
        [];

      // A search that trips Vertex's content filter is grounded in nothing,
      // and answers with no results.
      if (chunks.length === 0) {
        logger.warn(
          { finishReason: choice?.finish_reason },
          "No grounding chunks returned",
        );
      }

      // Resolve chunk redirects to their real URLs CONCURRENTLY — each call
      // has its own timeout, so wall-time is the slowest single resolution
      // rather than serial (8s × N). Cap how many we resolve so a
      // pathological grounding response can't fan out unbounded.
      const RESOLVE_CAP = Math.max(max_results * 3, 8);
      const resolved = await Promise.all(
        chunks.slice(0, RESOLVE_CAP).map(async (chunk) => {
          const web = GroundingChunkSchema.safeParse(chunk).data?.web;
          if (!web?.uri) return null;
          const url = await resolveGroundingUrl(deps, web.uri);
          if (!url) return null;
          const title = web.title?.trim() || new URL(url).host.toLowerCase();
          return { url, title };
        }),
      );

      // Pick in original (relevance) order, de-duped by host, up to
      // max_results.
      const seenHosts = new Set<string>();
      const picked: Array<{ url: string; title: string }> = [];
      for (const r of resolved) {
        if (!r || picked.length >= max_results) continue;
        const host = new URL(r.url).host.toLowerCase();
        if (seenHosts.has(host)) continue;
        seenHosts.add(host);
        picked.push(r);
      }

      // Honor `include_content` (best-effort page text), also concurrently.
      const contents = include_content
        ? await Promise.all(picked.map((p) => fetchPageText(deps, p.url)))
        : picked.map(() => "");

      const results = picked.map((p, i) => ({
        title: p.title,
        url: p.url,
        description: "",
        content: contents[i],
      }));

      const transformedResult = {
        query,
        results,
        total_results: results.length,
      };

      logger.info(
        { query, chunks: chunks.length, count: results.length },
        "Grounded web search completed",
      );

      // Cache only non-empty result sets, so a transient empty/filtered
      // generation doesn't pin zero results for the whole TTL.
      if (results.length > 0) {
        await ensureDir(cacheDir);
        await Deno.writeFile(
          cachePath,
          new TextEncoder().encode(JSON.stringify(transformedResult)),
        );
        logger.info({ promptSha }, "Search results cached");
      }

      return c.json(transformedResult, {
        headers: {
          "X-Disk-Cache": "MISS",
        },
      });
    } catch (error) {
      logger.error({ err: error }, "Web search failed");
      return c.json({ error: "Search failed" }, 500);
    }
  };

  return { webSearch };
}
