/**
 * Decoded values shared by vid: each stored object, a whole value or a
 * subtree that recurs under several parents, is decoded at most once while
 * its decoded form is reachable, and every document that contains it holds
 * that one decoded form by reference.
 *
 * Sharing is sound because nothing mutates a decoded value: the codec
 * deep-freezes what it builds, and patch application copies the containers
 * on each patched path and keeps the rest by reference (`patch.ts`). It is
 * exact because decoding a value in value position depends on that value
 * alone. Under a tag wrapper other than `/object`, and as the direct state of
 * `/object`, the codec hands the raw state on instead of decoding it, so a
 * stored object found there is spliced in as its raw tree before the decode:
 * its JSON parsed and deep-frozen, which is what a `/quote` decodes to. Raw
 * trees are shared by vid in the same way, each one a separate form from the
 * object's decoded form.
 */

import { deepFreeze, type FabricValue } from "@commonfabric/data-model";
import { NullLiveEnvironment } from "@commonfabric/data-model/codec-common";
import { JsonDecodeAct } from "@commonfabric/data-model/codec-json";
import { newDefaultJsonCodecEngine } from "@commonfabric/data-model/codecs";

import {
  decodeStoredDocumentPayload,
  decodeStoredPatchListPayload,
  decodeTrustedMemoryBoundary,
  type EntityDocument,
  type PatchOp,
} from "../v2.ts";
import type { ValueCell, ValueStore } from "./value-store.ts";

export type SharedValuesOptions = {
  /** Budget of the decoded-string cache, as twice the UTF-16 length. Default 4 MiB. */
  stringCacheBytes?: number;
};

export type SharedValuesStats = {
  /** Decoded objects still reachable, plus cached strings. */
  live: number;
  /** Stored objects decoded. */
  decodes: number;
  /** Requests answered with a decoded form already held. */
  hits: number;
  /** Decodes that went through the object's full text. */
  fallbacks: number;
  /** References spliced in as raw JSON under a tag wrapper. */
  materializedChildren: number;
  /** Raw trees built for those references. */
  rawForms: number;
};

const DEFAULT_STRING_CACHE_BYTES = 4 * 1024 * 1024;

/** Where a raw tree holds a reference to another stored object. */
class ChildRef {
  constructor(readonly vid: number) {}
}

const childRefOf = (vid: number): ChildRef => new ChildRef(vid);

type RawNode = Parameters<JsonDecodeAct["decodeValue"]>[0];

/**
 * The codec's decode walk, except that a {@link ChildRef} decodes to the
 * shared form of the object it names. `JsonDecodeAct` reaches every value
 * position through `decodeValue`, so the override sees every reference.
 */
class SharedDecodeAct extends JsonDecodeAct {
  readonly #shared: SharedValues;

  constructor(shared: SharedValues) {
    super(
      newDefaultJsonCodecEngine(),
      new NullLiveEnvironment("no cell decoding at the memory boundary"),
    );
    this.#shared = shared;
  }

  override decodeValue(data: RawNode): FabricValue {
    const node: unknown = data;
    if (node instanceof ChildRef) return this.#shared.valueOf(node.vid);
    return super.decodeValue(data);
  }
}

/**
 * The single tag of a wire-form tag wrapper (a plain record with one key,
 * starting with `/`), or undefined for any other record.
 */
const tagOf = (record: Record<string, unknown>): string | undefined => {
  let tag: string | undefined;
  for (const key in record) {
    if (tag !== undefined || !key.startsWith("/")) return undefined;
    tag = key;
  }
  return tag;
};

/**
 * Sets `key` as an own data property, as `JSON.parse` would, so that a key
 * such as `__proto__` stays a member rather than repointing the prototype.
 */
const setOwn = (
  record: Record<string, unknown>,
  key: string,
  value: unknown,
): void => {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
};

/**
 * Shares decoded values by vid over one {@link ValueStore}.
 *
 * Decoded objects and arrays, and raw trees, are held weakly, so the tables
 * pin nothing. Strings, which a `WeakRef` cannot hold and whose decoded and
 * raw forms are the same string, are held in a bounded least-recently-used
 * cache. A vid a rolled-back transaction wrote can name different content
 * afterwards, so what a decode inside a transaction learns is kept only in a
 * staged layer that {@link settle} publishes on commit, as the value store's
 * own caches are, and a raw tree built inside a transaction is not kept.
 */
