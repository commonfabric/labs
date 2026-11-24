import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

const tags = ["AI Image Generation"];

const ImageSizeEnum = z.enum([
  "square_hd",
  "square",
  "portrait_4_3",
  "portrait_16_9",
  "landscape_4_3",
  "landscape_16_9",
]);

export const generateImageAdvanced = createRoute({
  path: "/api/ai/img",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            prompt: z.string().min(1).describe(
              "The prompt to generate an image from",
            ),
            num_images: z.number().min(1).max(4).default(1)
              .describe("The number of images to generate"),
            image_size: ImageSizeEnum.default("landscape_4_3")
              .describe("The size of the generated image"),
            sync_mode: z.boolean().default(false)
              .describe("Wait for image generation before returning response"),
            guidance_scale: z.number().min(1).max(20).default(3.5)
              .describe("CFG scale for prompt adherence"),
            num_inference_steps: z.number().min(1).max(50).default(28)
              .describe("Number of inference steps to perform"),
            seed: z.number().optional()
              .describe("Seed for reproducible generation"),
            enable_safety_checker: z.boolean().default(true)
              .describe("Enable safety checker"),
          }).openapi({
            example: {
              prompt: "A cute chibi illustration of a cat with a hat",
              image_size: "square_hd",
              num_inference_steps: 30,
              guidance_scale: 7.5,
            },
          }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "image/webp": {
          schema: z.any().describe("Generated image binary data"),
        },
      },
      description: "Generated image response",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: "Invalid request parameters",
    },
  },
});

// Keep the existing GET route for simple usage
export const generateImage = createRoute({
  path: "/api/ai/img",
  method: "get",
  tags,
  request: {
    query: z.object({
      prompt: z
        .string()
        .describe("Text prompt to generate image from")
        .openapi({
          example: "cat with a hat",
        }),
      width: z.coerce.number().int().min(64).max(1024).optional()
        .describe("Optional generated image width in pixels"),
      height: z.coerce.number().int().min(64).max(1024).optional()
        .describe("Optional generated image height in pixels"),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "image/webp": {
          schema: z.any().describe("Generated image binary data"),
        },
      },
      description: "Generated image response",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: "Invalid request parameters",
    },
  },
});

export type GenerateImageRoute = typeof generateImage;
export type GenerateImageAdvancedRoute = typeof generateImageAdvanced;
