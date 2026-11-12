/**
 * The logic behind the scheduler debugger's source browser
 * (`XSchedulerSource`): where an action sits in its pattern's source, how the
 * actions on each source line add up, and how a line's heat and timing read.
 */

import type { PatternSourceInfo } from "@commonfabric/runtime-client";

import type { RunBaseline, RunTotals } from "./scheduler-graph-stats.ts";

/** Source location an action ID names. */
export interface ActionLocation {
  /** Path of the source file, as the pattern's file list names it. */
  file: string;

  /** One-based line number. */
  line: number;

  /** Column within the line. */
  col: number;
}

/** One action on a source line, with its statistics. */
export interface ActionEntry {
  /** Scheduler node ID of the action. */
  nodeId: string;

  /** Column the action starts at. */
  col: number;

  /** Kind of action: `"effect"`, `"computation"` or `"inactive"`. */
  type: string;

  /** Total time the action has run for, in milliseconds. */
  totalTime: number;

  /** Number of times the action has run. */
  runCount: number;

  /** Time the action has run for since the baseline, in milliseconds. */
  deltaTime: number;

  /** Number of times the action has run since the baseline. */
  deltaRuns: number;
}

/** The actions on one source line, and their statistics summed. */
export interface LineAnnotation {
  /** The actions on the line, ordered by column. */
  entries: ActionEntry[];

  /** Kinds of action on the line. */
  types: Set<string>;

  /** Sum of the entries' `totalTime`. */
  totalTime: number;

  /** Sum of the entries' `runCount`. */
  runCount: number;

  /** Sum of the entries' `deltaTime`. */
  deltaTime: number;

  /** Sum of the entries' `deltaRuns`. */
  deltaRuns: number;
}

/** Scheduler node as the source browser receives it from its parent. */
export interface SourceViewNode {
  /** Scheduler node ID, which names the action's source location. */
  id: string;

  /** Kind of action: `"effect"`, `"computation"` or `"inactive"`. */
  type: string;

  /** Label the graph shows for the node. */
  label: string;

  /** Accumulated statistics, absent for a node that has never run. */
  stats?: RunTotals;

  /** Content identity of the pattern this node belongs to. */
  patternIdentity?: string;
}

/** Pattern, file and line of the source a node's action is in. */
export interface SourcePosition {
  /** Index into the pattern sources of the pattern to show. */
  patternIdx: number;

  /** Index into that pattern's files of the file to show. */
  fileIdx: number;

  /** One-based line number of the action. */
  line: number;
}

/**
 * Parses an action ID into a source location, returning `null` for an ID that
 * names none. IDs look like `"action:HASH/api/patterns/file.tsx:42:15"` or
 * `"/main.tsx:42:15 [via ...]"`; everything before the first `/` and any
 * trailing `[via ...]` are dropped.
 */
export function parseActionLocation(
  actionId: string,
): ActionLocation | null {
  let clean = actionId.replace(/\s*\[via.*\]$/, "");
  const slashIdx = clean.indexOf("/");
  if (slashIdx > 0) {
    clean = clean.slice(slashIdx);
  }
  const match = clean.match(/^(.+):(\d+):(\d+)$/);
  if (!match) return null;
  return {
    file: match[1],
    line: parseInt(match[2], 10),
    col: parseInt(match[3], 10),
  };
}

/**
 * Groups the nodes whose IDs name a source location by file and then by line.
 * A node naming a pattern other than `patternIdentity` is left out; a node
 * naming no pattern, or any node when `patternIdentity` is `undefined`, is
 * kept. Each entry's deltas are measured against its `baseline` entry, or
 * against zero where it has none.
 */
export function buildLineAnnotations(
  nodes: ReadonlyMap<string, SourceViewNode>,
  baseline: RunBaseline,
  patternIdentity: string | undefined,
): Map<string, Map<number, LineAnnotation>> {
  const result = new Map<string, Map<number, LineAnnotation>>();

  for (const [nodeId, node] of nodes) {
    const loc = parseActionLocation(nodeId);
    if (!loc) continue;
    if (
      patternIdentity !== undefined && node.patternIdentity &&
      node.patternIdentity !== patternIdentity
    ) {
      continue;
    }

    let fileMap = result.get(loc.file);
    if (!fileMap) {
      fileMap = new Map();
      result.set(loc.file, fileMap);
    }

    let annotation = fileMap.get(loc.line);
    if (!annotation) {
      annotation = {
        entries: [],
        types: new Set(),
        totalTime: 0,
        runCount: 0,
        deltaTime: 0,
        deltaRuns: 0,
      };
      fileMap.set(loc.line, annotation);
    }

    const totalTime = node.stats?.totalTime ?? 0;
    const runCount = node.stats?.runCount ?? 0;
    const base = baseline.get(nodeId);
    const deltaTime = totalTime - (base?.totalTime ?? 0);
    const deltaRuns = runCount - (base?.runCount ?? 0);

    annotation.entries.push({
      nodeId,
      col: loc.col,
      type: node.type,
      totalTime,
      runCount,
      deltaTime,
      deltaRuns,
    });
    annotation.types.add(node.type);
    annotation.totalTime += totalTime;
    annotation.runCount += runCount;
    annotation.deltaTime += deltaTime;
    annotation.deltaRuns += deltaRuns;
  }

  for (const fileMap of result.values()) {
    for (const ann of fileMap.values()) {
      ann.entries.sort((a, b) => a.col - b.col);
    }
  }

  return result;
}

/**
 * Returns a line's background color: transparent when `maxTime` is zero, and
 * otherwise blue for effects, violet for computations, or a blend of the two
 * where the line has both, more opaque the closer `totalTime` is to
 * `maxTime`.
 */
export function heatColor(
  totalTime: number,
  maxTime: number,
  types: ReadonlySet<string>,
): string {
  if (maxTime === 0) return "transparent";
  // The square root spreads the low end out, where most lines sit.
  const intensity = Math.sqrt(totalTime / maxTime);
  const alpha = 0.08 + intensity * 0.35;
  if (types.has("effect") && types.has("computation")) {
    return `rgba(99, 140, 255, ${alpha})`;
  } else if (types.has("computation")) {
    return `rgba(167, 139, 250, ${alpha})`;
  }
  return `rgba(59, 130, 246, ${alpha})`;
}

/**
 * Returns where the source of `nodeId`'s action is, or `null` where the ID
 * names no source location. The pattern is the one the node belongs to where
 * `patternSources` holds it, and `currentPatternIdx` otherwise; the file is
 * the one the location names where that pattern holds it, and
 * `currentFileIdx` otherwise.
 */
export function sourcePosition(
  nodeId: string,
  node: SourceViewNode | undefined,
  patternSources: readonly PatternSourceInfo[],
  currentPatternIdx: number,
  currentFileIdx: number,
): SourcePosition | null {
  const loc = parseActionLocation(nodeId);
  if (!loc) return null;

  const nodePatternIdx = node?.patternIdentity
    ? patternSources.findIndex((p) => p.identity === node.patternIdentity)
    : -1;
  const patternIdx = nodePatternIdx >= 0 ? nodePatternIdx : currentPatternIdx;

  const fileIdx = patternSources[patternIdx]?.files.findIndex(
    (f) => f.name === loc.file,
  ) ?? -1;
  return {
    patternIdx,
    fileIdx: fileIdx >= 0 ? fileIdx : currentFileIdx,
    line: loc.line,
  };
}
