import type {
  DelegateTaskToolInput,
  DelegateTaskToolOutput,
  HarnessSubagentProfile,
} from "../contracts/subagent.ts";
import {
  HARNESS_SUBAGENT_PROFILES,
  MAX_DELEGATE_PATTERN_REF_NOTE_LENGTH,
  MAX_DELEGATE_PATTERN_REFS,
} from "../contracts/subagent.ts";
import type { HarnessToolDefinition } from "./types.ts";
import { createUnimplementedToolError } from "./types.ts";

export const delegateTaskTool: HarnessToolDefinition<
  DelegateTaskToolInput,
  DelegateTaskToolOutput
> = {
  descriptor: {
    toolId: "delegate_task",
    title: "Delegate Task",
    description:
      "Run one focused subagent with a fresh context and return only its structured summary and retained run references.",
    effectClass: "side-effect",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["goal"],
      properties: {
        goal: {
          type: "string",
          description:
            'Specific task for the child run. Include all context the child needs; it will not see the parent transcript. Keep a "pattern-author" delegation focused on one buildable piece so its compile/fix loop fits the child turn budget. Name the words the capability should be findable under, so a later delegation can search the pattern index for the same component instead of asking for it again.',
        },
        profile: {
          type: "string",
          enum: [
            ...HARNESS_SUBAGENT_PROFILES,
          ] satisfies HarnessSubagentProfile[],
          description:
            "Named subagent profile to spawn. Defaults to the harness default profile. Authoring or running a Common Fabric pattern goes through \"pattern-author\": when the configured skill registry carries the pattern skills, this profile preloads them; the default profile does not. A \"pattern-author\" child runs what it wrote and answers with a reference to the result cell, never with source: you get something to assign_slug or wire into a run_pattern input, and you never compile anything yourself. It is also the only way to CHANGE a piece that already exists: hand it the piece's handle and say what should be different, and it reads that piece's current source and revises it in place, keeping the data. You cannot do that yourself — the tools that read and replace a piece's source are on that child's surface and on no parent's.",
        },
        context: {
          type: "string",
          description:
            "Optional supporting context, paths, constraints, or expected output for the child run.",
        },
        patternRefs: {
          type: "array",
          maxItems: MAX_DELEGATE_PATTERN_REFS,
          items: {
            type: "object",
            properties: {
              patternId: {
                type: "string",
                minLength: 1,
                description:
                  "Pattern id exactly as this parent received it from search_patterns or host-confirmed research.",
              },
              note: {
                type: "string",
                maxLength: MAX_DELEGATE_PATTERN_REF_NOTE_LENGTH,
                description:
                  "Optional parent-authored context for this pattern selection. It reaches the child verbatim.",
              },
            },
            required: ["patternId"],
            additionalProperties: false,
          },
          description:
            "Optional published patterns selected from this parent's earlier search_patterns results or host-confirmed research. The harness attaches their trusted metadata to the child; supply ids and optional notes only.",
        },
        maxModelTurns: {
          type: "integer",
          minimum: 1,
          maximum: 64,
          description:
            "Optional child model-turn cap. Defaults to the harness subagent cap.",
        },
        returnSchema: {
          anyOf: [
            { type: "boolean" },
            { type: "object", additionalProperties: true },
          ],
          description:
            'Optional JSON Schema for a structured child return. When provided, the child must return only JSON matching this schema; open-ended strings are linkified before the parent sees them. Some profiles declare their own return contract and refuse a schema here — "pattern-author" is one — because the shape of what they hand back is the point of the profile.',
        },
        skillHandle: {
          type: "string",
          description:
            "Optional handle (cfh:a:… token) naming a cell whose string value is skill text for the child. The text is materialized on the trusted host side and injected into the child's context; this run never sees it. A delegation that failed does not carry its handle forward: re-issuing it means passing the same token again.",
        },
        withoutSkillHandle: {
          type: "boolean",
          description:
            "States that this delegation deliberately runs with no acquired skill. Required only after a delegation carrying a skillHandle failed, where omitting both fields is refused: the harness cannot tell a considered choice from a dropped one, and the child's work would carry no record either way. It attaches nothing and permits nothing.",
        },
      },
    },
    tags: ["subagent", "orchestration"],
  },
  invoke() {
    throw createUnimplementedToolError(
      "delegate_task is orchestrated by the prompt loop",
    );
  },
};
