/**
 * Reads a V8 heap snapshot of any size as typed arrays, for the heap tools beside
 * this file. A snapshot past about 512 MB is longer than the longest string V8
 * can hold, so `JSON.parse()` cannot read it.
 *
 * Reachability here means what retains an object. A weak edge retains nothing, a
 * shortcut edge is a second name for a path that exists anyway, and a WeakMap's
 * table holds an edge to each value that retains nothing either: the entry's
 * value is kept by its key, which has an edge of its own. Following the table's
 * edge reports retaining paths that do not exist.
 */

/** The part of a snapshot's header these tools read. */
type SnapshotHeader = {
  meta: {
    node_fields: string[];
    node_types: [string[], ...unknown[]];
    edge_fields: string[];
    edge_types: [string[], ...unknown[]];
  };
  node_count: number;
  edge_count: number;
};

/** A heap snapshot's graph, nodes numbered from 0 with the root first. */
export type HeapGraph = {
  nodeCount: number;
  /** The index of the first edge of each node, then the number of edges. */
  firstEdge: Uint32Array;
  /** Whether each edge retains its target. */
  retains: Uint8Array;
  /** The node an edge leads to. */
  edgeTarget: (edge: number) => number;
  /** The string an edge is named by, or `undefined` for an element's index. */
  edgeNameIndex: (edge: number) => number | undefined;
  /** An edge's name, with an element and a WeakMap's value given short names. */
  edgeLabel: (edge: number) => string;
  /** The index of a node's name among `strings`. */
  nameIndexOf: (node: number) => number;
  nameOf: (node: number) => string;
  typeOf: (node: number) => string;
  selfSizeOf: (node: number) => number;
  /** The index of `text` among the snapshot's strings, if it has it. */
  stringIndexOf: (text: string) => number | undefined;
  stringCount: number;
};

/** Returns the graph of the snapshot in the file at `path`. */
export async function readHeapGraph(path: string): Promise<HeapGraph> {
  const bytes = await Deno.readFile(path);
  const nodesAt = find(bytes, '"nodes":[');
  const head = new TextDecoder().decode(bytes.subarray(0, nodesAt));
  const header: SnapshotHeader = JSON.parse(
    head.slice(head.indexOf(":") + 1, head.lastIndexOf("}") + 1),
  );
  const nodeFieldCount = header.meta.node_fields.length;
  const edgeFieldCount = header.meta.edge_fields.length;
  const [nodes, afterNodes] = readIntegers(
    bytes,
    nodesAt + 9,
    header.node_count * nodeFieldCount,
  );
  const edgesAt = find(bytes, '"edges":[', afterNodes - 1);
  const [edges, afterEdges] = readIntegers(
    bytes,
    edgesAt + 9,
    header.edge_count * edgeFieldCount,
  );
  const stringsAt = find(bytes, '"strings":[', afterEdges - 1);
  const strings = readStrings(bytes, stringsAt + 11);

  const typeField = header.meta.node_fields.indexOf("type");
  const nameField = header.meta.node_fields.indexOf("name");
  const idField = header.meta.node_fields.indexOf("id");
  const selfField = header.meta.node_fields.indexOf("self_size");
  const edgeCountField = header.meta.node_fields.indexOf("edge_count");
  const edgeTypeField = header.meta.edge_fields.indexOf("type");
  const edgeNameField = header.meta.edge_fields.indexOf("name_or_index");
  const toField = header.meta.edge_fields.indexOf("to_node");
  const nodeTypes = header.meta.node_types[0];
  const edgeTypes = header.meta.edge_types[0];
  const weak = edgeTypes.indexOf("weak");
  const shortcut = edgeTypes.indexOf("shortcut");
  const element = edgeTypes.indexOf("element");
  const hidden = edgeTypes.indexOf("hidden");
  const internal = edgeTypes.indexOf("internal");

  const firstEdge = new Uint32Array(header.node_count + 1);
  let edgeIndex = 0;
  for (let node = 0; node < header.node_count; node++) {
    firstEdge[node] = edgeIndex;
    edgeIndex += nodes[node * nodeFieldCount + edgeCountField];
  }
  firstEdge[header.node_count] = edgeIndex;

  // A WeakMap's table names each pair with the table's own id.
  const tableOfPair = new Map<number, number>();
  const pairName = /pair in WeakMap \(table @(\d+)\)$/;
  strings.forEach((text, index) => {
    if (text.length < 40 || !text.includes("part of key")) return;
    const match = pairName.exec(text);
    if (match) tableOfPair.set(index, Number(match[1]));
  });

  const retains = new Uint8Array(header.edge_count);
  for (let node = 0; node < header.node_count; node++) {
    const id = nodes[node * nodeFieldCount + idField];
    for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge++) {
      const type = edges[edge * edgeFieldCount + edgeTypeField];
      if (type === weak || (type === shortcut && node !== 0)) continue;
      if (
        type === internal &&
        tableOfPair.get(edges[edge * edgeFieldCount + edgeNameField]) === id
      ) continue;
      retains[edge] = 1;
    }
  }

  const edgeNameIndex = (edge: number) => {
    const type = edges[edge * edgeFieldCount + edgeTypeField];
    return type === element || type === hidden
      ? undefined
      : edges[edge * edgeFieldCount + edgeNameField];
  };
  return {
    nodeCount: header.node_count,
    firstEdge,
    retains,
    edgeTarget: (edge) =>
      edges[edge * edgeFieldCount + toField] / nodeFieldCount,
    edgeNameIndex,
    edgeLabel: (edge) => {
      const index = edgeNameIndex(edge);
      if (index === undefined) return "[]";
      const text = strings[index] ?? "?";
      return text.includes("part of key") ? "(weakmap value)" : text;
    },
    nameIndexOf: (node) => nodes[node * nodeFieldCount + nameField],
    nameOf: (node) => strings[nodes[node * nodeFieldCount + nameField]] ?? "?",
    typeOf: (node) => nodeTypes[nodes[node * nodeFieldCount + typeField]],
    selfSizeOf: (node) => nodes[node * nodeFieldCount + selfField],
    stringIndexOf: (text) => {
      const index = strings.indexOf(text);
      return index === -1 ? undefined : index;
    },
    stringCount: strings.length,
  };
}

