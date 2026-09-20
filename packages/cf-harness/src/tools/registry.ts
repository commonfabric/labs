import type { BuiltinToolId } from "../contracts/tool-descriptor.ts";
import { acquireSkillTool } from "./acquire-skill.ts";
import { assignSlugTool } from "./assign-slug.ts";
import {
  loomAuthoringContextTool,
  loomComposeTool,
  loomInspectTool,
} from "./loom-authoring.ts";
import { LOOM_RETRIEVAL_TOOLS } from "./loom-retrieval.ts";
import { bashTool } from "./bash.ts";
import { browserTool } from "./browser.ts";
import { delegateTaskTool } from "./delegate-task.ts";
import { describeHandleTool } from "./describe-handle.ts";
import { editFileTool } from "./edit-file.ts";
import { finishTaskTool } from "./finish-task.ts";
import { readPieceSourceTool, revisePieceTool } from "./piece-source.ts";
import { researchTool } from "./research.ts";
import { readFileTool } from "./read-file.ts";
import { readSkillResourceTool } from "./read-skill-resource.ts";
import { recordFeedbackTool } from "./record-feedback.ts";
import { runPatternTool } from "./run-pattern.ts";
import { runSkillScriptTool } from "./run-skill-script.ts";
import { searchPatternsTool } from "./search-patterns.ts";
import { searchSkillsTool } from "./search-skills.ts";
import { webFetchTool } from "./web-fetch.ts";
import { viewImageTool } from "./view-image.ts";
import { writeFileTool } from "./write-file.ts";
import type { HarnessToolDefinition } from "./types.ts";

export const BUILTIN_TOOLS = [
  bashTool,
  browserTool,
  readFileTool,
  viewImageTool,
  webFetchTool,
  readSkillResourceTool,
  runSkillScriptTool,
  editFileTool,
  writeFileTool,
  delegateTaskTool,
  runPatternTool,
  readPieceSourceTool,
  revisePieceTool,
  assignSlugTool,
  describeHandleTool,
  finishTaskTool,
  searchPatternsTool,
  recordFeedbackTool,
  searchSkillsTool,
  acquireSkillTool,
  researchTool,
  loomComposeTool,
  loomInspectTool,
  loomAuthoringContextTool,
  ...LOOM_RETRIEVAL_TOOLS,
] as const;

export const BUILTIN_TOOL_REGISTRY = new Map<
  BuiltinToolId,
  HarnessToolDefinition
>(
  BUILTIN_TOOLS.map((tool) => [tool.descriptor.toolId, tool]),
);

/**
 * The builtin tool registered under `toolId`, or `undefined` when no tool
 * answers to that name. Takes any string: a name a model wrote is a candidate
 * id until this lookup says otherwise, and the registry is the only authority
 * on which names are builtin tool ids.
 */
export const getBuiltinTool = (
  toolId: string,
): HarnessToolDefinition | undefined =>
  BUILTIN_TOOL_REGISTRY.get(toolId as BuiltinToolId);
