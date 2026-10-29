import type { CellBridge } from "./cell-bridge.ts";
import { FuseOperationState } from "./directory-handles.ts";
import { HandleMap } from "./handles.ts";
import type { FsTree } from "./tree.ts";

export function createFuseOperationState(
  tree: FsTree,
  bridge: CellBridge | null,
): FuseOperationState {
  return new FuseOperationState(
    tree,
    bridge,
    (ino) =>
      Boolean(
        bridge?.resolveWritePath(ino) || bridge?.resolveSourceWritePath(ino),
      ),
  );
}

export function closeKernelFileHandle(
  handles: HandleMap,
  bridge: Pick<CellBridge, "releaseEntityProjectionOpen"> | null,
  fh: bigint,
): void {
  const closed = handles.close(fh);
  if (closed) bridge?.releaseEntityProjectionOpen(closed.ino);
}
