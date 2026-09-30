import type { JSONSchema } from "@commonfabric/api";
import type { CfcSandboxResult } from "@commonfabric/runner/cfc";
import { isObjectOrArray } from "@commonfabric/utils/types";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { HarnessToolDefinition } from "./types.ts";
import {
  classifyFileToolShellFailure,
  classifyPathResolutionError,
  createStructuredFileToolErrorOutput,
  detailFromShellFailure,
  detailFromUnknownError,
  type StructuredFileToolErrorOutput,
  structuredFileToolErrorOutputSchema,
} from "./file-errors.ts";
import {
  isResolvedPathInsideArtifactRoot,
  RESERVED_ARTIFACT_PATH_DETAIL,
} from "./reserved-artifacts.ts";

export interface ReadFileToolInput {
  path: string;
  encoding?: "utf-8";
  maxBytes?: number;
}

export interface ReadFileToolSuccessOutput {
  outputId: string;
  path: string;
  content: string;
  cfcResult?: CfcSandboxResult;
}

export type ReadFileToolOutput =
  | ReadFileToolSuccessOutput
  | StructuredFileToolErrorOutput;

export const readFileToolDescriptor: HarnessToolDescriptor = {
  toolId: "read_file",
  title: "Read File",
  description:
    "Read a file from the target VM through a structured file-read path.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      encoding: { type: "string", enum: ["utf-8"] },
      maxBytes: { type: "integer", minimum: 0 },
    },
    required: ["path"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    oneOf: [{
      type: "object",
      properties: {
        outputId: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
        cfcResult: { type: "object" },
      },
      required: ["outputId", "path", "content"],
      additionalProperties: false,
    }, structuredFileToolErrorOutputSchema],
  } satisfies JSONSchema,
  tags: ["file", "read", "vm"],
};

export const isReadFileToolSuccessOutput = (
  output: unknown,
): output is ReadFileToolSuccessOutput =>
  isObjectOrArray(output) &&
  "outputId" in output &&
  typeof output.outputId === "string" &&
  "path" in output &&
  typeof output.path === "string" &&
  "content" in output &&
  typeof output.content === "string";

export const readFileTool: HarnessToolDefinition<
  ReadFileToolInput,
  ReadFileToolOutput
> = {
  descriptor: readFileToolDescriptor,
  async invoke(context, input) {
    if (
      input.maxBytes !== undefined &&
      (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0)
    ) {
      throw new Error("read_file maxBytes must be a non-negative integer");
    }
    let resolvedPath: string;
    try {
      resolvedPath = context.resolvePath(input.path);
    } catch (error) {
      return createStructuredFileToolErrorOutput(context, "read_file", {
        path: input.path,
        code: classifyPathResolutionError(error),
        detail: detailFromUnknownError(error),
      });
    }
    if (await isResolvedPathInsideArtifactRoot(context, resolvedPath)) {
      return createStructuredFileToolErrorOutput(context, "read_file", {
        path: resolvedPath,
        code: "permission_denied",
        detail: RESERVED_ARTIFACT_PATH_DETAIL,
      });
    }
    const command = [
      "set -eu",
      'if [ ! -e "$1" ]; then',
      '  echo "file not found: $1" >&2',
      "  exit 10",
      "fi",
      'if [ ! -f "$1" ]; then',
      '  echo "not a file: $1" >&2',
      "  exit 11",
      "fi",
      'if [ -n "$2" ]; then',
      '  exec head -c "$2" "$1"',
      "fi",
      'exec cat "$1"',
    ].join("\n");
    const args = [
      resolvedPath,
      input.maxBytes !== undefined ? String(input.maxBytes) : "",
    ];
    const result = await context.sandbox.runShell({
      command,
      args,
      cwd: context.currentDir,
      cfcInvocationContext: await context.createCfcInvocationContext({
        toolId: "read_file",
        operation: "shell",
        cwd: context.currentDir,
        command,
        args,
        // read_file is a trusted selector: successful file bytes are mediated
        // by their own CFC result, not by direct prompt influence on the path.
        // If prior observed output influenced the model's selected path, carry
        // that accumulated model-context label onto the invocation args.
        cfcModelContextInputLabelPaths: [["args"]],
      }),
    });
    if (result.exitCode !== 0) {
      return createStructuredFileToolErrorOutput(context, "read_file", {
        path: resolvedPath,
        code: classifyFileToolShellFailure(result),
        detail: detailFromShellFailure(result),
        exitCode: result.exitCode,
      });
    }
    return {
      outputId: context.nextOutputId("read_file"),
      path: resolvedPath,
      content: result.stdout,
      ...(result.cfcResult !== undefined
        ? { cfcResult: result.cfcResult }
        : {}),
    };
  },
};
