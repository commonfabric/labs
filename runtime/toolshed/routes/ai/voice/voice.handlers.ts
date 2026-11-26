import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { ensureDir } from "@std/fs";

import type { z } from "zod";

import {
  type SuccessResponseSchema,
  type TranscribeVoiceRoute,
  type TranscriptionChunk,
  TranscriptionChunkSchema,
} from "./voice.routes.ts";
import type { AppRouteHandler } from "@/lib/types.ts";

/** The part of the fal.ai client that transcription calls. */
export interface TranscriptionClient {
  storage: { upload(file: Blob): Promise<string> };
  subscribe(
    endpointId: "fal-ai/wizper",
    options: { input: { audio_url: string } },
  ): Promise<{
    data?: { text?: string; chunks?: { text: string; timestamp: unknown[] }[] };
  }>;
}

export interface VoiceHandlerDeps {
  /** Stores the audio and runs the transcription model. */
  client: TranscriptionClient;
  /** The directory transcriptions are cached in, keyed by audio content. */
  cacheDir: string;
}

const ALLOWED_CONTENT_TYPES = new Set(["audio/wav", "audio/mpeg"]);

interface TranscriptionResult {
  transcription: string;
  chunks: TranscriptionChunk[];
}

function formatResponse(
  { transcription, chunks }: TranscriptionResult,
  responseType: "full" | "text" | "chunks",
): z.infer<typeof SuccessResponseSchema> {
  switch (responseType) {
    case "text":
      return { response_type: "text", transcription };
    case "chunks":
      return { response_type: "chunks", chunks };
    default:
      return { response_type: "full", transcription, chunks };
  }
}

export function createVoiceHandlers(deps: VoiceHandlerDeps) {
  async function readCache(
    cachePath: string,
  ): Promise<TranscriptionResult | undefined> {
    try {
      return JSON.parse(await Deno.readTextFile(cachePath));
    } catch {
      return undefined;
    }
  }

  const transcribeVoice: AppRouteHandler<TranscribeVoiceRoute> = async (c) => {
    const logger = c.get("logger");
    const contentType = c.req.header("content-type") || "audio/wav";

    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      logger.error({ contentType }, "Unsupported content type");
      return c.json({ error: "Unsupported content type" }, 400);
    }

    const audioBuffer = await c.req.arrayBuffer();
    if (audioBuffer.byteLength === 0) {
      logger.error("Empty audio buffer received");
      return c.json({ error: "No audio data provided" }, 400);
    }

    const responseType = c.req.valid("query").response_type;
    const audioSha = encodeHex(
      await crypto.subtle.digest("SHA-256", audioBuffer),
    );
    const cachePath = `${deps.cacheDir}/${audioSha}.json`;

    logger.info(
      { bytes: audioBuffer.byteLength, audioSha, responseType },
      "Starting voice transcription",
    );

    const cached = await readCache(cachePath);
    if (cached) {
      logger.info({ path: cachePath }, "Cache HIT - Serving transcription");
      return c.json(formatResponse(cached, responseType), 200);
    }

    logger.info({ audioSha }, "Cache MISS - Generating new transcription");

    try {
      const audioUrl = await deps.client.storage.upload(
        new File([audioBuffer], "audio.wav", { type: contentType }),
      );
      logger.info({ audioUrl }, "Audio uploaded to FAL storage");

      const result = await deps.client.subscribe("fal-ai/wizper", {
        input: { audio_url: audioUrl },
      });

      const chunks = TranscriptionChunkSchema.array().safeParse(
        result.data?.chunks ?? [],
      );
      if (!result.data?.text || !chunks.success) {
        logger.error({ result }, "No usable transcription in response");
        return c.json({ error: "Failed to transcribe audio" }, 400);
      }

      const transcriptionResult = {
        transcription: result.data.text,
        chunks: chunks.data,
      };
      logger.info(
        {
          chars: transcriptionResult.transcription.length,
          chunks: transcriptionResult.chunks.length,
        },
        "Transcription generated successfully",
      );

      await ensureDir(deps.cacheDir);
      await Deno.writeTextFile(cachePath, JSON.stringify(transcriptionResult));
      logger.info({ path: cachePath }, "Transcription cached");

      return c.json(formatResponse(transcriptionResult, responseType), 200);
    } catch (error) {
      logger.error({ error }, "Transcription failed");
      return c.json({ error: "Failed to transcribe audio" }, 500);
    }
  };

  return { transcribeVoice };
}
