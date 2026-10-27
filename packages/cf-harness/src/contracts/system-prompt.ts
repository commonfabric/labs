import type { BuiltinToolId } from "./tool-descriptor.ts";
import type { HarnessPatternIndexConfig } from "../config.ts";
import type { CfHarnessHostMountConfig } from "../host-mounts.ts";
import type { HarnessRunDepth } from "./run-depth.ts";

/** Prompt-builder components; result and task classification live in run state. */
export interface HarnessSystemPromptInputs {
  outputMode: "batch" | "operator";
  workspace: string;
  focusRoot?: string;
  systemPrompt?: string;
  depth?: HarnessRunDepth;
  allowedToolIds?: readonly BuiltinToolId[];
  patternIndex?: HarnessPatternIndexConfig;
  hostMounts?: readonly CfHarnessHostMountConfig[];
  fabricMountPath?: string;
  skillCatalogEnabled?: boolean;
  skillNames?: readonly string[];
}
