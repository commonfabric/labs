import type { CfcEnforcementMode } from "./types.ts";

export type HarnessPromptSlotRole = "direct-command" | "context" | "quote";

export interface HarnessPromptSlotLike {
  role?: HarnessPromptSlotRole;
  surface?: string;
  subject?: string;
  eventId?: string;
}

export interface HarnessWriteFileAuthorizationRequest {
  enforcementMode: CfcEnforcementMode;
  promptSlot?: HarnessPromptSlotLike;
  path: string;
  mode?: "replace" | "append";
}

export interface HarnessWriteFileAuthorizationDecision {
  allowed: boolean;
  warningDetail?: string;
  denialDetail?: string;
}

const hasDirectCommandAuthorization = (
  promptSlot?: HarnessPromptSlotLike,
): boolean => promptSlot?.role === "direct-command";

export const evaluateHarnessWriteFileAuthorization = (
  request: HarnessWriteFileAuthorizationRequest,
): HarnessWriteFileAuthorizationDecision => {
  const directCommand = hasDirectCommandAuthorization(request.promptSlot);

  switch (request.enforcementMode) {
    case "disabled":
      return { allowed: true };
    case "observe":
      return directCommand ? { allowed: true } : {
        allowed: true,
        warningDetail:
          "write_file would require direct-command authorization in enforce modes",
      };
    case "enforce-explicit":
      return directCommand ? { allowed: true } : {
        allowed: false,
        denialDetail:
          "write_file requires direct-command authorization in enforce-explicit",
      };
    case "enforce-strict":
      return directCommand ? { allowed: true } : {
        allowed: false,
        denialDetail:
          "write_file requires direct-command authorization in enforce-strict",
      };
  }
};
