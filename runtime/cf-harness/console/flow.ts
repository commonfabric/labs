/**
 * A run family as the map of a conversation: the turns a person asked for, the
 * calls the agent made in each, the children it delegated to, and — on every
 * one of them — how it went, what CFC said, and which cells it touched.
 *
 * This is the reading the timeline cannot give. A rail of steps says what came
 * next; a map says how the work was shaped: where a turn began, where the agent
 * delegated, where it went round a compile-and-fix loop, where CFC refused it,
 * and where data actually moved. Those are the questions asked of a run nobody
 * watched.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";
import type { ConsoleHandle, ConsoleStep, ConsoleStepStatus } from "./steps.ts";
import { consoleStepArguments, handleTokensIn } from "./steps.ts";
import type {
  ConsoleCellLabels,
  ConsoleCellLabelsSummary,
} from "./cell-labels.ts";

/** What a node in the map stands for. */
export type ConsoleFlowKind =
  /** A person's message, which opens a turn. */
  | "turn"
  /** One tool call. */
  | "call"
  /** The agent's closing word on a turn. */
  | "reply";

/** A cell a call touched, named the way the page names cells everywhere. */
export interface ConsoleFlowCell {
  /** Stable identity — the address where known, the token otherwise. */
  id: string;

  token?: string;
  ref?: string;
  slug?: string;

  /** The step whose result minted it. */
  producedByStep?: number;

  /** The shape the pattern that made it declared, for the chip's card. */
  schema?: unknown;

  /** Confidentiality atoms the invocation context put where it was used. */
  confidentiality: readonly string[];

  /** The labels the space holds for the cell itself, where the run read them. */
  labels?: ConsoleCellLabels;

  /** The argument name it came in as, for a cell a call read. */
  as?: string;
}

/** One node of the conversation map. */
export interface ConsoleFlowNode {
  /** Unique within the map, and stable across re-reads. */
  id: string;

  /** The run this node belongs to — a child's nodes name the child. */
  runId: string;

  /** The step within that run, which is what a click on it opens. */
  step: number;

  kind: ConsoleFlowKind;

  /** The tool called, or the word for the kind. */
  label: string;

  /** A person's message, or the agent's reply, elided. */
  text?: string;

  status: ConsoleStepStatus;

  /** What CFC decided about the observation. */
  policyDecision?: string;

  /** Whether a policy event refused it. */
  policyDenied?: boolean;

  /** What that refusal said, where it said more than the fact of it. */
  policyDetail?: string;

  /** Cells this call read. */
  reads: readonly ConsoleFlowCell[];

  /** Cells this call produced. */
  produces: readonly ConsoleFlowCell[];

  /**
   * Cells that came into scope here without this call making them — a handle
   * handed to the session, or one a child's result carried back. A cell the
   * agent can use is worth marking wherever it arrived from, not only where it
   * was minted.
   */
  entersScope: readonly ConsoleFlowCell[];

  /**
   * How far this call let across as a plain value, for a call whose result
   * carried one.
   */
  valueBytes?: number;

  /**
   * The longest run of numbers that value carries, for the same call. An array
   * of integers is an array of values none of which is sealed, so a long one is
   * a channel wide enough for arbitrary content.
   */
  longestNumericRun?: number;

  /** The child run this call delegated to, drawn beneath it. */
  children: readonly ConsoleFlowNode[];

  /** How deep in delegation this node sits; zero in the parent run. */
  depth: number;
}

/** A turn of the conversation, and everything the agent did inside it. */
export interface ConsoleFlowTurn {
  /** The step of the parent run that opened it. */
  step: number;

  /** What the person asked, elided. */
  text?: string;

  nodes: readonly ConsoleFlowNode[];
}

/** The CFC regime the run's fabric session ran under. */
export interface ConsoleFlowCfc {
  enforcementMode: string;
  flowLabels: string;
  posture?: string;
}

export interface ConsoleFlow {
  turns: readonly ConsoleFlowTurn[];

