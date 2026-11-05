export const OPENAI_CODEX_PROVIDER_ID = "openai-codex" as const;
export type HarnessCredentialProviderId = typeof OPENAI_CODEX_PROVIDER_ID;

export interface OpenAICodexOAuthCredential {
  type: "oauth";
  providerId: typeof OPENAI_CODEX_PROVIDER_ID;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
}

export type HarnessCredential = OpenAICodexOAuthCredential;

export type HarnessCredentialTerminalReason =
  | "invalid-grant"
  | "revoked"
  | "refresh-token-reused";

export interface HarnessCredentialHealth {
  status: "reconnect-required";
  reason: HarnessCredentialTerminalReason;
}

export type HarnessCredentialStatus =
  | {
    providerId: HarnessCredentialProviderId;
    status: "disconnected";
  }
  | {
    providerId: HarnessCredentialProviderId;
    status: "connected";
    refreshHealth: "ready" | "refresh-on-use";
  }
  | {
    providerId: HarnessCredentialProviderId;
    status: "reconnect-required";
    refreshHealth: "reconnect-required";
    reason: HarnessCredentialTerminalReason;
  };
