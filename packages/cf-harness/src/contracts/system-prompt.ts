import type { BuiltinToolId } from "./tool-descriptor.ts";
import type { HarnessPatternIndexConfig } from "../config.ts";
import type { CfHarnessHostMountConfig } from "../host-mounts.ts";
import type { HarnessRunDepth } from "./run-depth.ts";

/** Additional instructions a later invocation can inherit. */
export interface HarnessSystemPromptInputs {
  systemPrompt?: string;
}

/** Effective configuration for this invocation's system prompt. */
export interface HarnessSystemPromptConfig extends HarnessSystemPromptInputs {
  outputMode: "batch" | "operator";
  workspace: string;
  focusRoot?: string;
  depth?: HarnessRunDepth;
  allowedToolIds?: readonly BuiltinToolId[];
  patternIndex?: HarnessPatternIndexConfig;
  hostMounts?: readonly CfHarnessHostMountConfig[];
  fabricMountPath?: string;
  skillCatalogEnabled?: boolean;
  skillNames?: readonly string[];
}
