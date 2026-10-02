/**
 * Module for interacting with a runtime over some IPC, currently a web worker thread.
 */

export * from "./cell-handle.ts";
export * from "./piece-handle.ts";
export * from "./piece-exports.ts";
export * from "./runtime-client.ts";
export * from "./favorites-manager.ts";
export * from "./client/emitter.ts";
export * from "./client/transport.ts";
export * from "./client/connection.ts";
export { cellRefToIdentityKey, cellRefToKey } from "./shared/utils.ts";
export * from "./protocol/mod.ts";
export * from "./vnode-types.ts";
export * from "@commonfabric/runner/shared";
export type {
  ApplyOpResolution,
  IntegratedOperation,
  OpCursor,
  OperationFieldSnapshot,
  PresenceFacets,
  PresenceRecord,
} from "@commonfabric/memory/v2";
export type { PresenceEvent } from "@commonfabric/memory/v2/client";
export { CODEMIRROR_CHANGESET_CODEC } from "@commonfabric/memory/v2/operation-codec";
