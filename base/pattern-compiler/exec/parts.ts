/**
 * The documents that a logical document of the store is stored in, by
 * provisional decision P20 on `execution-and-storage.md` §4.10: a row of
 * an array is a part document of its own from `PART_MIN_BYTES` on, and an
 * array whose content is over `DOCUMENT_MAX_BYTES` is stored as chunk
 * documents, each a contiguous run of its rows, under a list of links to
 * the chunks that is chunked the same way.
 *
 * `Store` reports each change of a logical document (`changed()`), and a
 * transaction asks at its end which documents it wrote (`seal()`). A read
 * (`read()`, `rows()`, `materialize()`) starts at the holder document and
 * passes through each list, chunk and part on the way.
 *
 * Bounds of what this holds. The split points are the arrays that no
 * other array holds, and their rows: an array inside a row is stored with
 * the row. A row that is a record is held by reference, as the store
 * holds it, and not as a copy. A part document over the maximum is not
 * split further. Label entries and provenance are in no size.
 */

/** The size from which a row is stored as a part of its own. */
export const PART_MIN_BYTES = 1_024;

/** The size over which the content of an array or a chunk is split. */
export const DOCUMENT_MAX_BYTES = 65_536;

/** The bytes of a storage link: `{ "$part": <identifier> }`. */
export const LINK_BYTES = 61;

/** How the part documents are laid out. */
export type PartsOptions = {
  partMinBytes?: number;
  documentMaxBytes?: number;
  /**
   * Whether a list of chunks holds the count of rows below each link.
   * With `stored`, a position is found from the lists alone, and an
   * insertion or a removal writes each list above its chunk. With
   * `none`, as P20 words it, a list is written on a split or a merge
   * alone, and a position is found by reading the chunks before it.
   */
  counts?: "stored" | "none";
  /**
   * What the identifier of a row's part is formed from: the key of the
   * row, as §4.10 has it, or an ordinal that the array mints.
   */
  identity?: "key" | "minted";
  /** The key of the row at a position of an array, where one is known. */
  keyAt?: (
    doc: string,
    path: readonly string[],
    index: number,
  ) => string | undefined;
};

/** What one transaction wrote. */
export type Sealed = {
  /** Each document written, with its bytes when the transaction ends. */
  written: { id: string; bytes: number }[];
  /** The sum of those bytes. */
  bytes: number;
  created: number;
  deleted: number;
};

const bytesOf = (value: unknown): number =>
  (JSON.stringify(value) ?? "").length;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  !(value instanceof ArrayLink);

/** The part document of one row. */
type Part = { kind: "part"; id: string; bytes: number; key?: string };

/** One row of an array, in the chunk that holds it. */
type Slot = {
  value: unknown;
  /** The bytes the chunk holds for the row: the row, or a link. */
  bytes: number;
  part?: Part;
  leaf?: Leaf;
};

/** A chunk: a contiguous run of the rows of an array. */
class Leaf {
  readonly kind = "leaf";
  parent?: Inner;
  id?: string;
  gone = false;
  slots: Slot[] = [];
  sum = 0;

  constructor(readonly tree: Tree) {}

  get count(): number {
    return this.slots.length;
  }

  get bytes(): number {
    return this.sum + Math.max(this.slots.length - 1, 0) + 2;
  }
}

/** A list of links to chunks, or to lists of them. */
class Inner {
  readonly kind = "inner";
  parent?: Inner;
  id?: string;
  gone = false;
  children: Node[] = [];
  count = 0;

  constructor(readonly tree: Tree) {}

  get bytes(): number {
    let sum = 2 + Math.max(this.children.length - 1, 0);
    for (const child of this.children) sum += this.tree.entryBytes(child);
    return sum;
  }
}

type Node = Leaf | Inner;

/** One stored array. */
class Tree {
  root: Node;
  touched = new Set<Leaf>();
  dirty = new Set<Slot>();
  /** The next ordinal of a minted identifier. */
  minted = 0;

  constructor(
    readonly holder: Holder,
    readonly path: readonly string[],
    readonly counts: boolean,
  ) {
    this.root = new Leaf(this);
  }

