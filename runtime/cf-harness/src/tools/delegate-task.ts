import type {
  DelegateTaskToolInput,
  DelegateTaskToolOutput,
  HarnessSubagentProfile,
} from "../contracts/subagent.ts";
import {
  DEFAULT_SUBAGENT_PROFILE,
  HARNESS_SUBAGENT_PROFILES,
  MAX_DELEGATE_PATTERN_REF_NOTE_LENGTH,
  MAX_DELEGATE_PATTERN_REFS,
  PATTERN_AUTHOR_SUBAGENT_PROFILE,
} from "../contracts/subagent.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { HarnessToolDefinition } from "./types.ts";
import { createUnimplementedToolError } from "./types.ts";

const PROFILE_DESCRIPTION =
  "Subagent profile; the default profile when omitted.";

const PATTERN_AUTHOR_DESCRIPTION =
  '"pattern-author" writes, runs or revises a pattern and returns a reference to its result, never source.';

/**
 * The delegate_task descriptor offering `profiles`, in their usual order, and
 * naming pattern-author only when it is among them.
 */
const delegateTaskDescriptor = (
  profiles: readonly HarnessSubagentProfile[],
): HarnessToolDescriptor => {
  const authors = profiles.includes(PATTERN_AUTHOR_SUBAGENT_PROFILE);
  return {
    toolId: "delegate_task",
    title: "Delegate Task",
    description:
      "Run one focused subagent with a fresh context and return only its structured summary and retained run references.",
    effectClass: "side-effect",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      // An omitted profile is the default one, so a run that may not use it
      // must name the profile it delegates to.
      required: profiles.includes(DEFAULT_SUBAGENT_PROFILE)
        ? ["goal"]
        : ["goal", "profile"],
      properties: {
        goal: {
          type: "string",
          description:
            "The child's task, with all the context it needs: it does not see this transcript.",
        },
        profile: {
          type: "string",
          enum: HARNESS_SUBAGENT_PROFILES.filter((profile) =>
            profiles.includes(profile)
          ),
          description: authors
            ? `${PROFILE_DESCRIPTION} ${PATTERN_AUTHOR_DESCRIPTION}`
            : PROFILE_DESCRIPTION,
        },
        context: {
          type: "string",
          description:
            "Supporting context, paths, constraints, or expected output.",
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
                  "As search_patterns or host-confirmed research gave it.",
              },
              note: {
                type: "string",
                maxLength: MAX_DELEGATE_PATTERN_REF_NOTE_LENGTH,
                description: "Your note on this pattern, passed verbatim.",
              },
            },
            required: ["patternId"],
            additionalProperties: false,
          },
          description:
            "Published patterns to attach, with their trusted metadata.",
        },
        maxModelTurns: {
          type: "integer",
          minimum: 1,
          maximum: 64,
          description:
            "Child model-turn cap; the harness subagent cap when omitted.",
        },
        returnSchema: {
          anyOf: [
            { type: "boolean" },
            { type: "object", additionalProperties: true },
          ],
          description:
            "JSON Schema the child's whole return must match; open-ended strings are linkified before you see them.",
        },
        skillHandle: {
          type: "string",
          description:
            "A cfh:a: handle to a cell of skill text, injected into the child's context unseen by this run.",
        },
        withoutSkillHandle: {
          type: "boolean",
          description: "Declares this delegation runs with no skill.",
        },
      },
    },
    tags: ["subagent", "orchestration"],
  };
};

const delegateTaskDescriptorAll = delegateTaskDescriptor(
  HARNESS_SUBAGENT_PROFILES,
);

export const delegateTaskTool: HarnessToolDefinition<
  DelegateTaskToolInput,
  DelegateTaskToolOutput
> = {
  descriptor: delegateTaskDescriptorAll,
  // A run with no profile to offer keeps the full list rather than an empty
  // enum; the prompt loop refuses whatever it names.
  descriptorForRuntime: (_runtime, run) =>
    run.subagentProfiles === undefined || run.subagentProfiles.length === 0
      ? delegateTaskDescriptorAll
      : delegateTaskDescriptor(run.subagentProfiles),
  invoke() {
    throw createUnimplementedToolError(
      "delegate_task is orchestrated by the prompt loop",
    );
  },
};