/** Returns the offset of the first `needle` in `bytes` at or after `from`. */
function find(bytes: Uint8Array, needle: string, from = 0): number {
  const encoded = new TextEncoder().encode(needle);
  outer: for (let i = from; i < bytes.length - encoded.length; i++) {
    if (bytes[i] !== encoded[0]) continue;
    for (let j = 1; j < encoded.length; j++) {
      if (bytes[i + j] !== encoded[j]) continue outer;
    }
    return i;
  }
  throw new Error(`The snapshot has no ${needle}`);
}

/** Returns `count` integers from `from`, and the offset after the last. */
function readIntegers(
  bytes: Uint8Array,
  from: number,
  count: number,
): [Uint32Array, number] {
  const out = new Uint32Array(count);
  let at = from;
  let index = 0;
  let value = 0;
  let inNumber = false;
  while (index < count) {
    const code = bytes[at++];
    if (code >= 48 && code <= 57) {
      value = value * 10 + (code - 48);
      inNumber = true;
    } else if (inNumber) {
      out[index++] = value;
      value = 0;
      inNumber = false;
    }
  }
  return [out, at];
}

/** Returns the JSON strings of an array whose first is at or after `from`. */
function readStrings(bytes: Uint8Array, from: number): string[] {
  const strings: string[] = [];
  const decoder = new TextDecoder();
  let at = from;
  while (at < bytes.length) {
    const code = bytes[at];
    if (code === 93) break;
    if (code !== 34) {
      at++;
      continue;
    }
    let end = at + 1;
    let escaped = false;
    while (bytes[end] !== 34) {
      if (bytes[end] === 92) {
        escaped = true;
        end += 2;
      } else end++;
    }
    const text = decoder.decode(bytes.subarray(at + 1, end));
    strings.push(escaped ? unescapeString(text) : text);
    at = end + 1;
  }
  return strings;
}

/** Returns a string with its JSON escapes decoded, where they all decode. */
function unescapeString(text: string): string {
  try {
    return JSON.parse(`"${text}"`);
  } catch {
    return text;
  }
}
