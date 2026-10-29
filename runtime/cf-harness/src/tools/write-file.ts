import type { JSONSchema } from "@commonfabric/api";
import type { CfcLabelView } from "@commonfabric/runner/cfc";
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

export type WriteFileMode = "replace" | "append";

export interface WriteFileToolInput {
  path: string;
  content: string;
  mode?: WriteFileMode;
  createParents?: boolean;
  // Trusted harness/test plumbing for invocation input labels. This is omitted
  // from the public tool schema so model-authored tool calls do not mint labels.
  cfcInputLabels?: CfcLabelView;
}

export interface WriteFileToolSuccessOutput {
  outputId: string;
  path: string;
  mode: WriteFileMode;
}

export type WriteFileToolOutput =
  | WriteFileToolSuccessOutput
  | StructuredFileToolErrorOutput;

export const WRITE_FILE_MODES: readonly WriteFileMode[] = [
  "replace",
  "append",
];

export const writeFileToolDescriptor: HarnessToolDescriptor = {
  toolId: "write_file",
  title: "Write File",
  description:
    "Write or append file content inside the target VM through a structured file-write path.",
  effectClass: "write",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      mode: { type: "string", enum: [...WRITE_FILE_MODES] },
      createParents: { type: "boolean" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    oneOf: [{
      type: "object",
      properties: {
        outputId: { type: "string" },
        path: { type: "string" },
        mode: { type: "string", enum: [...WRITE_FILE_MODES] },
      },
      required: ["outputId", "path", "mode"],
      additionalProperties: false,
    }, structuredFileToolErrorOutputSchema],
  } satisfies JSONSchema,
  tags: ["file", "write", "vm"],
};

export const writeFileTool: HarnessToolDefinition<
  WriteFileToolInput,
  WriteFileToolOutput
> = {
  descriptor: writeFileToolDescriptor,
  async invoke(context, input) {
    let resolvedPath: string;
    try {
      resolvedPath = context.resolvePath(input.path);
    } catch (error) {
      return createStructuredFileToolErrorOutput(context, "write_file", {
        path: input.path,
        code: classifyPathResolutionError(error),
        detail: detailFromUnknownError(error),
      });
    }
    if (await isResolvedPathInsideArtifactRoot(context, resolvedPath)) {
      return createStructuredFileToolErrorOutput(context, "write_file", {
        path: resolvedPath,
        code: "permission_denied",
        detail: RESERVED_ARTIFACT_PATH_DETAIL,
      });
    }
    const mode = input.mode ?? "replace";
    const outputId = context.nextOutputId("write_file");
    const command = [
      "set -eu",
      'path="$1"',
      'mode="$2"',
      'create_parents="$3"',
      'parent="$(dirname "$path")"',
      'if [ "$create_parents" = "true" ]; then',
      '  mkdir -p "$parent"',
      'elif [ ! -d "$parent" ]; then',
      '  echo "file not found: parent directory $parent" >&2',
      "  exit 10",
      "fi",
      'if [ -e "$path" ] && [ ! -f "$path" ]; then',
      '  echo "not a file: $path" >&2',
      "  exit 11",
      "fi",
      'case "$mode" in',
      "  replace)",
      '    cat > "$path"',
      "    ;;",
      "  append)",
      '    cat >> "$path"',
      "    ;;",
      "  *)",
      '    echo "unsupported write mode: $mode" >&2',
      "    exit 12",
      "    ;;",
      "esac",
    ].join("\n");
    const args = [resolvedPath, mode, String(input.createParents ?? false)];
    const result = await context.sandbox.runShell({
      command,
      args,
      cwd: context.currentDir,
      stdinText: input.content,
      cfcInvocationContext: await context.createCfcInvocationContext({
        toolId: "write_file",
        toolOutputId: outputId,
        operation: "shell",
        cwd: context.currentDir,
        command,
        args,
        stdinText: input.content,
        ...(input.cfcInputLabels !== undefined
          ? { cfcInputLabels: input.cfcInputLabels }
          : {}),
        // write_file is a CFC sink: both the selected destination/mode args and
        // the bytes written on stdin are model-authored invocation inputs.
        cfcInputLabelPaths: [["args"], ["stdin"]],
      }),
    });
    if (result.exitCode !== 0) {
      return createStructuredFileToolErrorOutput(context, "write_file", {
        outputId,
        path: resolvedPath,
        code: classifyFileToolShellFailure(result),
        detail: detailFromShellFailure(result),
        exitCode: result.exitCode,
      });
    }
    return {
      outputId,
      path: resolvedPath,
      mode,
    };
  },
};
