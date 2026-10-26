/**
 * Counts what a storage transaction wrote: how many documents it touched, and
 * how many JSON bytes it put into them.
 *
 * `tx.journal.novelty(space)` yields one attestation per written path, and a
 * single `cell.set()` produces many: the path the write was made at, and a path
 * for each slot below it that changed. Each value is a snapshot taken as its
 * own part of the write landed, so a write below the root shows up as a
 * container recorded empty with its contents on the paths under it, while a
 * write of a whole document shows up as the document value with its parts
 * repeated under it. Adding up every attestation counts the same bytes several
 * times over in the second shape, and drops the key names in the first.
 *
 * These functions read the attestations as what they are: a set of writes, some
 * of which sit inside others. For each document they keep the writes no other
 * write encloses, and rebuild each one's value from the writes below it. What
 * comes back is one value per top-level write, which is what that transaction
 * put into storage.
 *
 * The journal a transaction wrote is only readable while the transaction is
 * open. `commit()` releases it on the way to settling, so a caller that wants
 * these numbers reads them before it commits.
 */

import { isObjectOrArray } from "@commonfabric/utils/types";
import type { IAttestation } from "../src/storage/interface.ts";

/** One top-level write: a document, a path in it, and the value written. */
export interface WrittenValue {
  /** The document the write landed in. */
  id: string;

  /** Where in the document it landed. */
  path: readonly string[];

  /** What it put there; undefined when the write removed the slot. */
  value: unknown;
}

/** How much a transaction wrote. */
export interface WriteAccount {
  /** Documents the transaction wrote to. */
  docs: number;

  /** JSON bytes it wrote into them. */
  bytes: number;
}

const encoder = new TextEncoder();

/**
 * The number of bytes `value` occupies as JSON, and zero for a value JSON does
 * not represent. Counted as encoded bytes rather than as string length, which
 * counts UTF-16 code units and so reads one byte for a character that takes
 * two, three, or four.
 */
export function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) return 0;
  return encoder.encode(json).byteLength;
}

interface PathNode {
  /** True when an attestation named this exact path. */
  written: boolean;

  value: unknown;
  children: Map<string, PathNode>;
}

function emptyNode(): PathNode {
  return { written: false, value: undefined, children: new Map() };
}

/** Builds the container the keys of `children` describe. */
function containerFor(children: Map<string, PathNode>): unknown {
  for (const key of children.keys()) {
    if (!/^(0|[1-9][0-9]*)$/.test(key)) return {};
  }
  return [];
}

/**
 * Rebuilds the value a write put at `node`'s path, replacing each slot that a
 * write below it named. `inherited` is what the enclosing value holds at this
 * path, which stands where no attestation named the path itself. A slot with no
 * write below it keeps what it already held, which is how a value written whole
 * survives intact.
 */
function materialize(node: PathNode, inherited: unknown): unknown {
  const base = node.written ? node.value : inherited;
  if (node.children.size === 0) return base;
  const container = isObjectOrArray(base) ? base : containerFor(node.children);
  if (Array.isArray(container)) {
    const out = [...container];
    for (const [index, child] of node.children) {
      const slot = Number(index);
      out[slot] = materialize(child, out[slot]);
    }
    return out;
  }
  const out = { ...container as Record<string, unknown> };
  for (const [key, child] of node.children) {
    out[key] = materialize(child, out[key]);
  }
  return out;
}

/** Collects the top-level writes under `node`, whose path is `prefix`. */
function collect(
  id: string,
  prefix: readonly string[],
  node: PathNode,
  out: WrittenValue[],
): void {
  if (node.written) {
    out.push({ id, path: prefix, value: materialize(node, undefined) });
    return;
  }
  for (const [key, child] of node.children) {
    collect(id, [...prefix, key], child, out);
  }
}

/**
 * Returns the top-level writes a transaction's novelty describes, one per
 * document path that no other written path encloses.
 */
export function noveltyWrites(
  novelty: Iterable<IAttestation>,
): WrittenValue[] {
  const docs = new Map<string, PathNode>();
  for (const attestation of novelty) {
    const { id, path } = attestation.address;
    let node: PathNode | undefined = docs.get(id);
    if (node === undefined) {
      node = emptyNode();
      docs.set(id, node);
    }
    for (const segment of path) {
      let child: PathNode | undefined = node.children.get(segment);
      if (child === undefined) {
        child = emptyNode();
        node.children.set(segment, child);
      }
      node = child;
    }
    node.written = true;
    node.value = attestation.value;
  }
  const writes: WrittenValue[] = [];
  for (const [id, root] of docs) collect(id, [], root, writes);
  return writes;
}

/** Counts the documents a transaction wrote and the JSON bytes it wrote. */
export function accountNovelty(
  novelty: Iterable<IAttestation>,
): WriteAccount {
  const writes = noveltyWrites(novelty);
  const ids = new Set(writes.map((write) => write.id));
  let bytes = 0;
  for (const { value } of writes) bytes += jsonBytes(value);
  return { docs: ids.size, bytes };
}

/** Adds two accounts, for totalling across transactions. */
export function addAccounts(a: WriteAccount, b: WriteAccount): WriteAccount {
  return { docs: a.docs + b.docs, bytes: a.bytes + b.bytes };
}
