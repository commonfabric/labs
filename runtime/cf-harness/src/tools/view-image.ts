import {
  cfcObservationFitsCeiling,
  type IFCLabel,
} from "@commonfabric/runner/cfc";
import { mergeConfidentialityOnlyLabels } from "../contracts/cfc-model-context.ts";
import type { JSONSchema } from "@commonfabric/api";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { isObjectOrArray } from "@commonfabric/js-values/types";
import type { HarnessImageAttachment } from "../contracts/image.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import {
  createHarnessImageAttachment,
  MAX_IMAGE_ATTACHMENT_BYTES,
} from "../image-attachments.ts";
import type { HarnessToolDefinition } from "./types.ts";
import {
  classifyFileToolShellFailure,
  classifyPathResolutionError,
  createStructuredFileToolErrorOutput,
  type StructuredFileToolErrorOutput,
  structuredFileToolErrorOutputSchema,
} from "./file-errors.ts";
import {
  isResolvedPathInsideArtifactRoot,
  RESERVED_ARTIFACT_PATH_DETAIL,
} from "./reserved-artifacts.ts";

export interface ViewImageToolInput {
  path: string;
}

export interface ViewImageToolSuccessOutput {
  outputId: string;
  path: string;
  mediaType: HarnessImageAttachment["mediaType"];
  bytes: number;
  digest: string;
  imageAttachment: HarnessImageAttachment;
  /** Present (including an empty public label) only for a mediated read. */
  sourceLabel?: IFCLabel;
}

export type ViewImageToolOutput =
  | ViewImageToolSuccessOutput
  | StructuredFileToolErrorOutput;

export const isViewImageToolSuccessOutput = (
  output: unknown,
): output is ViewImageToolSuccessOutput =>
  isObjectOrArray(output) &&
  "imageAttachment" in output &&
  isObjectOrArray(output.imageAttachment) &&
  "type" in output.imageAttachment &&
  output.imageAttachment.type === "cf-harness.image-attachment";

export const viewImageToolDescriptor: HarnessToolDescriptor = {
  toolId: "view_image",
  title: "View Image",
  description:
    "Attach an image file from the target VM to the next model turn. Supports PNG, JPEG, GIF, and WebP files inside the workspace.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
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
        mediaType: {
          type: "string",
          enum: ["image/gif", "image/jpeg", "image/png", "image/webp"],
        },
        bytes: { type: "integer", minimum: 1 },
        digest: { type: "string" },
        sourceLabel: { type: "object" },
        imageAttachment: {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "cf-harness.image-attachment",
            },
            hostPath: { type: "string" },
            mediaType: {
              type: "string",
              enum: ["image/gif", "image/jpeg", "image/png", "image/webp"],
            },
            bytes: { type: "integer", minimum: 1 },
            digest: { type: "string" },
            snapshotPath: { type: "string" },
          },
          required: ["type", "hostPath", "mediaType", "bytes", "digest"],
          additionalProperties: false,
        },
      },
      required: [
        "outputId",
        "path",
        "mediaType",
        "bytes",
        "digest",
        "imageAttachment",
      ],
      additionalProperties: false,
    }, structuredFileToolErrorOutputSchema],
  } satisfies JSONSchema,
  tags: ["file", "image", "read", "vision", "vm"],
};

export const viewImageTool: HarnessToolDefinition<
  ViewImageToolInput,
  ViewImageToolOutput
