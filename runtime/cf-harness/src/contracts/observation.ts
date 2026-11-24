export type OpaqueHandleScope = "invocation" | "run" | "session";

export interface OpaqueHandle {
  type: "cf-harness.opaque-handle";
  handleId: string;
  scope: OpaqueHandleScope;
  createdAt: string;
  expiresAt?: string;
  passThrough?: boolean;
  metadataRef?: string;
}

export type ObservationDeniedReason =
  | "not-authorized"
  | "not-observable"
  | "needs-opaque-pass-through"
  | "needs-sanitizing-worker";

export interface ObservationDenied {
  type: "cf-harness.observation-denied";
  reason: ObservationDeniedReason;
  detail?: string;
  handle?: OpaqueHandle;
}

export const createOpaqueHandle = (
  handleId: string,
  scope: OpaqueHandleScope,
  options: Partial<Omit<OpaqueHandle, "type" | "handleId" | "scope">> = {},
): OpaqueHandle => ({
  type: "cf-harness.opaque-handle",
  handleId,
  scope,
  createdAt: options.createdAt ?? new Date().toISOString(),
  ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
  ...(options.passThrough !== undefined
    ? { passThrough: options.passThrough }
    : {}),
  ...(options.metadataRef !== undefined
    ? { metadataRef: options.metadataRef }
    : {}),
});

export const createObservationDenied = (
  reason: ObservationDeniedReason,
  options: Partial<Omit<ObservationDenied, "type" | "reason">> = {},
): ObservationDenied => ({
  type: "cf-harness.observation-denied",
  reason,
  ...(options.detail !== undefined ? { detail: options.detail } : {}),
  ...(options.handle !== undefined ? { handle: options.handle } : {}),
});
