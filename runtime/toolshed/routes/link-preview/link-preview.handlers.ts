import { ensureDir } from "@std/fs";

import type { GetLinkPreviewRoute } from "./link-preview.routes.ts";
import env from "@/env.ts";
import { sha256 } from "@/lib/sha2.ts";
import type { AppRouteHandler } from "@/lib/types.ts";

const CACHE_DIR = `${env.CACHE_DIR}/link-preview`;
const JINA_API_ENDPOINT = "https://r.jina.ai/";
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function isValidCache(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    const age = Date.now() - (stat.mtime?.getTime() ?? 0);
    return age < CACHE_TTL;
  } catch {
    return false;
  }
}

export const getLinkPreview: AppRouteHandler<GetLinkPreviewRoute> = async (
  c,
) => {
  const logger = c.get("logger");

  // Strip {.+} suffix that scalar client may add
  let url = c.req.param("url").split("{")[0];
  url = decodeURIComponent(url);

  // Validate URL format — only allow http/https
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return c.json({ error: "Only http and https URLs are supported" }, 400);
    }
  } catch {
    return c.json({ error: "Invalid URL format" }, 400);
  }

  const urlHash = await sha256(url);
  const cachePath = `${CACHE_DIR}/${urlHash}.json`;

  logger.info({ url, urlHash }, "Starting link preview extraction");

  // Check cache first
  try {
    const cachedContent = await Deno.readFile(cachePath);
    const isValid = await isValidCache(cachePath);

    if (!isValid) {
      logger.info({ urlHash }, "Cache expired - Fetching new preview");
      throw new Error("Cache expired");
    }

    logger.info({ urlHash }, "Cache HIT - Serving cached preview");
    return c.json(JSON.parse(new TextDecoder().decode(cachedContent)), {
      headers: { "X-Disk-Cache": "HIT" },
    });
  } catch {
    logger.info({ urlHash }, "Cache MISS - Fetching new preview");
  }

  // Fetch via Jina API with screenshot mode
  try {
    const fetchController = new AbortController();
    const fetchTimeout = setTimeout(() => fetchController.abort(), 15_000);

    const response = await fetch(JINA_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.JINA_API_KEY}`,
        "X-Respond-With": "screenshot",
      },
      body: JSON.stringify({ url }),
      signal: fetchController.signal,
    });

    clearTimeout(fetchTimeout);

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        { status: response.status, error: errorText },
        "Jina API request failed",
      );
      return c.json({ error: "Failed to fetch link preview" }, 500);
    }

    const jinaResult = await response.json();
    const data = jinaResult.data;

    // Use Jina's hosted screenshot URL directly
    const image = data.screenshotUrl || undefined;

    // Extract description from the content (first substantive paragraph)
    let description: string | undefined;
    if (data.content) {
      const lines = data.content.split("\n").filter((l: string) => {
        const trimmed = l.trim();
        return trimmed.length > 20 && !trimmed.startsWith("#") &&
          !trimmed.startsWith("![") && !trimmed.startsWith("[");
      });
      if (lines.length > 0) {
        description = lines[0].trim().slice(0, 200);
      }
    }

    const result = {
      title: data.title || undefined,
      description,
      image,
      url,
    };

    logger.info({ title: result.title, hasImage: !!image }, "Preview ready");

    // Cache metadata
    await ensureDir(CACHE_DIR);
    await Deno.writeFile(
      cachePath,
      new TextEncoder().encode(JSON.stringify(result)),
    );

    return c.json(result, {
      headers: { "X-Disk-Cache": "MISS" },
    });
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
      },
      "Link preview extraction failed",
    );
    return c.json({ error: "Failed to extract link preview" }, 500);
  }
};
