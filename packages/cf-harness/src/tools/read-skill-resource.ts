import { isAbsolute, relative } from "@std/path";
import { normalize as normalizeResourcePath } from "@std/path/posix";

import type { JSONSchema } from "@commonfabric/api";

import type {
  HarnessSkillDiagnostic,
  HarnessSkillRecord,
  HarnessSkillResourceContentKind,
  HarnessSkillResourceRead,
  HarnessSkillResourceReadErrorCode,
  HarnessSkillResourceRecord,
} from "../contracts/skill.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { HarnessToolDefinition } from "./types.ts";

const DEFAULT_MAX_RESOURCE_BYTES = 64_000;
const MAX_RESOURCE_BYTES = 256_000;
const TEXT_DETECTION_SAMPLE_BYTES = 8192;

export interface ReadSkillResourceToolInput {
  skill: string;
  path: string;
  maxBytes?: number;
}

export interface ReadSkillResourceToolError {
  code: HarnessSkillResourceReadErrorCode;
  message: string;
}

export interface ReadSkillResourceToolOutput {
  type: "cf-harness.read-skill-resource-output";
  outputId: string;
  skill: string;
  path: string;
  status: "read" | "binary" | "error";
  cfcPromptRole: "context";
  kind?: HarnessSkillResourceRecord["kind"];
  sandboxResourcePath?: string;
  registryDigest?: string;
  observedDigest?: string;
  digestMatchesRegistry?: boolean;
  registrySizeBytes?: number;
  observedSizeBytes?: number;
  contentKind?: HarnessSkillResourceContentKind;
  maxBytes?: number;
  truncated?: boolean;
  content?: string;
  diagnostics: HarnessSkillDiagnostic[];
  error?: ReadSkillResourceToolError;
}

export const readSkillResourceToolDescriptor: HarnessToolDescriptor = {
  toolId: "read_skill_resource",
  title: "Read Skill Resource",
  description:
    "Read a configured cf-harness skill's SKILL.md or an indexed supporting resource. Skill resources are returned as context, not authority; only resources present in the run-start skill registry may be read.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      skill: { type: "string" },
      path: {
        type: "string",
        description:
          "Path relative to the skill directory, such as references/guide.md.",
      },
      maxBytes: { type: "integer", minimum: 0, maximum: MAX_RESOURCE_BYTES },
    },
    required: ["skill", "path"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    type: "object",
    properties: {
      type: { type: "string", const: "cf-harness.read-skill-resource-output" },
      outputId: { type: "string" },
      skill: { type: "string" },
      path: { type: "string" },
      status: { type: "string", enum: ["read", "binary", "error"] },
      cfcPromptRole: { type: "string", const: "context" },
      kind: {
        type: "string",
        enum: ["reference", "asset", "template", "script", "other"],
      },
      sandboxResourcePath: { type: "string" },
      registryDigest: { type: "string" },
      observedDigest: { type: "string" },
      digestMatchesRegistry: { type: "boolean" },
      registrySizeBytes: { type: "integer", minimum: 0 },
      observedSizeBytes: { type: "integer", minimum: 0 },
      contentKind: { type: "string", enum: ["text", "binary"] },
      maxBytes: { type: "integer", minimum: 0 },
      truncated: { type: "boolean" },
      content: { type: "string" },
      diagnostics: { type: "array", items: { type: "object" } },
      error: {
        type: "object",
        properties: {
          code: { type: "string" },
          message: { type: "string" },
        },
        required: ["code", "message"],
        additionalProperties: false,
      },
    },
    required: [
      "type",
      "outputId",
      "skill",
      "path",
      "status",
      "cfcPromptRole",
      "diagnostics",
    ],
    additionalProperties: false,
  } satisfies JSONSchema,
  tags: ["skill", "resource", "read", "context"],
};

