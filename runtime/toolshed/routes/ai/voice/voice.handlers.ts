import { crypto } from "@std/crypto";
import { ensureDir } from "@std/fs";

import { fal } from "@fal-ai/client";
import type { Logger } from "pino";
import { z } from "zod";

import type {
  SuccessResponseSchema,
  TranscribeVoiceRoute,
  TranscriptionChunk,
} from "./voice.routes.ts";
import env from "@/env.ts";
import type { AppRouteHandler } from "@/lib/types.ts";

// Configure FAL client
fal.config({ credentials: env.FAL_API_KEY });

const CACHE_DIR = `${env.CACHE_DIR}/ai-voice`;
const ALLOWED_CONTENT_TYPES = ["audio/wav", "audio/mpeg"] as const;
type AllowedContentType = typeof ALLOWED_CONTENT_TYPES[number];

interface TranscriptionResult {
  transcription: string;
  chunks: TranscriptionChunk[];
}

async function generateCacheKey(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function uploadToFAL(
  bytes: ArrayBuffer,
  contentType: AllowedContentType,
) {
  const file = new File([bytes], "audio.wav", { type: contentType });
  return await fal.storage.upload(file);
}

async function getCachedTranscription(
  cachePath: string,
  logger: Logger,
): Promise<TranscriptionResult | null> {
  try {
    const cachedResult = await Deno.readFile(cachePath);
    const result = JSON.parse(new TextDecoder().decode(cachedResult));
    logger.info(
      { path: cachePath },
      "🎯 Cache HIT - Serving cached transcription",
    );
    return result;
  } catch {
    return null;
  }
}

async function saveTranscriptionToCache(
  cachePath: string,
  data: TranscriptionResult,
  logger: Logger,
): Promise<void> {
  await ensureDir(CACHE_DIR);
  await Deno.writeFile(
    cachePath,
    new TextEncoder().encode(JSON.stringify(data)),
  );
  logger.info({ path: cachePath }, "Transcription cached");
}

function formatResponse(
  transcription: string,
  chunks: TranscriptionChunk[],
  responseType: "full" | "text" | "chunks",
): z.infer<typeof SuccessResponseSchema> {
  switch (responseType) {
    case "text":
      return { response_type: "text" as const, transcription };
    case "chunks":
      return { response_type: "chunks" as const, chunks };
    default:
      return { response_type: "full" as const, transcription, chunks };
  }
}

export const transcribeVoice: AppRouteHandler<TranscribeVoiceRoute> = async (
  c,
) => {
  const logger = c.get("logger");
  const contentType = c.req.header("content-type") as AllowedContentType ||
    "audio/wav";

  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    logger.error({ contentType }, "Unsupported content type");
    return c.json({ error: "Unsupported content type" }, 400);
  }

  const audioBuffer = await c.req.arrayBuffer();
  if (audioBuffer.byteLength === 0) {
    logger.error("Empty audio buffer received");
    return c.json({ error: "No audio data provided" }, 400);
  }

  const responseType = (c.req.query("response_type") || "full") as
    | "full"
    | "text"
    | "chunks";

  const promptSha = await generateCacheKey(audioBuffer);
  const cachePath = `${CACHE_DIR}/${promptSha}.json`;

  logger.info(
    { bytes: audioBuffer.byteLength, promptSha, responseType },
    "Starting voice transcription",
  );

  // Check cache
  const cachedResult = await getCachedTranscription(cachePath, logger);
  if (cachedResult) {
    return c.json(
      formatResponse(
        cachedResult.transcription,
        cachedResult.chunks,
        responseType,
      ),
      200,
    );
  }

  logger.info({ promptSha }, "Cache MISS - Generating new transcription");

  try {
    const audioUrl = await uploadToFAL(audioBuffer, contentType);
    logger.info({ audioUrl }, "Audio uploaded to FAL storage");

    const result = await fal.subscribe("fal-ai/wizper", {
      input: { audio_url: audioUrl },
    });

    if (!result.data?.text) {
      logger.error({ result }, "No transcription in response");
      return c.json({ error: "Failed to transcribe audio" }, 400);
    }

    const transcription = result.data.text;
    const chunks = result.data.chunks as unknown as TranscriptionChunk[] || [];

    logger.info(
      { chars: transcription.length, chunks: chunks.length },
      "Transcription generated successfully",
    );

    const transcriptionResult = {
      transcription,
      chunks: chunks as unknown as TranscriptionChunk[],
    };
    await saveTranscriptionToCache(cachePath, transcriptionResult, logger);

    return c.json(
      formatResponse(transcription, chunks, responseType),
      200,
    );
  } catch (error) {
    logger.error({ error }, "Transcription failed");
    return c.json({ error: "Failed to transcribe audio" }, 500);
  }
};
