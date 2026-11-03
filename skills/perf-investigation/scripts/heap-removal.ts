/**
 * Says how much of the growth between two V8 heap snapshots each holder accounts
 * for. Removing one of several holders of the same objects frees nothing, so
 * holders are removed cumulatively, in the order given, and each line reports the
 * growth per unit left once it and those above it are gone. What stays is grouped
 * by a coarse shortest retaining path, which names the next holder to try.
 *
 *   deno run -A --v8-flags=--max-old-space-size=40000 heap-removal.ts \
 *     <a.heapsnapshot> <b.heapsnapshot> <units> \
 *     [--cut edge:#docs] [--cut node:ExtendedStorageTransaction] ...
 *
 * `edge:NAME` removes every edge so named: a private field, or a closure's
 * variable. `node:NAME` removes every object so named, whatever reaches it.
 */

import { type HeapGraph, readHeapGraph } from "./heap-snapshot-file.ts";

type Cut = { kind: string; name: string };

/** The total a snapshot keeps after each cumulative cut, and what stays. */
type Removal = {
  totals: Map<string, number>;
  left: Map<string, number>;
};

/** Path steps a shortest path passes through that say nothing about a holder. */
const UNNAMED_STEPS = new Set([
  "rootContext",
  "frames",
  "runtime",
  "value",
  "table",
  "context",
  "previous",
  "[]",
]);

/** How many steps of a path name the group it falls in. */
const PATH_STEPS = 6;

/** Returns what the snapshot in the file at `path` keeps under `cuts`. */
async function removalOf(path: string, cuts: Cut[]): Promise<Removal> {
  const graph = await readHeapGraph(path);
  const { nodeCount, firstEdge, retains } = graph;
  const edgeCut = new Uint8Array(graph.stringCount);
  const nodeCut = new Uint8Array(graph.stringCount);
  const seen = new Uint8Array(nodeCount);
  const queue = new Uint32Array(nodeCount);
  const parentEdge = new Int32Array(nodeCount).fill(-1);
  const parentNode = new Int32Array(nodeCount).fill(-1);
  const reach = () => {
    seen.fill(0);
    parentEdge.fill(-1);
    parentNode.fill(-1);
    let head = 0;
    let tail = 0;
    let total = 0;
    queue[tail++] = 0;
    seen[0] = 1;
    while (head < tail) {
      const node = queue[head++];
      total += graph.selfSizeOf(node);
      for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge++) {
        if (!retains[edge]) continue;
        const nameIndex = graph.edgeNameIndex(edge);
        if (nameIndex !== undefined && edgeCut[nameIndex]) continue;
        const to = graph.edgeTarget(edge);
        if (seen[to] || nodeCut[graph.nameIndexOf(to)]) continue;
        seen[to] = 1;
        parentEdge[to] = edge;
        parentNode[to] = node;
        queue[tail++] = to;
      }
    }
    return total;
  };

  const totals = new Map<string, number>([["(nothing removed)", reach()]]);
  for (const cut of cuts) {
    const index = graph.stringIndexOf(cut.name);
    if (index !== undefined) {
      (cut.kind === "node" ? nodeCut : edgeCut)[index] = 1;
    }
    totals.set(`${cut.kind}:${cut.name}`, reach());
  }
  return {
    totals,
    left: groupByPath(graph, seen, parentEdge, parentNode),
  };
}

/** Returns the self size of what is reachable, by a coarse retaining path. */
function groupByPath(
  graph: HeapGraph,
  seen: Uint8Array,
  parentEdge: Int32Array,
  parentNode: Int32Array,
): Map<string, number> {
  const steps = new Map<number, string[]>();
  const stepsOf = (node: number): string[] => {
    const chain: number[] = [];
    let at = node;
    while (parentEdge[at] >= 0 && !steps.has(at)) {
      chain.push(at);
      at = parentNode[at];
    }
    let known = steps.get(at) ?? [];
    for (let i = chain.length - 1; i >= 0; i--) {
      const label = graph.edgeLabel(parentEdge[chain[i]]);
      const named = !UNNAMED_STEPS.has(label) && !/^\d+$/.test(label);
      if (named && known.length < PATH_STEPS) {
        known = [...known, label.slice(0, 28)];
      }
      steps.set(chain[i], known);
    }
    return known;
  };
  const groups = new Map<string, number>();
  for (let node = 0; node < graph.nodeCount; node++) {
    if (!seen[node] || graph.typeOf(node) === "code") continue;
    const size = graph.selfSizeOf(node);
    if (size === 0) continue;
    const key = stepsOf(node).join(" > ");
    groups.set(key, (groups.get(key) ?? 0) + size);
  }
  return groups;
}

if (import.meta.main) {
  const [pathA, pathB, unitsArgument] = Deno.args;
  const units = Number(unitsArgument);
  if (pathA === undefined || pathB === undefined || !(units > 0)) {
    console.error("usage: heap-removal.ts <a> <b> <units> [--cut kind:name]");
    Deno.exit(2);
  }
  const cuts: Cut[] = [];
  for (let i = 3; i < Deno.args.length; i++) {
    if (Deno.args[i] !== "--cut") continue;
    const [kind, ...rest] = Deno.args[++i].split(":");
    cuts.push({ kind, name: rest.join(":") });
  }
  const a = await removalOf(pathA, cuts);
  const b = await removalOf(pathB, cuts);
  console.log("KB per unit growing after each cumulative removal:");
  for (const [key, total] of b.totals) {
    const growth = (total - (a.totals.get(key) ?? 0)) / units / 1e3;
    console.log(`${growth.toFixed(0).padStart(8)}  ${key}`);
  }
  console.log("\nKB per unit left, by shortest retaining path:");
  const rows = [...b.left].map(([key, size]): [string, number] => [
    key,
    (size - (a.left.get(key) ?? 0)) / units / 1e3,
  ]).sort((x, y) => y[1] - x[1]);
  for (const [key, growth] of rows.slice(0, 30)) {
    console.log(`${growth.toFixed(1).padStart(8)}  ${key}`);
  }
}