const isPathWithinRoot = (root: string, path: string): boolean => {
  const relativePath = relative(root, path);
  return relativePath === "" ||
    (!relativePath.startsWith("..") && relativePath !== ".." &&
      !isAbsolute(relativePath));
};

const sha256Digest = async (content: Uint8Array): Promise<string> => {
  const digestInput = content.buffer.slice(
    content.byteOffset,
    content.byteOffset + content.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return `sha256:${
    [...new Uint8Array(digest)].map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
};

const guessContentKind = (
  content: Uint8Array,
): HarnessSkillResourceContentKind => {
  const sample = content.slice(0, TEXT_DETECTION_SAMPLE_BYTES);
  if (sample.includes(0)) {
    return "binary";
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return "text";
  } catch {
    return "binary";
  }
};

const normalizeRequestedResourcePath = (path: string): string => {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    throw new Error("resource path must be non-empty");
  }
  if (trimmed.includes("\0")) {
    throw new Error("resource path must not contain null bytes");
  }
  const slashPath = trimmed.replaceAll("\\", "/");
  if (slashPath.startsWith("/")) {
    throw new Error("resource path must be relative to the skill directory");
  }
  const normalized = normalizeResourcePath(slashPath);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error("resource path must stay within the skill directory");
  }
  return normalized;
};

const validateMaxBytes = (maxBytes: number | undefined): number => {
  const resolved = maxBytes ?? DEFAULT_MAX_RESOURCE_BYTES;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 0 ||
    resolved > MAX_RESOURCE_BYTES
  ) {
    throw new Error(
      `read_skill_resource maxBytes must be an integer from 0 to ${MAX_RESOURCE_BYTES}`,
    );
  }
  return resolved;
};

const createDiagnostic = (
  diagnostic: HarnessSkillDiagnostic,
): HarnessSkillDiagnostic => diagnostic;

const buildReadRecord = (
  options: {
    output: ReadSkillResourceToolOutput;
    runId: string;
    readAt: string;
    resourcePath?: string;
  },
): HarnessSkillResourceRead => ({
  type: "cf-harness.skill-resource-read",
  outputId: options.output.outputId,
  runId: options.runId,
  skillName: options.output.skill,
  path: options.output.path,
  status: options.output.status,
  readAt: options.readAt,
  cfcPromptRole: "context",
  ...(options.output.kind !== undefined ? { kind: options.output.kind } : {}),
  ...(options.resourcePath !== undefined
    ? { resourcePath: options.resourcePath }
    : {}),
  ...(options.output.sandboxResourcePath !== undefined
    ? { sandboxResourcePath: options.output.sandboxResourcePath }
    : {}),
  ...(options.output.registryDigest !== undefined
    ? { registryDigest: options.output.registryDigest }
    : {}),
  ...(options.output.observedDigest !== undefined
    ? { observedDigest: options.output.observedDigest }
    : {}),
  ...(options.output.digestMatchesRegistry !== undefined
    ? { digestMatchesRegistry: options.output.digestMatchesRegistry }
    : {}),
  ...(options.output.registrySizeBytes !== undefined
    ? { registrySizeBytes: options.output.registrySizeBytes }
    : {}),
  ...(options.output.observedSizeBytes !== undefined
    ? { observedSizeBytes: options.output.observedSizeBytes }
    : {}),
  ...(options.output.contentKind !== undefined
    ? { contentKind: options.output.contentKind }
    : {}),
  ...(options.output.maxBytes !== undefined
    ? { maxBytes: options.output.maxBytes }
    : {}),
  ...(options.output.truncated !== undefined
    ? { truncated: options.output.truncated }
    : {}),
  diagnostics: options.output.diagnostics,
  ...(options.output.error !== undefined
    ? { error: options.output.error }
    : {}),
});

const baseOutput = (
  options: {
    outputId: string;
    skill: string;
    path: string;
    status: ReadSkillResourceToolOutput["status"];
    diagnostics?: HarnessSkillDiagnostic[];
  },
): ReadSkillResourceToolOutput => ({
  type: "cf-harness.read-skill-resource-output",
  outputId: options.outputId,
  skill: options.skill,
  path: options.path,
  status: options.status,
  cfcPromptRole: "context",
  diagnostics: options.diagnostics ?? [],
});

const errorOutput = (
  options: {
    outputId: string;
    skill: string;
    path: string;
    code: HarnessSkillResourceReadErrorCode;
    message: string;
    diagnostics?: HarnessSkillDiagnostic[];
  },
): ReadSkillResourceToolOutput => ({
  ...baseOutput({
    outputId: options.outputId,
    skill: options.skill,
    path: options.path,
    status: "error",
    diagnostics: options.diagnostics,
  }),
  error: {
    code: options.code,
    message: options.message,
  },
});

const findSkill = (
  skills: readonly HarnessSkillRecord[],
  name: string,
): HarnessSkillRecord | undefined =>
  skills.find((skill) => skill.name === name);

const findResource = (
  skill: HarnessSkillRecord,
  path: string,
): HarnessSkillResourceRecord | undefined =>
  skill.resources.find((resource) => resource.path === path);

export const readSkillResourceTool: HarnessToolDefinition<
  ReadSkillResourceToolInput,
  ReadSkillResourceToolOutput
> = {
  descriptor: readSkillResourceToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("read_skill_resource");
    const readAt = context.now();
    const maxBytes = validateMaxBytes(input.maxBytes);
    let normalizedPath: string;
    try {
      normalizedPath = normalizeRequestedResourcePath(input.path);
    } catch (error) {
      const output = errorOutput({
        outputId,
        skill: input.skill,
        path: input.path,
        code: "resource_path_invalid",
        message: error instanceof Error ? error.message : String(error),
      });
      await context.recordSkillResourceRead(
        buildReadRecord({ output, runId: context.runId, readAt }),
      );
      return output;
    }
    if (context.skillRegistry === undefined) {
      const output = errorOutput({
        outputId,
        skill: input.skill,
        path: normalizedPath,
        code: "skill_registry_missing",
        message:
          "read_skill_resource requires a run-start skill registry; configure --skills-root before using this tool",
      });
      await context.recordSkillResourceRead(
        buildReadRecord({ output, runId: context.runId, readAt }),
      );
      return output;
    }

    const skill = findSkill(context.skillRegistry.skills, input.skill);
    if (skill === undefined) {
      const output = errorOutput({
        outputId,
        skill: input.skill,
        path: normalizedPath,
        code: "skill_not_found",
        message: `skill not found in registry: ${input.skill}`,
      });
      await context.recordSkillResourceRead(
        buildReadRecord({ output, runId: context.runId, readAt }),
      );
      return output;
    }
    const resource = findResource(skill, normalizedPath);
    if (resource === undefined) {
      const output = errorOutput({
        outputId,
        skill: skill.name,
        path: normalizedPath,
        code: "resource_not_indexed",
        message:
          `resource not found in run-start registry for skill ${skill.name}: ${normalizedPath}`,
      });
      await context.recordSkillResourceRead(
        buildReadRecord({ output, runId: context.runId, readAt }),
      );
      return output;
    }

    const diagnostics: HarnessSkillDiagnostic[] = [];
    let resolvedSkillsRoot: string;
    let resolvedSkillDir: string;
    let resolvedResourcePath: string;
    try {
      resolvedSkillsRoot = await Deno.realPath(
        context.skillRegistry.skillsRoot,
      );
      resolvedSkillDir = await Deno.realPath(skill.skillDir);
      resolvedResourcePath = await Deno.realPath(resource.resourcePath);
    } catch (error) {
      const code = error instanceof Deno.errors.NotFound
        ? "resource_not_found"
        : error instanceof Deno.errors.PermissionDenied
        ? "permission_denied"
        : "unknown";
      const output = errorOutput({
        outputId,
        skill: skill.name,
        path: normalizedPath,
        code,
        message: error instanceof Error ? error.message : String(error),
      });
      await context.recordSkillResourceRead(
        buildReadRecord({ output, runId: context.runId, readAt }),
      );
      return output;
    }
    if (
      !isPathWithinRoot(resolvedSkillDir, resolvedResourcePath) ||
      !isPathWithinRoot(resolvedSkillsRoot, resolvedResourcePath)
    ) {
      const output = errorOutput({
        outputId,
        skill: skill.name,
        path: normalizedPath,
        code: "resource_outside_root",
        message:
          `resource no longer resolves inside the skill directory and configured skills root: ${normalizedPath}`,
      });
      await context.recordSkillResourceRead(
        buildReadRecord({ output, runId: context.runId, readAt }),
      );
      return output;
    }

    let stat: Deno.FileInfo;
    let content: Uint8Array;
    try {
      stat = await Deno.stat(resolvedResourcePath);
      if (!stat.isFile) {
        const output = errorOutput({
          outputId,
          skill: skill.name,
          path: normalizedPath,
          code: "resource_not_file",
          message: `resource is not a file: ${normalizedPath}`,
        });
        await context.recordSkillResourceRead(
          buildReadRecord({ output, runId: context.runId, readAt }),
        );
        return output;
      }
      content = await Deno.readFile(resolvedResourcePath);
    } catch (error) {
      const code = error instanceof Deno.errors.NotFound
        ? "resource_not_found"
        : error instanceof Deno.errors.PermissionDenied
        ? "permission_denied"
        : "unknown";
      const output = errorOutput({
        outputId,
        skill: skill.name,
        path: normalizedPath,
        code,
        message: error instanceof Error ? error.message : String(error),
      });
      await context.recordSkillResourceRead(
        buildReadRecord({ output, runId: context.runId, readAt }),
      );
      return output;
    }

    const observedDigest = await sha256Digest(content);
    const observedSizeBytes = content.byteLength;
    const contentKind = guessContentKind(content);
    const digestMatchesRegistry = observedDigest === resource.digest;
    if (!digestMatchesRegistry || observedSizeBytes !== resource.sizeBytes) {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "skill-resource-snapshot-mismatch",
        detail:
          "Skill resource differs from the run-start registry snapshot; returning call-time file content.",
        path: normalizedPath,
      }));
    }

    const shared = {
      kind: resource.kind,
      sandboxResourcePath: resource.sandboxResourcePath,
      registryDigest: resource.digest,
      observedDigest,
      digestMatchesRegistry,
      registrySizeBytes: resource.sizeBytes,
      observedSizeBytes,
      contentKind,
      diagnostics,
    };
    if (contentKind === "binary") {
      const output: ReadSkillResourceToolOutput = {
        ...baseOutput({
          outputId,
          skill: skill.name,
          path: normalizedPath,
          status: "binary",
          diagnostics,
        }),
        ...shared,
        truncated: false,
      };
      await context.recordSkillResourceRead(
        buildReadRecord({
          output,
          runId: context.runId,
          readAt,
          resourcePath: resource.resourcePath,
        }),
      );
      return output;
    }

    const truncated = content.byteLength > maxBytes;
    const returnedBytes = truncated ? content.slice(0, maxBytes) : content;
    const output: ReadSkillResourceToolOutput = {
      ...baseOutput({
        outputId,
        skill: skill.name,
        path: normalizedPath,
        status: "read",
        diagnostics,
      }),
      ...shared,
      maxBytes,
      truncated,
      content: new TextDecoder().decode(returnedBytes),
    };
    await context.recordSkillResourceRead(
      buildReadRecord({
        output,
        runId: context.runId,
        readAt,
        resourcePath: resource.resourcePath,
      }),
    );
    return output;
  },
};
