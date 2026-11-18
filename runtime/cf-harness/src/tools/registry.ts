import type {
  BuiltinToolId,
  HarnessToolDescriptor,
} from "../contracts/tool-descriptor.ts";
import type { BuiltinToolInputMap, BuiltinToolOutputMap } from "../engine.ts";
import type { SandboxRuntimeDescription } from "../sandbox/types.ts";
import { acquireSkillTool } from "./acquire-skill.ts";
import { assignSlugTool } from "./assign-slug.ts";
import {
  loomAuthoringContextTool,
  loomComposeTool,
  loomInspectTool,
} from "./loom-authoring.ts";
import { listCommandsTool, runCommandTool } from "./loom-commands.ts";
import {
  loomCalendarListTool,
  loomContextTool,
  loomPageDiscoverTool,
  loomPageInspectTool,
  loomPageReadTool,
  loomPeopleTool,
  loomProfileTool,
  loomSearchTool,
} from "./loom-retrieval.ts";
import { bashTool } from "./bash.ts";
import { browserTool } from "./browser.ts";
import { callVerbTool } from "./call-verb.ts";
import { readValueTool } from "./read-value.ts";
import { delegateTaskTool } from "./delegate-task.ts";
import { describeHandleTool } from "./describe-handle.ts";
import { editFileTool } from "./edit-file.ts";
import { finishTaskTool } from "./finish-task.ts";
import { weaverActionTool } from "./weaver-action.ts";
import { readPieceSourceTool, revisePieceTool } from "./piece-source.ts";
import { researchTool } from "./research.ts";
import { readFileTool } from "./read-file.ts";
import { readSkillResourceTool } from "./read-skill-resource.ts";
import { recordFeedbackTool } from "./record-feedback.ts";
import { resolvePieceTool } from "./resolve-piece.ts";
import { runPatternTool } from "./run-pattern.ts";
import { runSkillScriptTool } from "./run-skill-script.ts";
import { searchPatternsTool } from "./search-patterns.ts";
import { searchSkillsTool } from "./search-skills.ts";
import { reportProgressTool } from "./report-progress.ts";
import { submitResultTool } from "./submit-result.ts";
import { webFetchTool } from "./web-fetch.ts";
import { viewImageTool } from "./view-image.ts";
import { writeFileTool } from "./write-file.ts";
import type { HarnessToolDefinition, HarnessToolRun } from "./types.ts";

/** Each builtin tool under its id, typed with that id's input and output. */
export type BuiltinToolTable = {
  readonly [TToolId in BuiltinToolId]: HarnessToolDefinition<
    BuiltinToolInputMap[TToolId],
    BuiltinToolOutputMap[TToolId]
  >;
};

const BUILTIN_TOOL_TABLE: BuiltinToolTable = {
  bash: bashTool,
  browser: browserTool,
  read_file: readFileTool,
  view_image: viewImageTool,
  web_fetch: webFetchTool,
  read_skill_resource: readSkillResourceTool,
  run_skill_script: runSkillScriptTool,
  edit_file: editFileTool,
  write_file: writeFileTool,
  delegate_task: delegateTaskTool,
  run_pattern: runPatternTool,
  read_piece_source: readPieceSourceTool,
  revise_piece: revisePieceTool,
  assign_slug: assignSlugTool,
  resolve_piece: resolvePieceTool,
  describe_handle: describeHandleTool,
  call_verb: callVerbTool,
  read_value: readValueTool,
  finish_task: finishTaskTool,
  weaver_action: weaverActionTool,
  search_patterns: searchPatternsTool,
  record_feedback: recordFeedbackTool,
  search_skills: searchSkillsTool,
  acquire_skill: acquireSkillTool,
  research: researchTool,
  loom_compose: loomComposeTool,
  loom_inspect: loomInspectTool,
  loom_authoring_context: loomAuthoringContextTool,
  loom_search: loomSearchTool,
  loom_page_discover: loomPageDiscoverTool,
  loom_page_inspect: loomPageInspectTool,
  loom_page_read: loomPageReadTool,
  loom_people: loomPeopleTool,
  loom_calendar_list: loomCalendarListTool,
  loom_context: loomContextTool,
  loom_profile: loomProfileTool,
  list_commands: listCommandsTool,
  run_command: runCommandTool,
  report_progress: reportProgressTool,
  submit_result: submitResultTool,
};

/** The builtin tools, in the order they are offered. */
export const BUILTIN_TOOLS = Object.values(BUILTIN_TOOL_TABLE);

/** Each builtin tool under the id the table registers it with. */
export const BUILTIN_TOOL_REGISTRY: ReadonlyMap<string, HarnessToolDefinition> =
  new Map(Object.entries(BUILTIN_TOOL_TABLE));

/**
 * The builtin tool registered under `toolId`, or `undefined` when no tool
 * answers to that name. Takes any string: a name a model wrote is a candidate
 * id until this lookup says otherwise, and the registry is the only authority
 * on which names are builtin tool ids.
 */
export const getBuiltinTool = (
  toolId: string,
): HarnessToolDefinition | undefined => BUILTIN_TOOL_REGISTRY.get(toolId);

/**
 * The builtin tool registered under `toolId`, typed with that id's input and
 * output; `undefined` only for a name an untyped caller passed.
 */
export const getTypedBuiltinTool = <TToolId extends BuiltinToolId>(
  toolId: TToolId,
): BuiltinToolTable[TToolId] | undefined =>
  Object.hasOwn(BUILTIN_TOOL_TABLE, toolId)
    ? BUILTIN_TOOL_TABLE[toolId]
    : undefined;

/**
 * The descriptor of `tool` that a run on `runtime` offers the model, given
 * what about `run` decides it — its enforcement mode, and whether a browser
 * host carries its browser actions: the tool's own, unless the tool has one
 * that depends on them.
 */
export const builtinToolDescriptorForRuntime = (
  tool: Pick<HarnessToolDefinition, "descriptor" | "descriptorForRuntime">,
  runtime: SandboxRuntimeDescription,
  run: HarnessToolRun,
): HarnessToolDescriptor =>
  tool.descriptorForRuntime?.(runtime, run) ?? tool.descriptor;
