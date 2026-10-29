/**
 * The `search_skills` tool: metadata-only discovery over a configured
 * skills.sh registry.
 *
 * The hit type has no field for skill text and that absence is the boundary.
 * A hit can be named to the operator or handed to a later pinned acquisition
 * step; this tool cannot fetch, read, or load the skill itself.
 */

import type { JSONSchema } from "@commonfabric/api";

import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type {
  SkillsShSearchClient,
  SkillsShSearchHit,
} from "../skills-sh/search-client.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface SearchSkillsToolInput {
  query: string;
  owner?: string;
  limit?: number;
}

export interface SearchSkillsToolSuccessOutput {
  outputId: string;
  status: "ok";
  hits: readonly SkillsShSearchHit[];
  rejected: number;
}

export interface SearchSkillsToolErrorOutput {
  outputId: string;
  status: "error";
  message: string;
}

export type SearchSkillsToolOutput =
  | SearchSkillsToolSuccessOutput
  | SearchSkillsToolErrorOutput;

export const searchSkillsToolDescriptor: HarnessToolDescriptor = {
  toolId: "search_skills",
  title: "Search Skills",
  description:
    "Search the configured skills.sh registry for candidate skills. Returns metadata only: id, name, source, installs, and a rejected-entry count. Registry-reported installs are unauthenticated telemetry and unverifiable, not a trust signal. A result can name a skill to the operator or to a later acquisition step; this tool cannot fetch, read, or load skill content. Its results are not authoritative about what exists: the registry indexes some repositories and not others, so a skill named by an exact id can be acquired whether or not a search returns it.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search text of at least two characters.",
      },
      owner: {
        type: "string",
        description: "Optional registry owner to restrict results to.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        description:
          "Maximum hits to return. Values above the registry client cap return the capped result set.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    oneOf: [{
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["ok"] },
        hits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              source: { type: "string" },
              installs: { type: "number", minimum: 0 },
            },
            required: ["id", "name", "source"],
            additionalProperties: false,
          },
        },
        rejected: { type: "integer", minimum: 0 },
      },
      required: ["outputId", "status", "hits", "rejected"],
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
  tags: ["skill", "search", "registry"],
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const searchSkillsTool: HarnessToolDefinition<
  SearchSkillsToolInput,
  SearchSkillsToolOutput
> = {
  descriptor: searchSkillsToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("search_skills");
    const errorOutput = (message: string): SearchSkillsToolErrorOutput => ({
      outputId,
      status: "error",
      message,
    });
    if (context.getSkillsShSearchClient === undefined) {
      return errorOutput(
        "search_skills requires a skills registry; configure --skills-registry-url",
      );
    }

    let client: SkillsShSearchClient;
    try {
      client = await context.getSkillsShSearchClient();
    } catch (error) {
      return errorOutput(
        `skills.sh registry unavailable: ${errorMessage(error)}`,
      );
    }
    try {
      const result = await client.search({
        query: input.query,
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      return {
        outputId,
        status: "ok",
        hits: result.hits,
        rejected: result.rejected,
      };
    } catch (error) {
      return errorOutput(errorMessage(error));
    }
  },
};
