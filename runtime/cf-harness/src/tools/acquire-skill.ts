/**
 * The `acquire_skill` tool: resolve a discovery id to a GitHub commit, enforce
 * the tree whitelist, and durably return only a handle.
 *
 * The handle names the instructions and nothing else. A skill's scripts are
 * acquired beside them and stay host-side, so what a chooser can hand onward
 * is still the prose it never read.
 */

import type { JSONSchema } from "@commonfabric/api";
import { stampExternalFetchIngest } from "@commonfabric/runner/cfc";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";

import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import {
  SkillsShAcquisitionError,
  type SkillsShAcquisitionFailureCode,
} from "../skills-sh/acquisition.ts";
import {
  type SkillsShPinnedAddress,
  SkillsShPinResolutionError,
} from "../skills-sh/pin.ts";
import { sanitizeRegistryString } from "../skills-sh/search-client.ts";
import { AcquiredSkillDirectoryReadableError } from "../skills/acquired-skill-mount.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface AcquireSkillToolInput {
  readonly id: string;
}

export interface AcquireSkillToolLoadedOutput {
  readonly outputId: string;
  readonly status: "loaded";
  readonly skillHandle: string;
  readonly pin: SkillsShPinnedAddress;
  readonly loaded: {
    readonly skillRoot: string;

    /**
     * Every path the acquisition admitted, `SKILL.md` first and the skill's
     * scripts after it. What the model is told it now holds: the instructions
     * reach it through the handle, and a script is something the operator's
     * allowlist decides whether it may run.
     */
    readonly paths: readonly string[];
    readonly sourceUrl: string;
    readonly verification: "git-commit-sha";
    readonly valueDigest: string;
    readonly receivedAt: string;
  };
}

export interface AcquireSkillToolRefusedOutput {
  readonly outputId: string;
  readonly status: "refused";
  readonly reason: {
    readonly code: string;
    readonly message: string;
  };
  readonly pin?: SkillsShPinnedAddress;
  readonly offendingCount?: number;
  readonly offendingPaths?: readonly string[];
  readonly candidatePaths?: readonly string[];
}

export interface AcquireSkillToolErrorOutput {
  readonly outputId: string;
  readonly status: "error";
  readonly message: string;
}

export type AcquireSkillToolOutput =
  | AcquireSkillToolLoadedOutput
  | AcquireSkillToolRefusedOutput
  | AcquireSkillToolErrorOutput;

const pinnedAddressSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    owner: { type: "string" },
    repo: { type: "string" },
    slug: { type: "string" },
    commitSha: { type: "string" },
    resolvedAt: { type: "string" },
  },
  required: ["id", "owner", "repo", "slug", "commitSha", "resolvedAt"],
  additionalProperties: false,
} satisfies JSONSchema;

export const acquireSkillToolDescriptor: HarnessToolDescriptor = {
  toolId: "acquire_skill",
  title: "Acquire Skill",
  description:
    "Acquire a skill by its exact id, from the commit its repository's default branch points at, after checking the complete recursive listing. The id need not appear in search_skills results: a skill can be real and unlisted, so a search that does not return it is not evidence it does not exist, and an id a person named is acquired by that id rather than searched for first. The parent never receives skill text: a loaded result carries a handle only. A refusal is an expected outcome with its reason and offending paths as inert metadata; do not retry around it. Acquisition grants no permission and loads nothing into the parent. Loading the handle into a child is a separate later delegate_task decision.",
  effectClass: "write",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          "An exact skill id in owner/repository/slug form. It names a skill directly: search_skills is one way to find one, and this tool does not require the id to have come from it. An id a person gave you is acquired by that id.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    oneOf: [{
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["loaded"] },
        skillHandle: { type: "string" },
        pin: pinnedAddressSchema,
        loaded: {
          type: "object",
          properties: {
            skillRoot: { type: "string" },
            paths: { type: "array", items: { type: "string" } },
            sourceUrl: { type: "string" },
            verification: { type: "string", enum: ["git-commit-sha"] },
            valueDigest: { type: "string" },
            receivedAt: { type: "string" },
          },
          required: [
            "skillRoot",
            "paths",
            "sourceUrl",
            "verification",
            "valueDigest",
            "receivedAt",
          ],
          additionalProperties: false,
        },
      },
      required: ["outputId", "status", "skillHandle", "pin", "loaded"],
      additionalProperties: false,
    }, {
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["refused"] },
        reason: {
          type: "object",
          properties: {
            code: { type: "string" },
            message: { type: "string" },
          },
          required: ["code", "message"],
          additionalProperties: false,
        },
        pin: pinnedAddressSchema,
        offendingCount: { type: "integer", minimum: 0 },
        offendingPaths: { type: "array", items: { type: "string" } },
        candidatePaths: { type: "array", items: { type: "string" } },
      },
      required: ["outputId", "status", "reason"],
      additionalProperties: false,
    }, {
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["error"] },
        message: { type: "string" },
      },
      required: ["outputId", "status", "message"],
      additionalProperties: false,
    }],
  } satisfies JSONSchema,
  tags: ["skill", "acquisition", "handle", "external"],
};

const safeErrorMessage = (error: unknown): string =>
  sanitizeRegistryString(
    error instanceof Error ? error.message : String(error),
  );

const operationalAcquisitionCodes: ReadonlySet<
  SkillsShAcquisitionFailureCode
> = new Set(["request_failed", "http_error"]);

export const acquireSkillTool: HarnessToolDefinition<
  AcquireSkillToolInput,
  AcquireSkillToolOutput
