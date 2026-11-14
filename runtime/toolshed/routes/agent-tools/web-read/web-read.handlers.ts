import { ensureDir } from "@std/fs";

import type { WebReadRoute } from "./web-read.routes.ts";
import { sha256 } from "@/lib/sha2.ts";
import type { AppRouteHandler } from "@/lib/types.ts";

const JINA_API_ENDPOINT = `https://r.jina.ai/`;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes in milliseconds

/** What the outbound requests of a web read go through. */
export interface WebReadDeps {
  /** Sends the request to the Jina reader. */
  fetch: typeof fetch;
  /** The key the Jina reader request is authorized with. */
  jinaApiKey: string;
  /** The directory extracted pages are cached in. */
  cacheDir: string;
}

/** Builds the web read handler over `deps`. */
export function createWebReadHandlers(deps: WebReadDeps): {
  webRead: AppRouteHandler<WebReadRoute>;
} {
  const cacheDir = `${deps.cacheDir}/agent-tools-web-read`;

  const webRead: AppRouteHandler<WebReadRoute> = async (c) => {
    const logger = c.get("logger");
    const verifiedUserDid = c.get("verifiedUserDid");
    const payload = await c.req.json();
    const { url, ...options } = payload;
    // The cache is keyed on the whole request the reader receives, so a
    // request differing in any option is read again.
    const body = JSON.stringify({ url, ...options });

    const promptSha = await sha256(body);
    const cachePath = `${cacheDir}/${promptSha}.json`;

    logger.info(
      { url, promptSha, options, verifiedUserDid },
      "Starting advanced web extraction",
    );

    // Check cache first
    try {
      const { mtime } = await Deno.stat(cachePath);
      if (Date.now() - (mtime?.getTime() ?? 0) >= CACHE_TTL) {
        logger.info(
          { promptSha, path: cachePath },
          "Cache expired - Extracting new content",
        );
        throw new Error("Cache expired");
      }
      const cachedContent = await Deno.readFile(cachePath);

      logger.info(
        { promptSha, bytes: cachedContent.byteLength, path: cachePath },
        "🎯 Cache HIT - Serving cached content",
      );
      return c.json(JSON.parse(new TextDecoder().decode(cachedContent)), {
        headers: { "X-Disk-Cache": "HIT" },
      });
    } catch {
      logger.info(
        { promptSha, path: cachePath },
        "❌ Cache MISS - Extracting new content",
      );
    }

    try {
      const response = await deps.fetch(JINA_API_ENDPOINT, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "Authorization": `Bearer ${deps.jinaApiKey}`,
        },
        body,
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          {
            status: response.status,
            error: errorText,
            headers: Object.fromEntries(response.headers.entries()),
          },
          "Jina API request failed",
        );
        return c.json({ error: "Failed to extract content" }, 500);
      }

      const result = await response.json();
      logger.info({ result }, "Content extracted successfully");

      // Transform the response to match our API schema
      const transformedResult = {
        content: result.data.content,
        metadata: {
          title: result.data.title,
          date: result.data.publishedTime,
          word_count: Math.floor(result.data.usage.tokens * 0.75),
        },
      };

      // Save to cache
      await ensureDir(cacheDir);
      await Deno.writeFile(
        cachePath,
        new TextEncoder().encode(JSON.stringify(transformedResult)),
      );
      logger.info({ promptSha }, "Content cached");

      return c.json(transformedResult, {
        headers: { "X-Disk-Cache": "MISS" },
      });
    } catch (error) {
      logger.error({ err: error }, "Content extraction failed");
      return c.json({ error: "Failed to extract content" }, 500);
    }
  };

  return { webRead };
}
