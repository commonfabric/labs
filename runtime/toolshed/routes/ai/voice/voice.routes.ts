import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

const tags = ["AI Voice Transcription"];

export type TranscriptionChunk = {
  timestamp: [number, number];
  text: string;
};

const TranscriptionChunkSchema = z.object({
  timestamp: z.tuple([z.number(), z.number()]),
  text: z.string(),
}) satisfies z.ZodType<TranscriptionChunk>;

export const SuccessResponseSchema = z.discriminatedUnion("response_type", [
  z.object({
    response_type: z.literal("full"),
    transcription: z.string(),
    chunks: z.array(TranscriptionChunkSchema),
  }),
  z.object({
    response_type: z.literal("text"),
    transcription: z.string(),
  }),
  z.object({
    response_type: z.literal("chunks"),
    chunks: z.array(TranscriptionChunkSchema),
  }),
]);

export const ErrorResponseSchema = z.object({
  error: z.string(),
});

export const transcribeVoice = createRoute({
  path: "/api/ai/voice/transcribe",
  method: "post",
  tags,
  request: {
    query: z.object({
      response_type: z.enum(["full", "text", "chunks"]).default("full")
        .describe(
          "Type of response: full (default), text (transcription only), or chunks (timestamps only)",
        ),
    }),
    body: {
      content: {
        "audio/wav": {
          schema: z.any().describe("Raw audio data in WAV format"),
        },
        "audio/mpeg": {
          schema: z.any().describe("Raw audio data in MP3 format"),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: SuccessResponseSchema,
        },
      },
      description: "Transcribed voice response",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Invalid request parameters",
    },
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Server error",
    },
  },
});

export type TranscribeVoiceRoute = typeof transcribeVoice;
