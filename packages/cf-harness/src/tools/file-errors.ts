import type { JSONSchema } from "@commonfabric/api";
import { isObjectOrArray } from "@commonfabric/utils/types";
import type { HarnessToolContext } from "./types.ts";

export const STRUCTURED_FILE_TOOL_ERROR_CODES = [
  "file_not_found",
  "edit_conflict",
  "not_a_file",
  "permission_denied",
  "path_outside_workspace",
  "unknown",
] as const;

export type StructuredFileToolErrorCode =
  typeof STRUCTURED_FILE_TOOL_ERROR_CODES[number];

export interface StructuredFileToolError {
  type: "cf-harness.structured-file-tool-error";
  code: StructuredFileToolErrorCode;
  message: string;
  path: string;
  detail?: string;
  exitCode?: number;
}

export interface StructuredFileToolErrorOutput {
  outputId: string;
  path: string;
  ok: false;
  error: StructuredFileToolError;
}

export const structuredFileToolErrorSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "cf-harness.structured-file-tool-error",
    },
    code: {
      type: "string",
      enum: [...STRUCTURED_FILE_TOOL_ERROR_CODES],
    },
    message: { type: "string" },
    path: { type: "string" },
    detail: { type: "string" },
    exitCode: { type: "integer" },
  },
  required: ["type", "code", "message", "path"],
  additionalProperties: false,
} satisfies JSONSchema;

export const structuredFileToolErrorOutputSchema = {
  type: "object",
  properties: {
    outputId: { type: "string" },
    path: { type: "string" },
    ok: { type: "boolean", const: false },
    error: structuredFileToolErrorSchema,
  },
  required: ["outputId", "path", "ok", "error"],
  additionalProperties: false,
} satisfies JSONSchema;

export const isStructuredFileToolErrorOutput = (
  output: unknown,
): output is StructuredFileToolErrorOutput =>
  isObjectOrArray(output) &&
  "ok" in output &&
  output.ok === false &&
  "error" in output &&
  isObjectOrArray(output.error) &&
  "type" in output.error &&
  output.error.type === "cf-harness.structured-file-tool-error";

const messageForFileToolError = (
  code: StructuredFileToolErrorCode,
  path: string,
  detail?: string,
): string => {
  switch (code) {
    case "file_not_found":
      return `file not found: ${path}`;
    case "edit_conflict":
      return detail !== undefined && detail !== ""
        ? `edit conflict for ${path}: ${detail}`
        : `edit conflict for ${path}`;
    case "not_a_file":
      return `not a file: ${path}`;
    case "permission_denied":
      return `permission denied: ${path}`;
    case "path_outside_workspace":
      return `path outside workspace: ${path}`;
    case "unknown":
      return detail !== undefined && detail !== ""
        ? `file tool failed for ${path}: ${detail}`
        : `file tool failed for ${path}`;
  }
};

export const createStructuredFileToolErrorOutput = (
  context: HarnessToolContext,
  toolId: "read_file" | "view_image" | "write_file" | "edit_file",
  options: {
    outputId?: string;
    path: string;
    code: StructuredFileToolErrorCode;
    detail?: string;
    exitCode?: number;
  },
): StructuredFileToolErrorOutput => ({
  outputId: options.outputId ?? context.nextOutputId(toolId),
  path: options.path,
  ok: false,
  error: {
    type: "cf-harness.structured-file-tool-error",
    code: options.code,
    message: messageForFileToolError(
      options.code,
      options.path,
      options.detail,
    ),
    path: options.path,
    ...(options.detail !== undefined && options.detail !== ""
      ? { detail: options.detail }
      : {}),
    ...(options.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
  },
});

export const detailFromShellFailure = (
  result: { stdout: string; stderr: string; exitCode: number },
): string =>
  result.stderr.trim() || result.stdout.trim() ||
  `shell exited with code ${result.exitCode}`;

export const classifyFileToolShellFailure = (
  result: { stdout: string; stderr: string; exitCode: number },
): StructuredFileToolErrorCode => {
  const combined = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (
    result.exitCode === 10 ||
    combined.includes("file not found") ||
    combined.includes("no such file or directory")
  ) {
    return "file_not_found";
  }
  if (
    result.exitCode === 11 ||
    combined.includes("not a file") ||
    combined.includes("is a directory") ||
    combined.includes("not a directory")
  ) {
    return "not_a_file";
  }
  if (result.exitCode === 13 || combined.includes("permission denied")) {
    return "permission_denied";
  }
  return "unknown";
};

export const classifyPathResolutionError = (
  error: unknown,
): StructuredFileToolErrorCode => {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("path escapes workspace root")
    ? "path_outside_workspace"
    : "unknown";
};

export const detailFromUnknownError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
