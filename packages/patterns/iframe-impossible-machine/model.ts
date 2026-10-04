import {
  type IframeStateData,
  type MachineEdge,
  machineEdgeId,
  type MachineNode,
} from "./contract.ts";
export {
  createActionRunner,
  createSelectionRequestTracker,
  errorFrom,
  findAppendOnlyItem,
  nodeControlBoundaryProps,
  stopNodeControlPropagation,
  updateLatestValue,
} from "./interaction.ts";

export interface MachineNodePresentation {
  code: string;
  position: { x: number; y: number };
}

function stableHash(value: string, initial: number): number {
  let hash = initial;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/** Derives collision-resistant presentation from a node's stable identity. */
export function machineNodePresentation(
  id: string,
): MachineNodePresentation {
  const hexadecimal = id.replaceAll("-", "");
  const code = /^[0-9a-f]{32}$/i.test(hexadecimal)
    ? BigInt(`0x${hexadecimal}`).toString(36).toUpperCase()
    : id;
  return {
    code,
    position: {
      x: 80 + stableHash(id, 0x811c_9dc5) / 0x1_0000_0000 * 820,
      y: 60 + stableHash(id, 0x9e37_79b9) / 0x1_0000_0000 * 430,
    },
  };
}

function clampSignal(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export interface SignalPresentation {
  semantic: number;
  label: string;
  highlighted: boolean;
}

/** Keeps signal meaning independent from the user's presentation preference. */
export function presentSignal(
  signal: number,
  showSignals: boolean,
): SignalPresentation {
  const semantic = clampSignal(signal);
  return {
    semantic,
    label: showSignals ? `${Math.round(semantic * 100)}%` : "Hidden",
    highlighted: showSignals && semantic >= 0.5,
  };
}

export function isActuatorFiring(node: MachineNode, signal: number): boolean {
  return node.kind === "actuator" && signal >= node.parameters.threshold;
}

/** Canonicalizes duplicates while preserving the durable wire-log order. */
export function dedupeMachineEdges(
  edges: readonly MachineEdge[],
): MachineEdge[] {
  const unique = new Map<string, MachineEdge>();
  for (const edge of edges) {
    const id = machineEdgeId(edge.source, edge.target);
    if (!unique.has(id)) {
      unique.set(id, { id, source: edge.source, target: edge.target });
    }
  }
  return [...unique.values()];
}

function outgoingNodes(
  edges: readonly MachineEdge[],
): Map<string, Set<string>> {
  const outgoing = new Map<string, Set<string>>();
  for (const edge of dedupeMachineEdges(edges)) {
    const targets = outgoing.get(edge.source) ?? new Set<string>();
    targets.add(edge.target);
    outgoing.set(edge.source, targets);
  }
  return outgoing;
}

function canReach(
  outgoing: ReadonlyMap<string, ReadonlySet<string>>,
  start: string,
  target: string,
): boolean {
  const pending = [...(outgoing.get(start) ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of outgoing.get(current) ?? []) pending.push(next);
  }
  return false;
}

/** Returns every module participating in a stored feedback loop. */
export function findFeedbackNodeIds(
  edges: readonly MachineEdge[],
): Set<string> {
  const outgoing = outgoingNodes(edges);
  const nodeIds = new Set<string>();
  for (const edge of dedupeMachineEdges(edges)) {
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
  }
  return new Set(
    [...nodeIds].filter((nodeId) => canReach(outgoing, nodeId, nodeId)),
  );
}

/** Checks whether one proposed directed wire would introduce feedback. */
export function createsFeedbackCycle(
  edges: readonly MachineEdge[],
  source: string,
  target: string,
): boolean {
  if (source === target) return true;
  return canReach(outgoingNodes(edges), target, source);
}

export interface CanonicalMachineEdges {
  edges: MachineEdge[];
  suppressed: MachineEdge[];
}

/**
 * Selects one deterministic acyclic graph from independently appended wires.
 * Conflicting wires remain visible to the caller so the stored conflict can be
 * removed instead of silently disabling the machine.
 */
export function canonicalizeMachineEdges(
  edges: readonly MachineEdge[],
  disabledEdges: Readonly<Record<string, boolean>> = {},
): CanonicalMachineEdges {
  const canonical: MachineEdge[] = [];
  const suppressed: MachineEdge[] = [];
  for (const edge of dedupeMachineEdges(edges)) {
    if (disabledEdges[edge.id] === true) continue;
    if (createsFeedbackCycle(canonical, edge.source, edge.target)) {
      suppressed.push(edge);
    } else {
      canonical.push(edge);
    }
  }
  return { edges: canonical, suppressed };
}

/** Evaluates the machine at one logical tick without storing derived state. */
export function evaluateSignals(
  state: IframeStateData,
  tick: number,
): Map<string, number> {
  const nodes = new Map(state.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, MachineEdge[]>();
  for (
    const edge of canonicalizeMachineEdges(
      state.edges,
      state.disabledEdges,
    ).edges
  ) {
    const edges = incoming.get(edge.target) ?? [];
    edges.push(edge);
    incoming.set(edge.target, edges);
  }
  const memo = new Map<string, number>();

  const evaluate = (
    nodeId: string,
    atTick: number,
  ): number => {
    if (atTick < 0) return 0;
    const memoKey = `${nodeId}@${atTick}`;
    const known = memo.get(memoKey);
    if (known !== undefined) return known;

    const node = nodes.get(nodeId);
    if (!node) return 0;
    const sourceTick = node.kind === "delay"
      ? atTick - node.parameters.delaySteps
      : atTick;
    const inputs = (incoming.get(nodeId) ?? []).map((edge) =>
      evaluate(edge.source, sourceTick)
    );

    let result: number;
    switch (node.kind) {
      case "sensor":
        result = node.parameters.active ? node.parameters.strength : 0;
        break;
      case "gate": {
        const high = inputs.filter((value) => value >= 0.5).length;
        if (node.parameters.operator === "and") {
          result = inputs.length > 0 && high === inputs.length ? 1 : 0;
        } else if (node.parameters.operator === "or") {
          result = high > 0 ? 1 : 0;
        } else {
          result = high % 2 === 1 ? 1 : 0;
        }
        break;
      }
      case "delay":
        result = inputs.length === 0
          ? 0
          : inputs.reduce((most, input) => Math.max(most, input), -Infinity);
        break;
      case "transformer":
        result = clampSignal(
          average(inputs) * node.parameters.gain + node.parameters.offset,
        );
        break;
      case "actuator": {
        const received = inputs.length === 0
          ? 0
          : inputs.reduce((most, input) => Math.max(most, input), -Infinity);
        result = received >= node.parameters.threshold ? received : 0;
        break;
      }
    }
    result = clampSignal(result);
    memo.set(memoKey, result);
    return result;
  };

  return new Map(
    state.nodes.map((node: MachineNode) => [
      node.id,
      evaluate(node.id, tick),
    ]),
  );
}
