/** Exercises React Flow state that exists only for one browser gesture. */

import type { Node, NodeChange } from "@xyflow/react";
import { applyNodeChanges } from "@xyflow/react";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  capturePositionDrafts,
  type PositionDraft,
  reconcileCollaborativeNodes,
  reconcilePositionCommit,
  settlePositionDraft,
} from "./flow-lifecycle.ts";

type TestNode = Node<Record<string, never>>;

describe("flow-lifecycle", () => {
  it("retains drag state and untouched node identity", () => {
    const dragged: TestNode = {
      id: "dragged",
      position: { x: 0, y: 0 },
      data: {},
    };
    const untouched: TestNode = {
      id: "untouched",
      position: { x: 20, y: 20 },
      data: {},
    };
    const changes: NodeChange<TestNode>[] = [{
      id: dragged.id,
      type: "position",
      position: { x: 12, y: 8 },
      dragging: true,
    }];
    const draftsRef: { current: Record<string, PositionDraft> } = {
      current: {},
    };

    capturePositionDrafts(changes, draftsRef);
    const result = applyNodeChanges(changes, [dragged, untouched]);

    expect(result[0]?.position).toEqual({ x: 12, y: 8 });
    expect(result[0]?.dragging).toBe(true);
    expect(result[1]).toBe(untouched);
    expect(draftsRef.current).toEqual({
      dragged: { position: { x: 12, y: 8 }, token: 1 },
    });
  });

  it("reconciles durable data without displacing an active drag", () => {
    const current: TestNode = {
      id: "gate",
      position: { x: 30, y: 18 },
      dragging: true,
      data: {},
    };
    const authoritative: TestNode = {
      id: "gate",
      position: { x: 4, y: 6 },
      selected: true,
      data: {},
    };

    const result = reconcileCollaborativeNodes(
      [current],
      [authoritative],
      { gate: { position: current.position, token: 1 } },
    );

    expect(result[0]?.position).toEqual(current.position);
    expect(result[0]?.dragging).toBe(true);
    expect(result[0]?.selected).toBe(true);
  });

  it("clears only the position draft acknowledged by a write", () => {
    const changes: NodeChange<TestNode>[] = [{
      id: "gate",
      type: "position",
      position: { x: 30, y: 18 },
      dragging: false,
    }];
    const draftsRef: { current: Record<string, PositionDraft> } = {
      current: {},
    };
    capturePositionDrafts(changes, draftsRef);
    const first = draftsRef.current.gate!;
    capturePositionDrafts(changes, draftsRef);
    const second = draftsRef.current.gate!;

    expect(settlePositionDraft(draftsRef, "gate", first)).toBe(false);
    expect(draftsRef.current).toEqual({ gate: second });

    expect(settlePositionDraft(draftsRef, "gate", second)).toBe(true);
    expect(draftsRef.current).toEqual({});
  });

  it("preserves a pending local selection during reconciliation", () => {
    const first: TestNode = {
      id: "first",
      position: { x: 0, y: 0 },
      selected: true,
      data: {},
    };
    const second: TestNode = {
      id: "second",
      position: { x: 20, y: 20 },
      selected: false,
      data: {},
    };

    const result = reconcileCollaborativeNodes(
      [first, second],
      [{ ...first, selected: true }, { ...second, selected: false }],
      {},
      "second",
    );

    expect(result.map((node) => node.selected)).toEqual([false, true]);
  });

  it("rolls back only a failed gesture that is still current", () => {
    const first = { position: { x: 20, y: 20 }, token: 1 };
    const second = { position: { x: 20, y: 20 }, token: 2 };
    const draftsRef = { current: { gate: second } };

    expect(
      reconcilePositionCommit(
        draftsRef,
        "gate",
        first,
        undefined,
        { x: 4, y: 6 },
      ),
    ).toEqual({ settled: false });
    expect(draftsRef.current).toEqual({ gate: second });

    expect(
      reconcilePositionCommit(
        draftsRef,
        "gate",
        second,
        undefined,
        { x: 4, y: 6 },
      ),
    ).toEqual({ settled: true, position: { x: 4, y: 6 } });
    expect(draftsRef.current).toEqual({});
  });
});
