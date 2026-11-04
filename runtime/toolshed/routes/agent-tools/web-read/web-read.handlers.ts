import { ensureDir } from "@std/fs";

import type { WebReadRoute } from "./web-read.routes.ts";
import env from "@/env.ts";
import { sha256 } from "@/lib/sha2.ts";
import type { AppRouteHandler } from "@/lib/types.ts";

const CACHE_DIR = `${env.CACHE_DIR}/agent-tools-web-read`;
const JINA_API_ENDPOINT = `https://r.jina.ai/`;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes in milliseconds

async function isValidCache(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    const age = Date.now() - (stat.mtime?.getTime() ?? 0);
    return age < CACHE_TTL;
  } catch {
    return false;
  }
}

export const webRead: AppRouteHandler<WebReadRoute> = async (c) => {
  const logger = c.get("logger");
  const verifiedUserDid = c.get("verifiedUserDid");
  const payload = await c.req.json();
  const { url, ...options } = payload;

  const promptSha = await sha256(url);
  const cachePath = `${CACHE_DIR}/${promptSha}.json`;

  logger.info(
    { url, promptSha, options, verifiedUserDid },
    "Starting advanced web extraction",
  );

  // Check cache first
  try {
    const cachedContent = await Deno.readFile(cachePath);
    const isValid = await isValidCache(cachePath);

    if (!isValid) {
      logger.info(
        { promptSha, path: cachePath },
        "Cache expired - Extracting new content",
      );
      throw new Error("Cache expired");
    }

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
    const response = await fetch(JINA_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.JINA_API_KEY}`,
      },
      body: JSON.stringify({
        url,
        ...options,
      }),
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
    await ensureDir(CACHE_DIR);
    await Deno.writeFile(
      cachePath,
      new TextEncoder().encode(JSON.stringify(transformedResult)),
    );
    logger.info({ promptSha }, "Content cached");

    return c.json(transformedResult, {
      headers: { "X-Disk-Cache": "MISS" },
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error
        ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        }
        : String(error),
    }, "Content extraction failed");
    return c.json({ error: "Failed to extract content" }, 500);
  }
};
