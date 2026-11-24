// types.ts — Core types for the FUSE filesystem tree
import type { CfcNodeAnnotation } from "./annotations.ts";
import type { CallableKind } from "./callables.ts";

export type JsonType =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "object"
  | "array";

export type CfcAnnotatedNode = {
  cfc?: CfcNodeAnnotation;
};

/** Fields carried by every node regardless of kind. */
export type NodeCommon = CfcAnnotatedNode & {
  /**
   * Modification time in milliseconds since the epoch, advanced whenever the
   * node's content changes or a directory gains or loses an entry. Surfaced as
   * the stat `mtime` so a client sees a fresh attribute after an in-place
   * content change. This gives tools that key on mtime correct times, and is a
   * freshness signal for a same-size change on a stable inode — the change the
   * macOS NFS backend cannot see through the inode-invalidation notifications,
   * which it ignores.
   */
  mtime: number;
};

export type FsNode =
  | (
    & { kind: "dir"; children: Map<string, bigint>; jsonType?: JsonType }
    & NodeCommon
  )
  | (
    & { kind: "file"; content: Uint8Array; jsonType: JsonType }
    & NodeCommon
  )
  | ({ kind: "symlink"; target: string } & NodeCommon)
  | ({
    kind: "callable";
    callableKind: CallableKind;
    cellKey: string;
    cellProp: "input" | "result";
    script: Uint8Array;
  } & NodeCommon);
