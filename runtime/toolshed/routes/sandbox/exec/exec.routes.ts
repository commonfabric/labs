import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

const tags = ["Sandbox"];

const SandboxExecRequestSchema = z.object({
  sandboxId: z.string().min(1).describe("Sandbox identifier"),
  command: z.string().min(1).describe("The bash command to execute"),
  workingDirectory: z.string().optional().describe(
    "Working directory for the command",
  ),
  timeout: z.number().min(1000).max(300000).default(60000).describe(
    "Timeout in milliseconds",
  ),
  environment: z.record(z.string(), z.string()).optional().describe(
    "Additional environment variables as key-value pairs",
  ),
});

const SandboxExecResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
});

export const sandboxExec = createRoute({
  path: "/api/sandbox/exec",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: SandboxExecRequestSchema.openapi({
            example: {
              sandboxId: "omnibot-abc123",
              command: "echo hello",
              timeout: 60000,
            },
          }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: SandboxExecResultSchema,
        },
      },
      description: "Command execution result",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Invalid request parameters",
    },
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Error executing command",
    },
  },
});

export type SandboxExecRoute = typeof sandboxExec;