> = {
  descriptor: acquireSkillToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("acquire_skill");
    const errorOutput = (message: string): AcquireSkillToolErrorOutput => ({
      outputId,
      status: "error",
      message,
    });
    if (context.getSkillsShAcquisitionClient === undefined) {
      return errorOutput(
        "acquire_skill requires a skills registry; configure --skills-registry-url",
      );
    }
    if (context.getFabricSession === undefined) {
      return errorOutput("acquire_skill requires a configured fabric session");
    }
    if (context.mintSkillContextHandle === undefined) {
      return errorOutput(
        "acquire_skill requires the host skill-context handle mint",
      );
    }

    let pin: SkillsShPinnedAddress | undefined;
    try {
      const client = await context.getSkillsShAcquisitionClient();
      const resolvedPin = await client.resolvePin(input.id, {
        now: context.now,
      });
      pin = resolvedPin;
      const acquired = await client.acquirePin(resolvedPin);
      const session = await context.getFabricSession();
      const { pieces } = session;
      const runtime = pieces.runtime;
      const space = pieces.getSpace();
      const receivedAt = context.now();
      const cell = runtime.getCell(
        space,
        `external-skill:${context.runId}:${outputId}`,
        {} as const,
      );
      const link = cell.getAsNormalizedFullLink();
      const { error } = await runtime.editWithRetry((tx) => {
        cell.withTx(tx).set(acquired.text);
        stampExternalFetchIngest(tx, {
          pinnedSource: {
            url: acquired.sourceUrl,
            commitSha: resolvedPin.commitSha,
          },
          receivedAt,
          valueDigest: acquired.valueDigest,
          target: {
            space,
            id: link.id,
            scope: link.scope,
            path: link.path,
          },
        });
      });
      if (error !== undefined) {
        return errorOutput(
          `acquire_skill could not write the skill handle: ${
            safeErrorMessage(error)
          }`,
        );
      }
      await runtime.idle();
      // The scripts are written before the handle is minted, so a refusal
      // here — a mount of this run's sandbox covering the directory they
      // would land in — leaves no handle to a skill whose scripts the
      // acquiring run could read. That is a different boundary from the one
      // CT-2302 forces a sidestep on: this is who may READ the bytes, which
      // is the property the hostile-skill receipt rests on.
      //
      // `loadedPaths` already names them, so what the model is told it holds
      // does not change shape: the handle still carries the instructions, and
      // the scripts are something the operator's allowlist decides about.
      if (acquired.scripts.length > 0) {
        if (context.materializeAcquiredSkill === undefined) {
          return errorOutput(
            "acquire_skill cannot hold this skill's scripts: the run writes no artifacts",
          );
        }
        try {
          await context.materializeAcquiredSkill({
            registryId: resolvedPin.id,
            commitSha: resolvedPin.commitSha,
            scripts: acquired.scripts.map((script) => ({
              path: script.path,
              bytes: script.bytes,
              valueDigest: script.valueDigest,
            })),
          });
        } catch (error) {
          // A mount covering the directory is a policy answer about who could
          // read the bytes, not a failure to write them, so it comes back as a
          // refusal naming the mount rather than as an error.
          if (error instanceof AcquiredSkillDirectoryReadableError) {
            return {
              outputId,
              status: "refused",
              reason: {
                code: AcquiredSkillDirectoryReadableError.code,
                message: safeErrorMessage(error),
              },
              pin: resolvedPin,
            };
          }
          return errorOutput(
            `acquire_skill could not hold this skill's scripts: ${
              safeErrorMessage(error)
            }`,
          );
        }
      }
      // The same host-observed facts the mark on the write carries, kept on
      // the handle entry as well: the mark travels with the cell and the
      // entry travels with the token, and it is the token a later delegation
      // resolves when it writes the child's activation record.
      const skillHandle = await context.mintSkillContextHandle(
        createLLMFriendlyLink(link, space),
        {
          registryId: resolvedPin.id,
          commitSha: resolvedPin.commitSha,
          sourceUrl: acquired.sourceUrl,
          verification: "git-commit-sha",
          valueDigest: acquired.valueDigest,
          receivedAt,
        },
      );
      return {
        outputId,
        status: "loaded",
        skillHandle,
        pin,
        loaded: {
          skillRoot: acquired.skillRoot,
          paths: acquired.loadedPaths,
          sourceUrl: acquired.sourceUrl,
          verification: "git-commit-sha",
          valueDigest: acquired.valueDigest,
          receivedAt,
        },
      };
    } catch (error) {
      if (error instanceof SkillsShAcquisitionError) {
        if (operationalAcquisitionCodes.has(error.code)) {
          return errorOutput(safeErrorMessage(error));
        }
        return {
          outputId,
          status: "refused",
          reason: { code: error.code, message: safeErrorMessage(error) },
          ...(pin !== undefined ? { pin } : {}),
          ...(error.offendingCount !== undefined
            ? { offendingCount: error.offendingCount }
            : {}),
          ...(error.offendingPaths !== undefined
            ? { offendingPaths: error.offendingPaths }
            : {}),
          ...(error.candidatePaths !== undefined
            ? { candidatePaths: error.candidatePaths }
            : {}),
        };
      }
      if (error instanceof SkillsShPinResolutionError) {
        if (error.code === "request_failed" || error.code === "http_error") {
          return errorOutput(safeErrorMessage(error));
        }
        return {
          outputId,
          status: "refused",
          reason: { code: error.code, message: safeErrorMessage(error) },
        };
      }
      return errorOutput(`acquire_skill failed: ${safeErrorMessage(error)}`);
    }
  },
};
