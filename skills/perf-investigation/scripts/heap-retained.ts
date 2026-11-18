/**
 * Compares two V8 heap snapshots by retained size, per unit of the work between
 * them: bytes per create, say, between snapshots taken after 100 and 300 creates.
 * Retained sizes come from Lengauer-Tarjan dominators, so an object is charged to
 * what alone keeps it alive; an object two holders share is charged to where
 * their paths meet, often the root.
 *
 *   deno run -A --v8-flags=--max-old-space-size=40000 heap-retained.ts \
 *     <a.heapsnapshot> <b.heapsnapshot> <units> [--top N]
 *
 * Holders that overlap all charge to the root, so a large `(GC roots)` row says
 * to use heap-removal.ts next.
 */

import { type HeapGraph, readHeapGraph } from "./heap-snapshot-file.ts";

type Totals = { size: number; count: number };

/** What one snapshot retains, by constructor and by holder. */
type Retention = {
  total: number;
  byConstructor: Map<string, Totals>;
  byHolder: Map<string, Totals>;
};

/** Returns what the snapshot in the file at `path` retains. */
async function retentionOf(path: string): Promise<Retention> {
  const graph = await readHeapGraph(path);
  const tree = dominators(graph);
  const { vertex, dominator, parent, viaEdge, retained, count } = tree;

  const keyOf = (node: number) => constructorKey(graph, node);
  // Charged at the outermost instance only, so a tree of one class counts once.
  const byConstructor = new Map<string, Totals>();
  const childStart = new Uint32Array(count + 1);
  for (let i = 1; i < count; i++) childStart[dominator[i] + 1]++;
  for (let i = 0; i < count; i++) childStart[i + 1] += childStart[i];
  const children = new Uint32Array(count);
  const fill = childStart.slice();
  for (let i = 1; i < count; i++) children[fill[dominator[i]]++] = i;
  const depth = new Map<string, number>();
  const stack = new Uint32Array(count + 1);
  const cursor = new Uint32Array(count + 1);
  const enter = (i: number) => {
    const key = keyOf(vertex[i]);
    const at = depth.get(key) ?? 0;
    depth.set(key, at + 1);
    if (at > 0) return;
    const totals = byConstructor.get(key) ?? { size: 0, count: 0 };
    totals.size += retained[i];
    totals.count++;
    byConstructor.set(key, totals);
  };
  let top = 0;
  cursor[0] = childStart[0];
  enter(0);
  while (top >= 0) {
    const i = stack[top];
    if (cursor[top] < childStart[i + 1]) {
      const child = children[cursor[top]++];
      enter(child);
      top++;
      stack[top] = child;
      cursor[top] = childStart[child];
    } else {
      const key = keyOf(vertex[i]);
      depth.set(key, depth.get(key)! - 1);
      top--;
    }
  }

  const byHolder = new Map<string, Totals>();
  for (let i = 1; i < count; i++) {
    const holder = dominator[i];
    const edge = parent[i] === holder && viaEdge[i] >= 0
      ? graph.edgeLabel(viaEdge[i]).slice(0, 40)
      : "(shared)";
    const key = `${keyOf(vertex[holder])} .${edge} -> ${keyOf(vertex[i])}`;
    const totals = byHolder.get(key) ?? { size: 0, count: 0 };
    totals.size += retained[i];
    totals.count++;
    byHolder.set(key, totals);
  }
  return { total: retained[0], byConstructor, byHolder };
}

/** Returns a node's name, grouping what differs only by its address. */
function constructorKey(graph: HeapGraph, node: number): string {
  const type = graph.typeOf(node);
  const name = graph.nameOf(node);
  if (type.endsWith("string")) return `(${type})`;
  if (type === "number") return "(number)";
  if (name.startsWith("system / Context")) return "system / Context";
  if (type === "object") return name.slice(0, 70);
  return `(${type}) ${name.slice(0, 50)}`;
}

/**
 * Returns the dominator tree over depth-first numbers, the root numbered 0: each
 * number's node, its immediate dominator, its parent and edge in the depth-first
 * tree, and what it retains.
 */
