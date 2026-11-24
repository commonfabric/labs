import { ensureDir } from "@std/fs";

import type { GetLinkPreviewRoute } from "./link-preview.routes.ts";
import { sha256 } from "@/lib/sha2.ts";
import type { AppRouteHandler } from "@/lib/types.ts";

export interface LinkPreviewHandlerDeps {
  /** Calls the Jina reader. */
  fetch: typeof fetch;
  /** The key sent to the Jina reader. */
  jinaApiKey: string;
  /** The directory previews are cached in, keyed by URL. */
  cacheDir: string;
}

const JINA_API_ENDPOINT = "https://r.jina.ai/";
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

interface LinkPreview {
  title?: string;
  description?: string;
  image?: string;
  url: string;
}

/** The preview cached at `path`, when it was written within `CACHE_TTL`. */
async function readFreshCache(path: string): Promise<LinkPreview | undefined> {
  try {
    const { mtime } = await Deno.stat(path);
    if (Date.now() - (mtime?.getTime() ?? 0) >= CACHE_TTL) return undefined;
    return JSON.parse(await Deno.readTextFile(path));
  } catch {
    return undefined;
  }
}

/**
 * The first line of `content` that reads as prose: longer than 20 characters
 * and not a heading, image or link. Cut to 200 characters.
 */
function firstParagraph(content: string): string | undefined {
  return content.split("\n").map((line) => line.trim()).find((line) =>
    line.length > 20 && !line.startsWith("#") && !line.startsWith("![") &&
    !line.startsWith("[")
  )?.slice(0, 200);
}

export function createLinkPreviewHandlers(deps: LinkPreviewHandlerDeps) {
  const getLinkPreview: AppRouteHandler<GetLinkPreviewRoute> = async (c) => {
    const logger = c.get("logger");

    // The router has already decoded the parameter. Strip the {.+} suffix
    // that the scalar client may add.
    const url = c.req.param("url").split("{")[0];
    try {
      const { protocol } = new URL(url);
      if (protocol !== "http:" && protocol !== "https:") {
        return c.json({ error: "Only http and https URLs are supported" }, 400);
      }
    } catch {
      return c.json({ error: "Invalid URL format" }, 400);
    }

    const urlHash = await sha256(url);
    const cachePath = `${deps.cacheDir}/${urlHash}.json`;

    logger.info({ url, urlHash }, "Starting link preview extraction");

    const cached = await readFreshCache(cachePath);
    if (cached) {
      logger.info({ urlHash }, "Cache HIT - Serving cached preview");
      return c.json(cached, 200, { "X-Disk-Cache": "HIT" });
    }
    logger.info({ urlHash }, "Cache MISS - Fetching new preview");

    try {
      const response = await deps.fetch(JINA_API_ENDPOINT, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "Authorization": `Bearer ${deps.jinaApiKey}`,
          "X-Respond-With": "screenshot",
        },
        body: JSON.stringify({ url }),
      });

      if (!response.ok) {
        logger.error(
          { status: response.status, error: await response.text() },
          "Jina API request failed",
        );
        return c.json({ error: "Failed to fetch link preview" }, 500);
      }

      const { data } = await response.json();
      const result: LinkPreview = {
        title: data.title || undefined,
        description: data.content ? firstParagraph(data.content) : undefined,
        image: data.screenshotUrl || undefined,
        url,
      };

      logger.info({ title: result.title, hasImage: !!result.image }, "Ready");

      await ensureDir(deps.cacheDir);
      await Deno.writeTextFile(cachePath, JSON.stringify(result));

      return c.json(result, 200, { "X-Disk-Cache": "MISS" });
    } catch (error) {
      logger.error({ err: error }, "Link preview extraction failed");
      return c.json({ error: "Failed to extract link preview" }, 500);
    }
  };

  return { getLinkPreview };
}
