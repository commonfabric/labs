/**
 * Keeps React Flow's transient node state local while Fabric remains the
 * authoritative source for durable node data.
 */

/** A position in React Flow's canvas coordinate system. */
export interface XYPosition {
  /** Horizontal canvas coordinate. */
  x: number;
  /** Vertical canvas coordinate. */
  y: number;
}

/** Node fields required by the collaborative lifecycle helpers. */
export interface PositionedNode {
  /** Stable durable node identity. */
  id: string;
  /** Current canvas position. */
  position: XYPosition;
  /** Current React Flow selection state. */
  selected?: boolean;
}

/** One pointer-generated position draft with a unique gesture token. */
export interface PositionDraft<PositionType extends XYPosition = XYPosition> {
  /** Latest position in this gesture. */
  position: PositionType;
  /** Monotonic per-node identity for this version of the draft. */
  token: number;
}

/** Mutable position drafts captured synchronously from React Flow changes. */
export interface PositionDraftsRef {
  /** Latest unsaved positions, keyed by stable machine-node ID. */
  current: Record<string, PositionDraft>;
}

/** Captures durable positions synchronously from one React Flow change batch. */
export function capturePositionDrafts<ChangeType extends { type: string }>(
  changes: ChangeType[],
  draftsRef: PositionDraftsRef,
): void {
  const positions = changes.filter(
    (change): change is ChangeType & {
      id: string;
      position: XYPosition;
    } =>
      change.type === "position" &&
      (change as { position?: XYPosition }).position !== undefined,
  );
  for (const change of positions) {
    draftsRef.current[change.id] = {
      position: change.position,
      token: (draftsRef.current[change.id]?.token ?? 0) + 1,
    };
  }
}

/**
 * Reconciles authoritative node data without displacing local position drafts
 * or React Flow's gesture state.
 */
export function reconcileCollaborativeNodes<NodeType extends PositionedNode>(
  nodes: NodeType[],
  authoritativeNodes: NodeType[],
  drafts: Readonly<Record<string, PositionDraft>>,
  selectedNodeId?: string,
): NodeType[] {
  const currentById = new Map(nodes.map((node) => [node.id, node]));
  return authoritativeNodes.map((authoritative) => {
    const current = currentById.get(authoritative.id);
    return {
      ...current,
      ...authoritative,
      position: drafts[authoritative.id]?.position ?? authoritative.position,
      selected: selectedNodeId === undefined
        ? authoritative.selected
        : authoritative.id === selectedNodeId,
    };
  });
}

/** Clears a position draft only when its matching write completes. */
export function settlePositionDraft(
  draftsRef: PositionDraftsRef,
  nodeId: string,
  committed: PositionDraft,
): boolean {
  const latest = draftsRef.current[nodeId];
  if (latest === undefined || latest.token !== committed.token) {
    return false;
  }
  const next = { ...draftsRef.current };
  delete next[nodeId];
  draftsRef.current = next;
  return true;
}

/** Reconciles only the gesture whose position write has settled. */
export function reconcilePositionCommit<PositionType extends XYPosition>(
  draftsRef: PositionDraftsRef,
  nodeId: string,
  draft: PositionDraft,
  committed: PositionType | undefined,
  authoritative: PositionType | undefined,
): { settled: boolean; position?: PositionType } {
  if (!settlePositionDraft(draftsRef, nodeId, draft)) {
    return { settled: false };
  }
  return { settled: true, position: committed ?? authoritative };
}
