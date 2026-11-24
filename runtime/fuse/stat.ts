import {
  DIR_MODE,
  DIR_MODE_RW,
  FILE_MODE,
  FILE_MODE_RW,
  FILE_MODE_RWX,
  FILE_MODE_RX,
  type StatOpts,
  SYMLINK_MODE,
} from "./platform.ts";
import type { FsNode } from "./types.ts";

export interface MountOwnership {
  uid: number;
  gid: number;
}

interface OwnershipProvider {
  uid?: () => number | null;
  gid?: () => number | null;
}

function safeCall(fn: (() => number | null) | undefined): number | null {
  if (typeof fn !== "function") return null;
  try {
    return fn();
  } catch {
    return null;
  }
}

export function getMountOwnership(
  provider: OwnershipProvider = Deno,
): MountOwnership {
  const uid = safeCall(provider.uid);
  const gid = safeCall(provider.gid);
  return {
    uid: uid ?? 0,
    gid: gid ?? 0,
  };
}

export function nodeMode(node: FsNode, isWritable = false): number {
  if (node.kind === "dir") return isWritable ? DIR_MODE_RW : DIR_MODE;
  if (node.kind === "symlink") return SYMLINK_MODE;
  if (node.kind === "callable") {
    return node.callableKind === "handler" ? FILE_MODE_RWX : FILE_MODE_RX;
  }
  return isWritable ? FILE_MODE_RW : FILE_MODE;
}

export function nodeSize(node: FsNode): number {
  if (node.kind === "file") return node.content.length;
  if (node.kind === "symlink") return node.target.length;
  if (node.kind === "callable") return node.script.length;
  return 0;
}

export function buildNodeStat(
  node: FsNode,
  ino: bigint,
  options: {
    isWritable?: boolean;
    ownership: MountOwnership;
  },
): StatOpts {
  return {
    ino,
    mode: nodeMode(node, options.isWritable ?? false),
    nlink: node.kind === "dir" ? 2 : 1,
    size: nodeSize(node),
    uid: options.ownership.uid,
    gid: options.ownership.gid,
    mtime: node.mtime,
  };
}