> = {
  descriptor: viewImageToolDescriptor,
  async invoke(context, input) {
    let resolvedPath: string;
    try {
      resolvedPath = context.resolvePath(input.path);
    } catch (error) {
      return createStructuredFileToolErrorOutput(context, "view_image", {
        path: input.path,
        code: classifyPathResolutionError(error),
        detail: describeFailure(error),
      });
    }
    if (await isResolvedPathInsideArtifactRoot(context, resolvedPath)) {
      return createStructuredFileToolErrorOutput(context, "view_image", {
        path: resolvedPath,
        code: "permission_denied",
        detail: RESERVED_ARTIFACT_PATH_DETAIL,
      });
    }
    let hostPath: string;
    let hostRootPath: string;
    try {
      hostPath = context.resolveHostPath(resolvedPath);
      hostRootPath = context.resolveHostRootPath(resolvedPath);
    } catch (error) {
      return createStructuredFileToolErrorOutput(context, "view_image", {
        path: resolvedPath,
        code: classifyPathResolutionError(error),
        detail: describeFailure(error),
      });
    }
    const command = [
      "set -o pipefail",
      'test -e "$1" || exit 10',
      'test -f "$1" || exit 11',
      'test -r "$1" || exit 13',
      `head -c ${MAX_IMAGE_ATTACHMENT_BYTES + 1} < "$1" | base64`,
    ].join("\n");
    const args = [resolvedPath];
    const cwd = context.currentDir;
    const result = await context.sandbox.runShell({
      command,
      args,
      cwd,
      cfcInvocationContext: await context.createCfcInvocationContext({
        toolId: "view_image",
        operation: "shell",
        command,
        args,
        cwd,
        cfcModelContextInputLabelPaths: [["args"]],
      }),
    });
    const withheld = () =>
      createStructuredFileToolErrorOutput(context, "view_image", {
        path: resolvedPath,
        code: "permission_denied",
        detail: "The sandbox did not release a complete image for this run.",
      });
    let observedBase64: string | undefined;
    let sourceLabel: IFCLabel | undefined;
    if (result.cfcResult !== undefined) {
      const { stdout, exitCode } = result.cfcResult;
      if (
        stdout.policy !== "observed" || stdout.truncated ||
        exitCode.policy !== "observed" || exitCode.value === null
      ) return withheld();
      // Keep the stream's integrity evidence with its pixels. Confidentiality
      // also covers the status and every segment used to assemble the frame.
      sourceLabel = {
        ...stdout.label,
        ...mergeConfidentialityOnlyLabels([
          stdout.label,
          exitCode.label,
          ...stdout.segments.map((segment) => segment.label),
        ]),
      };
      if (
        !cfcObservationFitsCeiling(
          sourceLabel.confidentiality ?? [],
          context.cfcReadMaxConfidentiality,
        )
      ) return withheld();
      if (exitCode.value !== 0) {
        if (sourceLabel.confidentiality?.length) return withheld();
        return createStructuredFileToolErrorOutput(context, "view_image", {
          path: resolvedPath,
          code: classifyFileToolShellFailure({
            exitCode: exitCode.value,
            stdout: "",
            stderr: "",
          }),
        });
      }
      observedBase64 = stdout.segments.map((segment) => segment.text).join("")
        .replace(/[\r\n]/g, "");
    } else if (
      context.cfcReadMaxConfidentiality !== undefined ||
      (context.cfcEnforcementMode !== "disabled" &&
        context.cfcEnforcementMode !== "observe")
    ) {
      return withheld();
    }
    try {
      const imageAttachment = await createHarnessImageAttachment({
        workspaceHostPath: hostRootPath,
        cwd: hostRootPath,
        path: hostPath,
        snapshotDir: context.imageAttachmentSnapshotDir,
        observedBase64,
      });
      return {
        outputId: context.nextOutputId("view_image"),
        path: resolvedPath,
        mediaType: imageAttachment.mediaType,
        bytes: imageAttachment.bytes,
        digest: imageAttachment.digest,
        imageAttachment,
        ...(sourceLabel === undefined ? {} : { sourceLabel }),
      };
    } catch (error) {
      const detail = describeFailure(error);
      if (sourceLabel !== undefined) {
        if (sourceLabel.confidentiality?.length) return withheld();
        const problem = [
          "path is empty",
          "path is too large",
          "not a supported image type",
        ].find((reason) => detail.includes(reason));
        if (problem === undefined) return withheld();
        return createStructuredFileToolErrorOutput(context, "view_image", {
          path: resolvedPath,
          code: "unknown",
          detail: problem,
        });
      }
      return createStructuredFileToolErrorOutput(context, "view_image", {
        path: resolvedPath,
        code: detail.includes("not a file")
          ? "not_a_file"
          : detail.includes("paths must stay within the workspace")
          ? "path_outside_workspace"
          : detail.includes("path is empty") ||
              detail.includes("path is too large") ||
              detail.includes("supported image type")
          ? "unknown"
          : "file_not_found",
        detail,
      });
    }
  },
};