export class SharedValues {
  readonly #values: ValueStore;
  readonly #act: SharedDecodeAct;
  /** Decoded objects and arrays by vid. */
  readonly #objects = new Map<number, WeakRef<object>>();
  /** Raw trees by vid. */
  readonly #raws = new Map<number, WeakRef<object>>();
  readonly #collected = new FinalizationRegistry<
    { table: Map<number, WeakRef<object>>; vid: number; ref: WeakRef<object> }
  >(({ table, vid, ref }) => {
    // The vid may name a later copy by now, made after this one was
    // collected and before this callback ran.
    if (table.get(vid) === ref) table.delete(vid);
  });
  /** Strings, least recently used first. */
  readonly #strings = new Map<number, string>();
  #stringBytes = 0;
  readonly #stringBudget: number;
  /** Staged layers, innermost last. */
  readonly #staged: Map<number, FabricValue>[] = [];
  readonly #stats = {
    decodes: 0,
    hits: 0,
    fallbacks: 0,
    materializedChildren: 0,
    rawForms: 0,
  };

  constructor(values: ValueStore, options: SharedValuesOptions = {}) {
    this.#values = values;
    this.#stringBudget = options.stringCacheBytes ??
      DEFAULT_STRING_CACHE_BYTES;
    this.#act = new SharedDecodeAct(this);
  }

  /**
   * What `decodeTrustedMemoryBoundary("fvj1:" + fragmentText(vid))` returns,
   * decoded at most once while any reference to the result is alive, and the
   * same object for every caller meanwhile.
   */
  valueOf(vid: number): FabricValue {
    const held = this.#held(vid);
    if (held !== undefined) {
      this.#stats.hits++;
      return held;
    }
    const value = this.#decode(vid);
    this.#remember(vid, value);
    return value;
  }

  /**
   * The document a stored `set` cell holds, as `decodeStoredDocumentPayload`
   * reads it: shared for a vid, decoded per call for text.
   */
  documentOf(cell: ValueCell): EntityDocument {
    if (typeof cell !== "number") {
      return decodeStoredDocumentPayload(decodeTrustedMemoryBoundary, cell);
    }
    // The payload argument only has to be present; the decode reads the vid.
    return decodeStoredDocumentPayload(() => this.valueOf(cell), "");
  }

  /** The patches a stored `patch` cell holds, as `decodeStoredPatchListPayload` reads them. */
  patchListOf(cell: ValueCell): PatchOp[] {
    if (typeof cell !== "number") {
      return decodeStoredPatchListPayload(decodeTrustedMemoryBoundary, cell);
    }
    return decodeStoredPatchListPayload(() => this.valueOf(cell), "");
  }

  /** Opens a staged layer for what decodes inside a transaction learn. */
  stage(): void {
    this.#staged.push(new Map());
  }

  /**
   * Closes the innermost staged layer, moving its entries into the layer
   * below (or publishing them) when `committed`, dropping them otherwise.
   */
  settle(committed: boolean): void {
    const layer = this.#staged.pop();
    if (layer === undefined || !committed) return;
    const below = this.#staged[this.#staged.length - 1];
    for (const [vid, value] of layer) {
      if (below !== undefined) below.set(vid, value);
      else this.#publish(vid, value);
    }
  }

  /**
   * The counters. `live` walks the tables to count the decoded objects and
   * raw trees not yet collected, so it costs one `deref` per entry.
   */
  stats(): SharedValuesStats {
    let live = this.#strings.size;
    for (const table of [this.#objects, this.#raws]) {
      for (const ref of table.values()) {
        if (ref.deref() !== undefined) live++;
      }
    }
    return { live, ...this.#stats };
  }

  #held(vid: number): FabricValue | undefined {
    for (let layer = this.#staged.length - 1; layer >= 0; layer--) {
      const value = this.#staged[layer].get(vid);
      if (value !== undefined) return value;
    }
    const object = this.#objects.get(vid)?.deref();
    if (object !== undefined) return object as FabricValue;
    const string = this.#strings.get(vid);
    if (string !== undefined) {
      this.#strings.delete(vid);
      this.#strings.set(vid, string);
    }
    return string;
  }

  /**
   * Decodes object `vid` from its raw tree, falling back once to its full
   * text when the tree cannot be built (the object's own text holds the
   * placeholder's escape) or when anything on the way throws, so that a
   * malformed store throws exactly what the codec throws for it.
   */
  #decode(vid: number): FabricValue {
    this.#stats.decodes++;
    try {
      const raw = this.#values.rawTree(vid, childRefOf);
      if (raw !== undefined) {
        return this.#act.decodeValue(this.#rawUnderTags(raw, false) as RawNode);
      }
    } catch {
      // Decoded below from the full text, which throws what the codec does.
    }
    this.#stats.fallbacks++;
    return decodeTrustedMemoryBoundary(this.#values.rowText(vid)!);
  }

  /**
   * `node` with every reference the codec would not decode in place replaced
   * by the referenced object's raw tree: each one beneath a tag wrapper other
   * than `/object`, and one that is the direct state of `/object`. `raw` is
   * set beneath such a wrapper. Containers are copied only on the paths that
   * change.
   */
  #rawUnderTags(node: unknown, raw: boolean): unknown {
    if (node instanceof ChildRef) {
      if (!raw) return node;
      this.#stats.materializedChildren++;
      return this.#rawOf(node.vid);
    }
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) {
      let copy: unknown[] | undefined;
      for (let index = 0; index < node.length; index++) {
        const entry = this.#rawUnderTags(node[index], raw);
        if (entry !== node[index]) (copy ??= [...node])[index] = entry;
      }
      return copy === undefined ? node : Object.freeze(copy);
    }
    const record = node as Record<string, unknown>;
    const tag = raw ? undefined : tagOf(record);
    if (tag === "/object") {
      const state = record[tag];
      const rawState = state instanceof ChildRef
        ? this.#rawUnderTags(state, true)
        : this.#rawMembers(state, false);
      return rawState === state ? node : Object.freeze({ [tag]: rawState });
    }
    return this.#rawMembers(node, raw || tag !== undefined);
  }

  /** `node` with {@link #rawUnderTags} applied to each member of a record. */
  #rawMembers(node: unknown, raw: boolean): unknown {
    if (
      node === null || typeof node !== "object" || Array.isArray(node) ||
      node instanceof ChildRef
    ) {
      return this.#rawUnderTags(node, raw);
    }
    const record = node as Record<string, unknown>;
    let copy: Record<string, unknown> | undefined;
    for (const key in record) {
      const member = this.#rawUnderTags(record[key], raw);
      if (member !== record[key]) setOwn(copy ??= { ...record }, key, member);
    }
    return copy === undefined ? node : Object.freeze(copy);
  }

  /**
   * The raw tree of object `vid`, with each stored descendant's own raw tree
   * shared by reference. Kept only when built outside a transaction.
   */
  #rawOf(vid: number): unknown {
    const held = this.#raws.get(vid)?.deref() ?? this.#strings.get(vid);
    if (held !== undefined) return held;
    this.#stats.rawForms++;
    const raw = this.#values.rawTree(vid, (child) => this.#rawOf(child)) ??
      deepFreeze(JSON.parse(this.#values.fragmentText(vid)));
    if (!this.#values.inTransaction) {
      if (typeof raw === "string") this.#publishString(vid, raw);
      else if (raw !== null && typeof raw === "object") {
        this.#hold(this.#raws, vid, raw);
      }
    }
    return raw;
  }

  /**
   * Keeps `value` for `vid`: published outside a transaction, staged inside
   * one when a layer is open, and nowhere otherwise.
   */
  #remember(vid: number, value: FabricValue): void {
    if (!this.#values.inTransaction) this.#publish(vid, value);
    else if (this.#staged.length > 0) {
      this.#staged[this.#staged.length - 1].set(vid, value);
    }
  }

  #publish(vid: number, value: FabricValue): void {
    if (typeof value === "string") {
      this.#publishString(vid, value);
    } else if (value !== null && typeof value === "object") {
      this.#hold(this.#objects, vid, value);
    }
  }

  #hold(table: Map<number, WeakRef<object>>, vid: number, value: object) {
    const ref = new WeakRef(value);
    table.set(vid, ref);
    this.#collected.register(value, { table, vid, ref });
  }

  #publishString(vid: number, value: string): void {
    const weight = 2 * value.length;
    if (weight > this.#stringBudget) return;
    const previous = this.#strings.get(vid);
    if (previous !== undefined) {
      this.#strings.delete(vid);
      this.#stringBytes -= 2 * previous.length;
    }
    this.#strings.set(vid, value);
    this.#stringBytes += weight;
    for (const [oldest, old] of this.#strings) {
      if (this.#stringBytes <= this.#stringBudget) break;
      this.#strings.delete(oldest);
      this.#stringBytes -= 2 * old.length;
    }
  }
}
