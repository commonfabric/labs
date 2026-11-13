import { ensureDir } from "@std/fs";

import type { QueueStatus } from "@fal-ai/client";
import type { Logger } from "pino";

import type {
  GenerateImageAdvancedRoute,
  GenerateImageRoute,
} from "./img.routes.ts";
import { sha256 } from "@/lib/sha2.ts";
import type { AppRouteHandler } from "@/lib/types.ts";

/** The part of the fal.ai client that image generation calls. */
export interface ImageClient {
  subscribe(
    endpointId: "fal-ai/flux/schnell",
    options: {
      input: { prompt: string } & Record<string, unknown>;
      logs: boolean;
      onQueueUpdate: (update: QueueStatus) => void;
    },
  ): Promise<{ data?: { images?: { url?: string }[] } }>;
}

export interface ImageHandlerDeps {
  /** Runs the image model. */
  client: ImageClient;
  /** Downloads the image the model produced. */
  fetch: typeof fetch;
  /** The directory generated images are cached in, keyed by request. */
  cacheDir: string;
}

const IMAGE_HEADERS = {
  "Content-Type": "image/webp",
  "Cache-Control": "public, max-age=31536000",
};

export function createImageHandlers(deps: ImageHandlerDeps) {
  /**
   * Serves the image for `input` from the cache, or generates, caches and
   * serves it. `cacheKey` names the request in the cache.
   */
  async function serveImage(
    logger: Logger,
    input: { prompt: string } & Record<string, unknown>,
    cacheKey: string,
  ): Promise<Response> {
    const promptSha = await sha256(cacheKey);
    const cachePath = `${deps.cacheDir}/${promptSha}.webp`;

    logger.info({ input, promptSha }, "Starting image generation");

    try {
      const cachedImage = await Deno.readFile(cachePath);
      logger.info(
        { promptSha, bytes: cachedImage.byteLength, path: cachePath },
        "Cache HIT - Serving cached image",
      );
      return new Response(cachedImage, {
        headers: { ...IMAGE_HEADERS, "X-Disk-Cache": "HIT" },
      });
    } catch {
      logger.info(
        { promptSha, path: cachePath },
        "Cache MISS - Generating new image",
      );
    }

    try {
      const result = await deps.client.subscribe("fal-ai/flux/schnell", {
        input,
        logs: true,
        onQueueUpdate: (update) => {
          if (update.status === "IN_PROGRESS") {
            for (const log of update.logs) {
              logger.debug({ msg: log.message }, "FAL generation progress");
            }
          }
        },
      });

      logger.info({ data: result.data }, "FAL generation result");
      const imageUrl = result.data?.images?.[0]?.url;
      if (!imageUrl) {
        logger.error({ result }, "No image URL in response");
        return Response.json({ error: "Failed to generate image" }, {
          status: 500,
        });
      }

      const imageResponse = await deps.fetch(imageUrl);
      if (!imageResponse.ok) {
        logger.error({ status: imageResponse.status }, "Failed to fetch image");
        await imageResponse.body?.cancel();
        return Response.json({ error: "Failed to fetch generated image" }, {
          status: 500,
        });
      }

      const imageData = new Uint8Array(await imageResponse.arrayBuffer());
      logger.info({ bytes: imageData.byteLength }, "Image generated");

      await ensureDir(deps.cacheDir);
      await Deno.writeFile(cachePath, imageData);
      logger.info({ promptSha }, "Image cached");

      return new Response(imageData, {
        headers: { ...IMAGE_HEADERS, "X-Disk-Cache": "MISS" },
      });
    } catch (error) {
      logger.error({ error }, "Image generation failed");
      return Response.json({ error: "Image generation failed" }, {
        status: 500,
      });
    }
  }

  const generateImage: AppRouteHandler<GenerateImageRoute> = (c) => {
    const { prompt } = c.req.query();
    const width = Number(c.req.query("width"));
    const height = Number(c.req.query("height"));
    const image_size = Number.isInteger(width) && Number.isInteger(height)
      ? { width, height }
      : "square";
    return serveImage(
      c.get("logger"),
      { prompt, image_size, num_images: 1 },
      JSON.stringify({ prompt, image_size }),
    );
  };

  const generateImageAdvanced: AppRouteHandler<GenerateImageAdvancedRoute> =
    async (c) => {
      const { prompt, ...options } = await c.req.json();
      return serveImage(
        c.get("logger"),
        { prompt, ...options },
        JSON.stringify({ prompt, ...options }),
      );
    };

  return { generateImage, generateImageAdvanced };
}
