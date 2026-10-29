/**
 * A tool descriptor is a contract, and the rules for using a tool are
 * guidance a run's task tags load.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  HARNESS_SUBAGENT_PROFILES,
  type HarnessSubagentProfile,
} from "../src/contracts/subagent.ts";
import type { BuiltinToolId } from "../src/contracts/tool-descriptor.ts";
import { orientContextMessages } from "../src/session-assembly.ts";
import type { HarnessTaskTag } from "../src/task-classification.ts";
import {
  AUTHOR_TOOL_GUIDANCE,
  LOOM_COMMANDS_TOOL_GUIDANCE,
  LOOM_RETRIEVAL_TOOL_GUIDANCE,
  PIECES_TOOL_GUIDANCE,
  RESEARCH_TOOL_GUIDANCE,
  RESOLVE_PIECE_TOOL_GUIDANCE,
  toolGuidanceContextMessages,
} from "../src/tool-guidance.ts";
import {
  BUILTIN_TOOLS,
  builtinToolDescriptorForRuntime,
} from "../src/tools/registry.ts";

/** The tools a loom carry job is granted. */
const CARRY_TOOL_IDS: readonly BuiltinToolId[] = [
  "web_fetch",
  "delegate_task",
  "run_pattern",
  "assign_slug",
  "resolve_piece",
  "describe_handle",
  "call_verb",
  "read_value",
  "search_patterns",
  "record_feedback",
  "research",
  "loom_search",
  "loom_page_discover",
  "loom_page_inspect",
  "loom_page_read",
  "loom_people",
  "loom_calendar_list",
  "loom_context",
  "loom_profile",
  "list_commands",
  "run_command",
  "submit_result",
];

/** The descriptors a carry job sends the model, as one serialized array. */
const carryDescriptors = (
  subagentProfiles: readonly HarnessSubagentProfile[] =
    HARNESS_SUBAGENT_PROFILES,
): string =>
  JSON.stringify(
    BUILTIN_TOOLS.filter((tool) =>
      CARRY_TOOL_IDS.includes(tool.descriptor.toolId)
    ).map((tool) =>
      builtinToolDescriptorForRuntime(
        tool,
        { kind: "runsc-cfc", defaultWorkingDirectory: "/workspace" },
        { cfcEnforcementMode: "enforce-explicit", subagentProfiles },
      )
    ),
  );

/** The tool guidance a fully backed session's task with `tags` opens with. */
const guidanceFor = (...tags: HarnessTaskTag[]): string =>
  orientContextMessages(
    toolGuidanceContextMessages({
      fabricSessionAvailable: true,
      loomCommandsAvailable: true,
      loomRetrievalAvailable: true,
    }),
    { tags: new Set(tags), depth: "standard" },
  ).join("\n\n");

/** Rule prose that each lived in a carry tool's descriptor. */
const RULES = [
  "Bound every query with a LIMIT",
  "needs no LIMIT",
  "PerSession<>",
  "error branch and row count",
  "reread the held resultRef",
  "followUpTo, asking for what remains unclear",
  "Read `fill` before querying",
  "an alias does not count",
  "read it before researching the same question again",
  "pass its handle token, never a copy of its fields",
  "select one field rather than reading a whole piece",
  "expectedVersion to refuse a stale write",
  "do not retry",
  "untrusted external data",
  "withheld with a reason code",
  "one buildable piece",
  "call resolve_piece before author delegation",
];