function dominators(graph: HeapGraph) {
  const { nodeCount, firstEdge, retains, edgeTarget } = graph;
  const number = new Int32Array(nodeCount).fill(-1);
  const vertex = new Uint32Array(nodeCount);
  const parent = new Int32Array(nodeCount).fill(-1);
  const viaEdge = new Int32Array(nodeCount).fill(-1);
  let count = 0;
  const stackNode = new Uint32Array(nodeCount + 1);
  const stackEdge = new Uint32Array(nodeCount + 1);
  let top = 0;
  stackEdge[0] = firstEdge[0];
  number[0] = count;
  vertex[count++] = 0;
  while (top >= 0) {
    const node = stackNode[top];
    const edge = stackEdge[top];
    if (edge >= firstEdge[node + 1]) {
      top--;
      continue;
    }
    stackEdge[top] = edge + 1;
    if (!retains[edge]) continue;
    const to = edgeTarget(edge);
    if (number[to] >= 0) continue;
    number[to] = count;
    vertex[count] = to;
    parent[count] = number[node];
    viaEdge[count] = edge;
    count++;
    top++;
    stackNode[top] = to;
    stackEdge[top] = firstEdge[to];
  }

  const predecessorStart = new Uint32Array(count + 1);
  for (let i = 0; i < count; i++) {
    const node = vertex[i];
    for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge++) {
      if (retains[edge]) predecessorStart[number[edgeTarget(edge)] + 1]++;
    }
  }
  for (let i = 0; i < count; i++) {
    predecessorStart[i + 1] += predecessorStart[i];
  }
  const predecessors = new Uint32Array(predecessorStart[count]);
  const fill = predecessorStart.slice();
  for (let i = 0; i < count; i++) {
    const node = vertex[i];
    for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge++) {
      if (retains[edge]) predecessors[fill[number[edgeTarget(edge)]]++] = i;
    }
  }

  const semi = new Int32Array(count);
  const label = new Int32Array(count);
  const ancestor = new Int32Array(count).fill(-1);
  const dominator = new Int32Array(count);
  const bucketHead = new Int32Array(count).fill(-1);
  const bucketNext = new Int32Array(count).fill(-1);
  for (let i = 0; i < count; i++) {
    semi[i] = i;
    label[i] = i;
  }
  const path = new Int32Array(count + 1);
  const evaluate = (v: number) => {
    if (ancestor[v] < 0) return label[v];
    let length = 0;
    let at = v;
    while (ancestor[ancestor[at]] >= 0) {
      path[length++] = at;
      at = ancestor[at];
    }
    while (length > 0) {
      const w = path[--length];
      const above = ancestor[w];
      if (semi[label[above]] < semi[label[w]]) label[w] = label[above];
      ancestor[w] = ancestor[above];
    }
    return label[v];
  };
  for (let w = count - 1; w >= 1; w--) {
    for (let k = predecessorStart[w]; k < predecessorStart[w + 1]; k++) {
      const u = evaluate(predecessors[k]);
      if (semi[u] < semi[w]) semi[w] = semi[u];
    }
    bucketNext[w] = bucketHead[semi[w]];
    bucketHead[semi[w]] = w;
    const above = parent[w];
    ancestor[w] = above;
    for (let v = bucketHead[above]; v >= 0; v = bucketNext[v]) {
      const u = evaluate(v);
      dominator[v] = semi[u] < semi[v] ? u : above;
    }
    bucketHead[above] = -1;
  }
  for (let w = 1; w < count; w++) {
    if (dominator[w] !== semi[w]) dominator[w] = dominator[dominator[w]];
  }

  const retained = new Float64Array(count);
  for (let i = 0; i < count; i++) retained[i] = graph.selfSizeOf(vertex[i]);
  for (let i = count - 1; i >= 1; i--) retained[dominator[i]] += retained[i];
  return { vertex, dominator, parent, viaEdge, retained, count };
}

/** Prints the rows of `b` that grew most over `a`, per unit. */
function printGrowth(
  title: string,
  a: Map<string, Totals>,
  b: Map<string, Totals>,
  units: number,
  top: number,
): void {
  console.log(`\n${title}: KB per unit, instances per unit`);
  const rows = [...b].map(([key, totals]) => {
    const before = a.get(key);
    return {
      key,
      size: (totals.size - (before?.size ?? 0)) / units,
      count: (totals.count - (before?.count ?? 0)) / units,
    };
  }).sort((x, y) => y.size - x.size);
  for (const row of rows.slice(0, top)) {
    console.log(
      `${(row.size / 1e3).toFixed(1).padStart(9)} ${
        row.count.toFixed(1).padStart(9)
      }  ${row.key}`,
    );
  }
}

if (import.meta.main) {
  const [pathA, pathB, unitsArgument] = Deno.args;
  const units = Number(unitsArgument);
  if (pathA === undefined || pathB === undefined || !(units > 0)) {
    console.error("usage: heap-retained.ts <a> <b> <units> [--top N]");
    Deno.exit(2);
  }
  const topAt = Deno.args.indexOf("--top");
  const top = topAt >= 0 ? Number(Deno.args[topAt + 1]) : 40;
  const a = await retentionOf(pathA);
  const b = await retentionOf(pathB);
  console.log(
    `a ${(a.total / 1e6).toFixed(0)} MB, b ${(b.total / 1e6).toFixed(0)} MB, ` +
      `growth per unit ${((b.total - a.total) / units / 1e3).toFixed(0)} KB`,
  );
  printGrowth("By constructor", a.byConstructor, b.byConstructor, units, top);
  printGrowth("By holder", a.byHolder, b.byHolder, units, top * 2);
}