  entryBytes(child: Node): number {
    return this.counts ? LINK_BYTES + 10 + `${child.count}`.length : LINK_BYTES;
  }
}

/** Stands, in a holder, where a stored array is. */
class ArrayLink {
  constructor(readonly tree: Tree) {}
}

/** The document that a logical document's own identifier names. */
type Holder = {
  kind: "holder";
  id: string;
  value: unknown;
  /** The bytes of the value outside its arrays. */
  outside: number;
  trees: Set<Tree>;
  next: number;
};

type Written = Holder | Node | Part;

/** The part documents of the logical documents of one store. */
export class PartedDocuments {
  readonly #min: number;
  readonly #max: number;
  readonly #counts: boolean;
  readonly #byKey: boolean;
  readonly #keyAt: PartsOptions["keyAt"];
  readonly #holders = new Map<string, Holder>();
  #size = 0;
  #written = new Set<Written>();
  #changedTrees = new Set<Tree>();
  #created = 0;
  #deleted = 0;
  #seen: Set<object> | undefined;

  /** Constructs an instance which lays documents out by `options`. */
  constructor(options: PartsOptions = {}) {
    this.#min = options.partMinBytes ?? PART_MIN_BYTES;
    this.#max = options.documentMaxBytes ?? DOCUMENT_MAX_BYTES;
    this.#counts = (options.counts ?? "stored") === "stored";
    this.#byKey = (options.identity ?? "key") === "key";
    this.#keyAt = options.keyAt;
  }

  /** How many documents are stored: holders, chunks, lists and parts. */
  get size(): number {
    return this.#size;
  }

  // ----- changes -----

