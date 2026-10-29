import type { JSONSchema } from "@commonfabric/api";
import { isObjectOrArray } from "@commonfabric/utils/types";
import type { HarnessImageAttachment } from "../contracts/image.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import { createHarnessImageAttachment } from "../image-attachments.ts";
import type { HarnessToolDefinition } from "./types.ts";
import {
  classifyPathResolutionError,
  createStructuredFileToolErrorOutput,
  detailFromUnknownError,
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
        detail: detailFromUnknownError(error),
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
        detail: detailFromUnknownError(error),
      });
    }
    try {
      const imageAttachment = await createHarnessImageAttachment({
        workspaceHostPath: hostRootPath,
        cwd: hostRootPath,
        path: hostPath,
        snapshotDir: context.imageAttachmentSnapshotDir,
      });
      return {
        outputId: context.nextOutputId("view_image"),
        path: resolvedPath,
        mediaType: imageAttachment.mediaType,
        bytes: imageAttachment.bytes,
        digest: imageAttachment.digest,
        imageAttachment,
      };
    } catch (error) {
      const detail = detailFromUnknownError(error);
      return createStructuredFileToolErrorOutput(context, "view_image", {
        path: resolvedPath,
        code: detail.includes("not a file")
          ? "not_a_file"
          : detail.includes("paths must stay within the workspace")
          ? "path_outside_workspace"
          : detail.includes("path is not a file")
          ? "not_a_file"
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