  /**
   * The posture the run ran under. Without it a cell carrying no labels reads
   * as a gap in the page; with it, "no labels recorded" is a fact about the
   * run — flow labels off record none, and persist records them.
   */
  cfc?: ConsoleFlowCfc;

  /**
   * Whether the run's space was read for per-cell labels, and what it said.
   * The map states this once beside the posture, because a cell drawn with no
   * labels means one thing under a snapshot that was taken and another under a
   * run whose space could not be read.
   */
  cellLabels?: ConsoleCellLabelsSummary;

  /** Calls that failed, across the whole family. */
  failures: number;

  /** Calls CFC refused, across the whole family. */
  denials: number;

  /** Patterns that read no cell — work built from literals. */
  unwiredPatterns: number;
}

/** One run of a family, as the map needs to read it. */
export interface ConsoleFlowRunInput {
  runId: string;
  steps: readonly ConsoleStep[];
  handles: readonly ConsoleHandle[];
}

const TEXT_LIMIT = 240;

const elide = (text: string): string =>
  text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text;

const asRecord = (value: unknown): Record<string, unknown> =>
  isObjectNotArray(value) ? value as Record<string, unknown> : {};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** The cell a handle names, in the one shape the page draws a cell in. */
const cellOf = (
  handle: ConsoleHandle | undefined,
  token: string | undefined,
  ref: string | undefined,
  as?: string,
): ConsoleFlowCell => ({
  id: handle?.ref ?? ref ?? handle?.token ?? token ?? "cell",
  ...(handle?.token ?? token) !== undefined
    ? { token: handle?.token ?? token }
    : {},
  ...(handle?.ref ?? ref) !== undefined ? { ref: handle?.ref ?? ref } : {},
  ...(handle?.slug !== undefined ? { slug: handle.slug } : {}),
  ...(handle?.producedByStep !== undefined
    ? { producedByStep: handle.producedByStep }
    : {}),
  ...(handle?.schema !== undefined ? { schema: handle.schema } : {}),
  confidentiality: handle?.confidentiality ?? [],
  ...(handle?.labels !== undefined ? { labels: handle.labels } : {}),
  ...(as !== undefined ? { as } : {}),
});

/**
 * The nodes one run contributes, with each `delegate_task` call carrying the
 * child it started beneath it.
 */