  /**
   * Applies one change of a logical document: `root` is its value after
   * the change, `undefined` where it has none, `path` the path that
   * changed, and `splice` the members of the array at `path` that left
   * and entered.
   */
  changed(
    doc: string,
    path: readonly string[],
    root: unknown,
    _old: unknown,
    splice?: { start: number; removed: number; inserted: number },
  ): void {
    let holder = this.#holders.get(doc);
    if (root === undefined) {
      if (holder !== undefined) this.#dropHolder(holder);
      return;
    }
    if (holder === undefined) {
      holder = {
        kind: "holder",
        id: doc,
        value: undefined,
        outside: 0,
        trees: new Set(),
        next: 0,
      };
      this.#holders.set(doc, holder);
      this.#size += 1;
      this.#created += 1;
      this.#setAt(holder, [], root);
      return;
    }
    // The array that the path leads into, where it does.
    let shadow = holder.value;
    let logical: unknown = root;
    for (let depth = 0; depth < path.length; depth++) {
      if (shadow instanceof ArrayLink) {
        this.#rowChanged(shadow.tree, logical, path[depth]);
        return;
      }
      if (!isRecord(shadow) || !isRecord(logical)) {
        this.#setAt(holder, [], root);
        return;
      }
      shadow = shadow[path[depth]];
      logical = logical[path[depth]];
    }
    if (shadow instanceof ArrayLink && Array.isArray(logical)) {
      if (splice === undefined) this.#replace(shadow.tree, logical);
      else {
        this.#remove(shadow.tree, splice.start, splice.removed);
        this.#insert(
          shadow.tree,
          splice.start,
          logical.slice(splice.start, splice.start + splice.inserted),
        );
      }
      return;
    }
    this.#setAt(holder, path, root);
  }

  /** Stores what a path outside every array holds now. */
  #setAt(holder: Holder, path: readonly string[], root: unknown): void {
    let logical = root;
    let parent: Record<string, unknown> | undefined;
    let shadow = holder.value;
    for (const segment of path) {
      if (!isRecord(shadow) || !isRecord(logical)) {
        this.#setAt(holder, [], root);
        return;
      }
      parent = shadow;
      shadow = shadow[segment];
      logical = logical[segment];
    }
    holder.outside -= this.#outside(shadow, true);
    const made = this.#shadowOf(holder, path, logical);
    holder.outside += this.#outside(made, false);
    if (parent === undefined) holder.value = made;
    else if (made === undefined) delete parent[path[path.length - 1]];
    else parent[path[path.length - 1]] = made;
    this.#written.add(holder);
  }

  /** The form of a value in a holder: each array as a stored array. */
  #shadowOf(holder: Holder, path: readonly string[], value: unknown): unknown {
    if (Array.isArray(value)) {
      const tree = new Tree(holder, [...path], this.#counts);
      holder.trees.add(tree);
      this.#insert(tree, 0, value);
      return new ArrayLink(tree);
    }
    if (typeof value !== "object" || value === null) return value;
    const made: Record<string, unknown> = {};
    for (const [name, member] of Object.entries(value)) {
      made[name] = this.#shadowOf(holder, [...path, name], member);
    }
    return made;
  }

  /** The bytes of a holder's value outside its arrays. */
  #outside(shadow: unknown, drop: boolean): number {
    if (shadow instanceof ArrayLink) {
      if (drop) this.#dropTree(shadow.tree);
      return 0;
    }
    if (!isRecord(shadow)) return bytesOf(shadow);
    let sum = 2;
    let members = 0;
    for (const [name, member] of Object.entries(shadow)) {
      sum += JSON.stringify(name).length + 1 + this.#outside(member, drop);
      members += 1;
    }
    return sum + Math.max(members - 1, 0);
  }

  #dropHolder(holder: Holder): void {
    for (const tree of [...holder.trees]) this.#dropTree(tree);
    this.#holders.delete(holder.id);
    this.#size -= 1;
    this.#deleted += 1;
  }

  #dropTree(tree: Tree): void {
    const drop = (node: Node) => {
      if (node.id !== undefined) this.#gone(node);
      if (node.kind === "inner") node.children.forEach(drop);
      else {
        for (const slot of node.slots) {
          if (slot.part !== undefined) this.#deletePart(slot);
        }
      }
    };
    drop(tree.root);
    tree.holder.trees.delete(tree);
    this.#changedTrees.delete(tree);
  }

  #gone(node: Node): void {
    node.gone = true;
    if (node.id !== undefined) {
      node.id = undefined;
      this.#size -= 1;
      this.#deleted += 1;
    }
  }

  #deletePart(slot: Slot): void {
    slot.part = undefined;
    this.#size -= 1;
    this.#deleted += 1;
  }

  /** The document that holds a chunk or a list. */
  #docOf(node: Node): Written {
    return node.id === undefined ? node.tree.holder : node;
  }

  /** A row, or something below it, holds another value. */
  #rowChanged(tree: Tree, array: unknown, segment: string): void {
    const index = Number(segment);
    if (
      !Array.isArray(array) || !Number.isInteger(index) || index < 0 ||
      index >= tree.root.count || array.length !== tree.root.count
    ) {
      if (Array.isArray(array)) this.#replace(tree, array);
      else this.#setAt(tree.holder, [], this.#rootOf(tree.holder));
      return;
    }
    const { leaf, offset } = this.#locate(tree, index);
    const slot = leaf.slots[offset];
    slot.value = array[index];
    tree.dirty.add(slot);
    this.#changedTrees.add(tree);
  }

  /** A holder's value with no array expanded is not kept: the caller's. */
  #rootOf(holder: Holder): unknown {
    return this.#expand(holder.value, false);
  }

  /** Brings a stored array to the members of `array` by one splice. */
  #replace(tree: Tree, array: readonly unknown[]): void {
    const slots: Slot[] = [];
    const walk = (node: Node) => {
      if (node.kind === "inner") node.children.forEach(walk);
      else for (const slot of node.slots) slots.push(slot);
    };
    walk(tree.root);
    const same = (slot: Slot, value: unknown) =>
      slot.value === value ||
      JSON.stringify(slot.value) === JSON.stringify(value);
    let head = 0;
    while (
      head < slots.length && head < array.length &&
      same(slots[head], array[head])
    ) head += 1;
    let tail = 0;
    while (
      tail < slots.length - head && tail < array.length - head &&
      same(slots[slots.length - 1 - tail], array[array.length - 1 - tail])
    ) tail += 1;
    // The kept rows are the members of the new array from here on.
    for (let index = 0; index < head; index++) {
      slots[index].value = array[index];
    }
    for (let back = 1; back <= tail; back++) {
      slots[slots.length - back].value = array[array.length - back];
    }
    this.#remove(tree, head, slots.length - head - tail);
    this.#insert(tree, head, array.slice(head, array.length - tail));
  }

  #locate(tree: Tree, index: number): { leaf: Leaf; offset: number } {
    let node = tree.root;
    let offset = index;
    while (node.kind === "inner") {
      let found: Node | undefined;
      for (const child of node.children) {
        if (offset < child.count) {
          found = child;
          break;
        }
        offset -= child.count;
      }
      if (found === undefined) {
        // The position after the last row is in the last chunk.
        found = node.children[node.children.length - 1];
        offset = found.count;
      }
      node = found;
    }
    return { leaf: node, offset };
  }

  #counted(leaf: Leaf, by: number): void {
    for (let node = leaf.parent; node !== undefined; node = node.parent) {
      node.count += by;
      if (this.#counts) this.#written.add(this.#docOf(node));
    }
  }

  #insert(tree: Tree, start: number, values: readonly unknown[]): void {
    if (values.length === 0) return;
    const { leaf, offset } = this.#locate(tree, start);
    const slots = values.map((value): Slot => ({
      value,
      bytes: bytesOf(value),
      leaf,
    }));
    for (const slot of slots) {
      leaf.sum += slot.bytes;
      tree.dirty.add(slot);
    }
    leaf.slots = leaf.slots.slice(0, offset).concat(
      slots,
      leaf.slots.slice(offset),
    );
    this.#counted(leaf, slots.length);
    tree.touched.add(leaf);
    this.#written.add(this.#docOf(leaf));
    this.#changedTrees.add(tree);
  }

  #remove(tree: Tree, start: number, count: number): void {
    let left = count;
    while (left > 0) {
      const { leaf, offset } = this.#locate(tree, start);
      const taken = leaf.slots.splice(offset, left);
      if (taken.length === 0) return;
      for (const slot of taken) {
        leaf.sum -= slot.bytes;
        slot.leaf = undefined;
        tree.dirty.delete(slot);
        if (slot.part !== undefined) this.#deletePart(slot);
      }
      left -= taken.length;
      this.#counted(leaf, -taken.length);
      tree.touched.add(leaf);
      this.#written.add(this.#docOf(leaf));
    }
    this.#changedTrees.add(tree);
  }

  // ----- the layout, when a transaction ends -----

  #indexOf(slot: Slot): number {
    const leaf = slot.leaf!;
    let index = leaf.slots.indexOf(slot);
    let node: Node = leaf;
    while (node.parent !== undefined) {
      for (const sibling of node.parent.children) {
        if (sibling === node) break;
        index += sibling.count;
      }
      node = node.parent;
    }
    return index;
  }

  #chunkId(tree: Tree): string {
    tree.holder.next += 1;
    this.#size += 1;
    this.#created += 1;
    return `${tree.holder.id}#chunk${tree.holder.next}`;
  }

  /** Decides, for a row that changed, whether it is a part. */
  #settle(tree: Tree, slot: Slot): void {
    const leaf = slot.leaf;
    if (leaf === undefined) return;
    const bytes = bytesOf(slot.value);
    const was = slot.part;
    const part = was === undefined
      ? bytes >= this.#min
      : bytes >= this.#min / 2;
    if (!part) {
      if (was !== undefined) this.#deletePart(slot);
      leaf.sum += bytes - slot.bytes;
      slot.bytes = bytes;
      this.#written.add(this.#docOf(leaf));
      tree.touched.add(leaf);
      return;
    }
    const key = this.#byKey
      ? this.#keyAt?.(tree.holder.id, tree.path, this.#indexOf(slot))
      : undefined;
    if (was !== undefined && was.key === key) {
      was.bytes = bytes;
      this.#written.add(was);
      return;
    }
    if (was !== undefined) this.#deletePart(slot);
    tree.minted += 1;
    slot.part = {
      kind: "part",
      id: `${tree.holder.id}#part:${tree.path.join("/")}:${key ?? tree.minted}`,
      bytes,
      ...(key === undefined ? {} : { key }),
    };
    this.#size += 1;
    this.#created += 1;
    leaf.sum += LINK_BYTES - slot.bytes;
    slot.bytes = LINK_BYTES;
    this.#written.add(slot.part);
    this.#written.add(this.#docOf(leaf));
    tree.touched.add(leaf);
  }

  /** Cuts the members of a node over the maximum into nodes under it. */
  #pieces(node: Node): Node[] {
    const count = Math.ceil(node.bytes / this.#max);
    const pieces: Node[] = [];
    // The members are cut where the bytes before them pass each of the
    // `count - 1` equal shares of the whole.
    let before = 0;
    const cut = (bytes: number) => {
      const due = pieces.length < count - 1 &&
        before + bytes / 2 >= (node.bytes * (pieces.length + 1)) / count;
      before += bytes;
      return due;
    };
    if (node.kind === "leaf") {
      let piece = new Leaf(node.tree);
      for (const slot of node.slots) {
        if (cut(slot.bytes + 1) && piece.slots.length > 0) {
          pieces.push(piece);
          piece = new Leaf(node.tree);
        }
        piece.slots.push(slot);
        piece.sum += slot.bytes;
        slot.leaf = piece;
      }
      pieces.push(piece);
    } else {
      let piece = new Inner(node.tree);
      for (const child of node.children) {
        if (
          cut(node.tree.entryBytes(child) + 1) && piece.children.length > 0
        ) {
          pieces.push(piece);
          piece = new Inner(node.tree);
        }
        piece.children.push(child);
        piece.count += child.count;
        child.parent = piece;
      }
      pieces.push(piece);
    }
    return pieces;
  }

  /** Splits, merges or removes a chunk or a list that is no root. */
  #balance(node: Node, lists: Set<Inner>): void {
    const parent = node.parent;
    if (parent === undefined || node.gone) return;
    const at = parent.children.indexOf(node);
    const empty = node.kind === "leaf"
      ? node.slots.length === 0
      : node.children.length === 0;
    if (empty) {
      parent.children.splice(at, 1);
      this.#gone(node);
    } else if (node.bytes > this.#max) {
      const pieces = this.#pieces(node);
      for (const piece of pieces) {
        piece.parent = parent;
        piece.id = this.#chunkId(node.tree);
        this.#written.add(piece);
      }
      parent.children = parent.children.slice(0, at).concat(
        pieces,
        parent.children.slice(at + 1),
      );
      this.#gone(node);
    } else {
      const merged = [at - 1, at + 1].some((beside) => {
        const other = parent.children[beside];
        if (
          other === undefined || other.bytes + node.bytes >= this.#max / 2
        ) return false;
        const [first, second] = beside < at ? [other, node] : [node, other];
        if (first.kind === "leaf" && second.kind === "leaf") {
          for (const slot of second.slots) slot.leaf = first;
          first.slots = first.slots.concat(second.slots);
          first.sum += second.sum;
        } else if (first.kind === "inner" && second.kind === "inner") {
          for (const child of second.children) child.parent = first;
          first.children = first.children.concat(second.children);
          first.count += second.count;
        }
        parent.children.splice(parent.children.indexOf(second), 1);
        this.#gone(second);
        this.#written.add(first);
        return true;
      });
      if (!merged) return;
    }
    this.#written.add(this.#docOf(parent));
    lists.add(parent);
  }

  /** The root of an array: in its holder up to the maximum. */
  #rootLayout(tree: Tree): void {
    const own = tree.root.id;
    for (;;) {
      const root = tree.root;
      if (root.kind === "inner" && root.children.length === 0) {
        tree.root = new Leaf(tree);
      } else if (
        root.kind === "inner" && root.children.length === 1 &&
        (root.children[0].kind === "inner" ||
          root.children[0].bytes <= this.#max / 2)
      ) {
        const [child] = root.children;
        this.#gone(child);
        child.gone = false;
        child.parent = undefined;
        tree.root = child;
      } else if (root.bytes > this.#max) {
        const above = new Inner(tree);
        for (const piece of this.#pieces(root)) {
          piece.parent = above;
          piece.id = this.#chunkId(tree);
          above.children.push(piece);
          above.count += piece.count;
          this.#written.add(piece);
        }
        tree.root = above;
      } else break;
      if (tree.root !== root) {
        root.id = undefined;
        tree.root.id = own;
        this.#written.add(this.#docOf(tree.root));
      }
    }
  }

  #holderBytes(holder: Holder): number {
    let sum = holder.outside;
    for (const tree of holder.trees) {
      sum += tree.root.id === undefined ? tree.root.bytes : LINK_BYTES;
    }
    return sum;
  }

  /** An array of a holder over the maximum is a document of its own. */
  #holderLayout(holder: Holder): void {
    let bytes = this.#holderBytes(holder);
    if (bytes > this.#max) {
      const inPlace = [...holder.trees].filter(({ root }) =>
        root.id === undefined && root.bytes >= this.#min
      ).sort((a, b) => b.root.bytes - a.root.bytes);
      for (const tree of inPlace) {
        if (bytes <= this.#max) break;
        bytes += LINK_BYTES - tree.root.bytes;
        tree.root.id = this.#chunkId(tree);
        this.#written.add(tree.root);
      }
      return;
    }
    for (const tree of holder.trees) {
      const { root } = tree;
      if (
        root.id === undefined ||
        bytes + root.bytes - LINK_BYTES > this.#max / 2
      ) continue;
      bytes += root.bytes - LINK_BYTES;
      root.id = undefined;
      this.#size -= 1;
      this.#deleted += 1;
    }
  }

  /**
   * Ends a transaction: lays out what its changes touched, and returns
   * the documents that it wrote.
   */
  seal(): Sealed {
    for (const tree of this.#changedTrees) {
      for (const slot of tree.dirty) this.#settle(tree, slot);
      tree.dirty.clear();
      let lists = new Set<Inner>();
      for (const leaf of tree.touched) this.#balance(leaf, lists);
      tree.touched.clear();
      while (lists.size > 0) {
        const above = new Set<Inner>();
        for (const list of lists) this.#balance(list, above);
        lists = above;
      }
      this.#rootLayout(tree);
    }
    this.#changedTrees.clear();
    const holders = new Set<Holder>();
    for (const document of this.#written) {
      if (document.kind === "holder") holders.add(document);
      else if (document.kind !== "part" && !document.gone) {
        holders.add(document.tree.holder);
      }
    }
    for (const holder of holders) {
      if (this.#holders.get(holder.id) === holder) this.#holderLayout(holder);
    }
    const written: Sealed["written"] = [];
    const seen = new Set<Written>();
    let sum = 0;
    for (const noted of this.#written) {
      if (noted.kind !== "part" && noted.kind !== "holder" && noted.gone) {
        continue;
      }
      const document = noted.kind === "leaf" || noted.kind === "inner"
        ? this.#docOf(noted)
        : noted;
      if (seen.has(document)) continue;
      seen.add(document);
      if (
        document.kind === "holder" &&
        this.#holders.get(document.id) !== document
      ) continue;
      const bytes = document.kind === "holder"
        ? this.#holderBytes(document)
        : document.bytes;
      written.push({ id: document.id!, bytes });
      sum += bytes;
    }
    const sealed = {
      written,
      bytes: sum,
      created: this.#created,
      deleted: this.#deleted,
    };
    this.#written = new Set();
    this.#created = 0;
    this.#deleted = 0;
    return sealed;
  }

  // ----- reads -----

  /** Runs `run`, and counts the documents that its reads passed through. */
  counting<T>(run: () => T): { value: T; documents: number } {
    const seen = new Set<object>();
    this.#seen = seen;
    try {
      return { value: run(), documents: seen.size };
    } finally {
      this.#seen = undefined;
    }
  }

  #see(document: object): void {
    this.#seen?.add(document);
  }

  #seeLeaves(node: Node): void {
    if (node.id !== undefined) this.#see(node);
    if (node.kind === "inner") {
      for (const child of node.children) this.#seeLeaves(child);
    }
  }

  /** The row at a position, through the lists, the chunk and the part. */
  #row(tree: Tree, index: number): unknown {
    let node = tree.root;
    let offset = index;
    for (;;) {
      if (node.id !== undefined) this.#see(node);
      if (node.kind === "leaf") break;
      let found: Node | undefined;
      for (const child of node.children) {
        if (offset < child.count) {
          found = child;
          break;
        }
        // With no count in the list, the chunks before are read.
        if (!this.#counts) this.#seeLeaves(child);
        offset -= child.count;
      }
      if (found === undefined) return undefined;
      node = found;
    }
    const slot = node.slots[offset];
    if (slot?.part !== undefined) this.#see(slot.part);
    return slot?.value;
  }

  #expand(shadow: unknown, see: boolean): unknown {
    if (shadow instanceof ArrayLink) {
      const rows: unknown[] = [];
      const walk = (node: Node) => {
        if (see && node.id !== undefined) this.#see(node);
        if (node.kind === "inner") node.children.forEach(walk);
        else {
          for (const slot of node.slots) {
            if (see && slot.part !== undefined) this.#see(slot.part);
            rows.push(slot.value);
          }
        }
      };
      walk(shadow.tree.root);
      return rows;
    }
    if (!isRecord(shadow)) return shadow;
    const made: Record<string, unknown> = {};
    for (const [name, member] of Object.entries(shadow)) {
      made[name] = this.#expand(member, see);
    }
    return made;
  }

  /** The value at a path of a logical document, read from its documents. */
  read(doc: string, path: readonly string[]): unknown {
    const holder = this.#holders.get(doc);
    if (holder === undefined) return undefined;
    this.#see(holder);
    let value = holder.value;
    for (let depth = 0; depth < path.length; depth++) {
      if (value instanceof ArrayLink) {
        value = this.#row(value.tree, Number(path[depth]));
        for (const segment of path.slice(depth + 1)) {
          value = (value as Record<string, unknown> | undefined)?.[segment];
        }
        return value;
      }
      value = (value as Record<string, unknown> | undefined)?.[path[depth]];
    }
    return this.#expand(value, true);
  }

  /** `count` rows of the array at a path, from `start` on. */
  rows(
    doc: string,
    path: readonly string[],
    start: number,
    count: number,
  ): unknown[] {
    const rows: unknown[] = [];
    for (let index = start; index < start + count; index++) {
      rows.push(this.read(doc, [...path, `${index}`]));
    }
    return rows;
  }

  /** The whole value of a logical document, read from its documents. */
  materialize(doc: string): unknown {
    return this.read(doc, []);
  }

  /** The documents of the array at a path: its chunks, lists and parts. */
  describe(
    doc: string,
    path: readonly string[],
  ): { chunks: number; depth: number; parts: number; chunkBytes: number[] } {
    let value = this.#holders.get(doc)?.value;
    for (const segment of path) {
      value = (value as Record<string, unknown> | undefined)?.[segment];
    }
    const shape = { chunks: 0, depth: 0, parts: 0, chunkBytes: [] as number[] };
    if (!(value instanceof ArrayLink)) return shape;
    const walk = (node: Node, depth: number) => {
      shape.depth = Math.max(shape.depth, depth);
      if (node.id !== undefined) {
        shape.chunks += 1;
        shape.chunkBytes.push(node.bytes);
      }
      if (node.kind === "inner") {
        node.children.forEach((child) => walk(child, depth + 1));
      } else {
        for (const slot of node.slots) {
          if (slot.part !== undefined) shape.parts += 1;
        }
      }
    };
    walk(value.tree.root, 1);
    return shape;
  }
}
