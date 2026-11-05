import { ensureDir } from "@std/fs";

import { fal } from "@fal-ai/client";

import type {
  GenerateImageAdvancedRoute,
  GenerateImageRoute,
} from "./img.routes.ts";
import env from "@/env.ts";
import { sha256 } from "@/lib/sha2.ts";
import type { AppRouteHandler } from "@/lib/types.ts";

// Configure FAL client
fal.config({ credentials: env.FAL_API_KEY });

const CACHE_DIR = `${env.CACHE_DIR}/ai-img`;

export const generateImage: AppRouteHandler<GenerateImageRoute> = async (c) => {
  const logger = c.get("logger");
  const { prompt } = c.req.query();
  const width = Number(c.req.query("width"));
  const height = Number(c.req.query("height"));
  const customSize = Number.isInteger(width) && Number.isInteger(height)
    ? { width, height }
    : undefined;

  const cacheKey = JSON.stringify({
    prompt,
    image_size: customSize ?? "square",
  });
  const promptSha = await sha256(cacheKey);
  const cachePath = `${CACHE_DIR}/${promptSha}.webp`;

  logger.info(
    { prompt, promptSha, image_size: customSize ?? "square" },
    "Starting image generation",
  );

  // Check cache first
  try {
    const cachedImage = await Deno.readFile(cachePath);
    logger.info(
      { promptSha, bytes: cachedImage.byteLength, path: cachePath },
      "🎯 Cache HIT - Serving cached image",
    );
    return new Response(cachedImage, {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=31536000",
        "X-Disk-Cache": "HIT",
      },
    });
  } catch {
    logger.info(
      { promptSha, path: cachePath },
      "❌ Cache MISS - Generating new image",
    );
  }

  try {
    const result = await fal.subscribe("fal-ai/flux/schnell", {
      input: {
        prompt,
        image_size: customSize ?? "square",
        num_images: 1,
      },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS") {
          update.logs.map((log) => log.message).forEach((msg) =>
            logger.debug({ msg }, "FAL generation progress")
          );
        }
      },
    });

    logger.info({ data: result.data }, "FAL generation result");
    if (!result.data?.images?.[0]?.url) {
      logger.error({ result }, "No image URL in response");
      return c.json({ error: "Failed to generate image" }, 500);
    }

    // Fetch the image from the URL
    const imageResponse = await fetch(result.data.images[0].url);
    if (!imageResponse.ok) {
      logger.error({ status: imageResponse.status }, "Failed to fetch image");
      return c.json({ error: "Failed to fetch generated image" }, 500);
    }

    const imageData = await imageResponse.arrayBuffer();
    logger.info(
      { bytes: imageData.byteLength },
      "Image generated successfully",
    );

    // Save to cache
    await ensureDir(CACHE_DIR);
    await Deno.writeFile(cachePath, new Uint8Array(imageData));
    logger.info({ promptSha }, "Image cached");

    return new Response(imageData, {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=31536000",
        "X-Cache": "MISS",
      },
    });
  } catch (error) {
    logger.error({ error }, "Image generation failed");
    return c.json({ error: "Image generation failed" }, 500);
  }
};

export const generateImageAdvanced: AppRouteHandler<
  GenerateImageAdvancedRoute
> = async (c) => {
  const logger = c.get("logger");
  const payload = await c.req.json();
  const { prompt, ...options } = payload;

  // Create a cache key from all parameters
  const cacheKey = JSON.stringify({ prompt, ...options });
  const promptSha = await sha256(cacheKey);
  const cachePath = `${CACHE_DIR}/${promptSha}.webp`;

  logger.info(
    { prompt, promptSha, options },
    "Starting advanced image generation",
  );

  // Check cache first
  try {
    const cachedImage = await Deno.readFile(cachePath);
    logger.info(
      { promptSha, bytes: cachedImage.byteLength, path: cachePath },
      "🎯 Cache HIT - Serving cached image",
    );
    return new Response(cachedImage, {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=31536000",
        "X-Disk-Cache": "HIT",
      },
    });
  } catch {
    logger.info(
      { promptSha, path: cachePath },
      "❌ Cache MISS - Generating new image",
    );
  }

  try {
    const result = await fal.subscribe("fal-ai/flux/schnell", {
      input: {
        prompt,
        ...options,
      },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS") {
          update.logs.map((log) => log.message).forEach((msg) =>
            logger.debug({ msg }, "FAL generation progress")
          );
        }
      },
    });

    logger.info({ data: result.data }, "FAL generation result");
    if (!result.data?.images?.[0]?.url) {
      logger.error({ result }, "No image URL in response");
      return c.json({ error: "Failed to generate image" }, 500);
    }

    // Fetch the image from the URL
    const imageResponse = await fetch(result.data.images[0].url);
    if (!imageResponse.ok) {
      logger.error({ status: imageResponse.status }, "Failed to fetch image");
      return c.json({ error: "Failed to fetch generated image" }, 500);
    }

    const imageData = await imageResponse.arrayBuffer();
    logger.info(
      { bytes: imageData.byteLength },
      "Image generated successfully",
    );

    // Save to cache
    await ensureDir(CACHE_DIR);
    await Deno.writeFile(cachePath, new Uint8Array(imageData));
    logger.info({ promptSha }, "Image cached");

    return new Response(imageData, {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=31536000",
        "X-Cache": "MISS",
      },
    });
  } catch (error) {
    logger.error({ error }, "Image generation failed");
    return c.json({ error: "Image generation failed" }, 500);
  }
};