describe("tool-guidance", () => {
  it("leaves every rule out of the descriptors a carry job sends", () => {
    const descriptors = carryDescriptors();
    for (const rule of RULES) {
      expect(descriptors.includes(rule), rule).toBe(false);
    }
  });

  it("sends the same descriptors whichever profiles a run may delegate to", () => {
    // Descriptors lead every request, so a byte that differed between asks
    // would split the cached prefix every carry job shares.
    expect(carryDescriptors()).toEqual(carryDescriptors());
    expect(carryDescriptors(["default", "pattern-author", "browser"]))
      .toEqual(carryDescriptors(["default", "pattern-author", "browser"]));
  });

  it("keeps every rule somewhere a fully guided run reads it", () => {
    const all = toolGuidanceContextMessages({
      fabricSessionAvailable: true,
      loomCommandsAvailable: true,
      loomRetrievalAvailable: true,
    }).join("\n\n");
    for (const rule of RULES) {
      expect(all.includes(rule), rule).toBe(true);
    }
  });

  it("gives a find task the command and retrieval guidance and no authoring or piece rules", () => {
    const guidance = guidanceFor("find");
    expect(guidance).toContain(LOOM_COMMANDS_TOOL_GUIDANCE);
    expect(guidance).toContain(LOOM_RETRIEVAL_TOOL_GUIDANCE);
    expect(guidance).toContain(RESOLVE_PIECE_TOOL_GUIDANCE);
    expect(guidance).toContain(RESEARCH_TOOL_GUIDANCE);
    expect(guidance).not.toContain(AUTHOR_TOOL_GUIDANCE);
    expect(guidance).not.toContain(PIECES_TOOL_GUIDANCE);
  });

  it("gives an author task the run_pattern rules and research guidance", () => {
    const guidance = guidanceFor("author");
    expect(guidance).toContain(AUTHOR_TOOL_GUIDANCE);
    expect(guidance).toContain("Bound every query with a LIMIT");
    expect(guidance).toContain("An aggregate (count(*), sum(), GROUP BY)");
    expect(guidance).toContain(RESEARCH_TOOL_GUIDANCE);
    expect(guidance).not.toContain(LOOM_COMMANDS_TOOL_GUIDANCE);
    expect(guidance).not.toContain(PIECES_TOOL_GUIDANCE);
  });

  it("gives an author task resolving a named piece only inside piece targeting", () => {
    expect(guidanceFor("author")).not.toContain(RESOLVE_PIECE_TOOL_GUIDANCE);
    expect(guidanceFor("author", "find")).not.toContain(
      RESOLVE_PIECE_TOOL_GUIDANCE,
    );
  });

  it("gives a pieces task the handle rules", () => {
    const guidance = guidanceFor("pieces");
    expect(guidance).toContain(PIECES_TOOL_GUIDANCE);
    expect(guidance).toContain("rowLabelReads");
    expect(guidance).toContain("`fill`");
    expect(guidance).toContain(RESOLVE_PIECE_TOOL_GUIDANCE);
    expect(guidance).toContain(RESEARCH_TOOL_GUIDANCE);
    expect(guidance).not.toContain(AUTHOR_TOOL_GUIDANCE);
    expect(guidance).not.toContain(LOOM_COMMANDS_TOOL_GUIDANCE);
  });

  it("tells a pieces task to read the path a verb's parameter points at", () => {
    const guidance = guidanceFor("pieces");
    expect(guidance).toContain("Before call_verb, describe the piece");
    expect(guidance).toContain("read that path with read_value");
  });

  it("gives a respond task no tool guidance", () => {
    expect(guidanceFor("respond")).toEqual("");
  });

  it("guides only the tools a session's backings carry", () => {
    expect(toolGuidanceContextMessages({
      fabricSessionAvailable: false,
      loomCommandsAvailable: true,
      loomRetrievalAvailable: false,
    })).toEqual([LOOM_COMMANDS_TOOL_GUIDANCE]);
    expect(toolGuidanceContextMessages({
      fabricSessionAvailable: true,
      loomCommandsAvailable: false,
      loomRetrievalAvailable: true,
    })).toEqual([
      AUTHOR_TOOL_GUIDANCE,
      RESEARCH_TOOL_GUIDANCE,
      PIECES_TOOL_GUIDANCE,
      RESOLVE_PIECE_TOOL_GUIDANCE,
      LOOM_RETRIEVAL_TOOL_GUIDANCE,
    ]);
  });
});