const runNodes = (
  run: ConsoleFlowRunInput,
  byRunId: Map<string, ConsoleFlowRunInput>,
  depth: number,
  seen: Set<string>,
): ConsoleFlowNode[] => {
  if (seen.has(run.runId)) {
    return [];
  }
  seen.add(run.runId);
  const byToken = new Map(run.handles.map((handle) => [handle.token, handle]));
  const nodes: ConsoleFlowNode[] = [];

  for (const step of run.steps) {
    if (step.kind === "user" || step.kind === "system") {
      continue;
    }
    if (step.kind === "assistant") {
      if ((step.text ?? "").trim() === "") {
        continue;
      }
      nodes.push({
        id: `${run.runId}:${step.index}`,
        runId: run.runId,
        step: step.index,
        kind: "reply",
        label: "reply",
        text: elide(step.text ?? ""),
        status: step.status,
        reads: [],
        produces: [],
        entersScope: [],
        children: [],
        depth,
      });
      continue;
    }

    // An argument may carry more than one handle, and `consoleStepArguments`
    // reports the argument rather than each token in it — so the tokens are
    // read again here, and every cell an input names is drawn.
    const args = asRecord(step.input);
    const source = step.toolName === "run_pattern"
      ? asRecord(args.inputs)
      : args;
    const reads: ConsoleFlowCell[] = [];
    for (const argument of consoleStepArguments(step, run.handles)) {
      if (!argument.isReference) {
        continue;
      }
      const tokens = handleTokensIn(source[argument.key]);
      if (tokens.length <= 1) {
        reads.push(
          cellOf(
            argument.token === undefined
              ? undefined
              : byToken.get(argument.token),
            argument.token,
            argument.ref,
            argument.key,
          ),
        );
        continue;
      }
      for (const token of tokens) {
        reads.push(
          cellOf(
            byToken.get(token),
            token,
            byToken.get(token)?.ref,
            argument.key,
          ),
        );
      }
    }
    const produced = asString(asRecord(step.output).resultRef);
    const produces = produced === undefined
      ? []
      : [cellOf(byToken.get(produced), produced, byToken.get(produced)?.ref)];
    // A handle first seen at this step that this call did not mint arrived
    // from somewhere else — the session was handed it, or a child returned it.
    const entersScope = step.handlesIntroduced
      .filter((token) => token !== produced)
      .map((token) =>
        cellOf(byToken.get(token), token, byToken.get(token)?.ref)
      );
    const denial = step.policyEvents.find((event) =>
      event.severity === "denied"
    );
    const child = step.childRunId === undefined
      ? undefined
      : byRunId.get(step.childRunId);

    nodes.push({
      id: `${run.runId}:${step.index}`,
      runId: run.runId,
      step: step.index,
      kind: "call",
      label: step.toolName ?? "tool",
      status: step.status,
      ...(step.policy !== undefined
        ? { policyDecision: step.policy.decision }
        : {}),
      ...(denial !== undefined
        ? { policyDenied: true, policyDetail: denial.detail }
        : {}),
      reads,
      produces,
      entersScope,
      ...(step.disclosure !== undefined
        ? {
          valueBytes: step.disclosure.valueBytes,
          longestNumericRun: step.disclosure.longestNumericRun,
        }
        : {}),
      children: child === undefined
        ? []
        : runNodes(child, byRunId, depth + 1, seen),
      depth,
    });
  }
  return nodes;
};

const countIf = (
  nodes: readonly ConsoleFlowNode[],
  predicate: (node: ConsoleFlowNode) => boolean,
): number =>
  nodes.reduce(
    (total, node) =>
      total + (predicate(node) ? 1 : 0) + countIf(node.children, predicate),
    0,
  );

/**
 * The conversation map of a run and the children beneath it, cut into turns.
 *
 * A turn is opened by a person's message. A run seeded with earlier turns
 * carries them all, so reading a later run shows the whole conversation rather
 * than only its last exchange — which is the point of a map.
 */
export const consoleRunFlow = (
  root: ConsoleFlowRunInput,
  descendants: readonly ConsoleFlowRunInput[] = [],
  cfc?: ConsoleFlowCfc,
  cellLabels?: ConsoleCellLabelsSummary,
): ConsoleFlow => {
  const byRunId = new Map(descendants.map((run) => [run.runId, run]));
  const nodes = runNodes(root, byRunId, 0, new Set());
  const nodeAt = new Map(nodes.map((node) => [node.step, node]));

  const turns: ConsoleFlowTurn[] = [];
  let current: { step: number; text?: string; nodes: ConsoleFlowNode[] } = {
    step: 0,
    nodes: [],
  };
  let opened = false;
  for (const step of root.steps) {
    if (step.kind === "user") {
      if (opened) {
        turns.push(current);
      }
      current = {
        step: step.index,
        ...(step.text !== undefined ? { text: elide(step.text) } : {}),
        nodes: [],
      };
      opened = true;
      continue;
    }
    const node = nodeAt.get(step.index);
    if (node !== undefined) {
      current.nodes.push(node);
    }
  }
  if (opened || current.nodes.length > 0) {
    turns.push(current);
  }

  return {
    turns,
    ...(cfc !== undefined ? { cfc } : {}),
    ...(cellLabels !== undefined ? { cellLabels } : {}),
    failures: countIf(nodes, (node) => node.status === "error"),
    denials: countIf(
      nodes,
      (node) => node.status === "denied" || node.policyDenied === true,
    ),
    unwiredPatterns: countIf(
      nodes,
      (node) => node.label === "run_pattern" && node.reads.length === 0,
    ),
  };
};
