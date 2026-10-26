import { estimateFabricValueSize } from "@commonfabric/data-model";
import { hashSchema } from "@commonfabric/data-model-schema";
import { LRUCache } from "@commonfabric/utils/cache";

import { immutableSnapshot, isImmutableCellId } from "./immutable-cell.ts";
import type { URI } from "./sigil-types.ts";
import { addressKey, type NormalizedFullLink } from "./link-types.ts";
import { schemaRegistryEpoch } from "./schema-registry.ts";

/**
 * A member of a {@link NodeBindingSubject} that names a pattern or a node: an
 * object, keyed by identity; a string, the content identity of a pattern,
 * under which every object of that identity is one pattern; or a number, the
 * position of a node among the nodes of a pattern so named, at which every
 * object of that identity holds the same node.
 */
export type NodeBindingSubjectMember = object | string | number;

/** What a node binding is computed from, which is what the memo keys on. */
export type NodeBindingSubject = {
  /** The node bound. */
  node: NodeBindingSubjectMember;

  /** The pattern holding the node. */
  pattern: NodeBindingSubjectMember;

  /**
   * Any further pattern the binding is computed from: the pattern a pattern
   * node's module resolved to, which a registry may replace under an
   * unchanged node.
   */
  implementation?: NodeBindingSubjectMember;

  /** The link of the result cell the node is bound on. */
  resultLink: NormalizedFullLink;

  /** The argument link the node is bound against, when there is one. */
  argumentLink: NormalizedFullLink | undefined;

  /**
   * Whatever else decides the binding: the kind of module the node resolved
   * to, and any setting the binding reads.
   */
  variant: string;
};

/**
 * Memo of what binding a pattern's node on a result cell produces, for the
 * part of a binding that reads nothing through a transaction: the node's
 * inputs and outputs bound to the piece's argument and result documents, and
 * what derives from those alone. Such a binding is a function of its
 * {@link NodeBindingSubject}, so the one computed by whichever plan of the
 * node comes first — a resume pre-sync's, a name-sync's, the node's
 * instantiation's — is the one every later plan needs, and
 * {@link bindingFor} holds it for them all.
 *
 * A node and a pattern are keyed as their {@link NodeBindingSubjectMember}
 * says, a link by the members a binding reads from it: its address and its
 * schema, the schema by content. A bound link carries its schema as a
 * reference into the schema registry, which resolves only in the registry
 * epoch that minted it, so every entry is dropped when the epoch changes.
 *
 * The memo holds at most `capacity` entries, and at most `maxWeight` of key
 * length plus whatever `weigh` reports for a binding, dropping the least
 * recently used. A dropped entry costs a second computation and nothing
 * else. Every holder of a binding treats it as immutable, since the memo
 * hands the same one to each.
 */
export class NodeBindingMemo<Binding> {
  #entries: LRUCache<string, Binding>;
  #epoch = schemaRegistryEpoch();
  #subjectIds = new WeakMap<object, number>();
  #nextSubjectId = 0;

  /** Constructs an instance bounded by `options`. */
  constructor(
    options: {
      capacity: number;
      maxWeight: number;
      weigh?: (binding: Binding) => number;
    },
  ) {
    const weigh = options.weigh;
    this.#entries = new LRUCache<string, Binding>({
      capacity: options.capacity,
      maxWeight: options.maxWeight,
      weigh: (key, binding) => key.length + (weigh?.(binding) ?? 0),
    });
  }

  /** Number of bindings held. */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Returns the binding for `subject`: the one held, or the result of `bind`,
   * which is then held. A `bind` that throws leaves nothing held.
   */
  bindingFor(subject: NodeBindingSubject, bind: () => Binding): Binding {
    const key = this.#currentKey(subject);
    const held = this.#entries.get(key);
    if (held !== undefined) return held;
    const binding = bind();
    this.#entries.put(key, binding);
    return binding;
  }

  /** Drops every binding held. */
  clear(): void {
    this.#entries.clear();
  }

  /**
   * Helper for {@link bindingFor}, which returns the key `subject`'s binding
   * is held under after dropping every entry of an earlier registry epoch.
   */
  #currentKey(subject: NodeBindingSubject): string {
    const epoch = schemaRegistryEpoch();
    if (epoch !== this.#epoch) {
      this.#entries.clear();
      this.#epoch = epoch;
    }
    return this.#key(subject);
  }

  /**
   * The key `subject`'s binding is held under: its members as one JSON
   * array, so that no two subjects share a key.
   */
  #key(subject: NodeBindingSubject): string {
    return JSON.stringify([
      this.#memberKey(subject.node),
      this.#memberKey(subject.pattern),
      subject.implementation === undefined
        ? null
        : this.#memberKey(subject.implementation),
      subject.variant,
      linkMembers(subject.resultLink),
      subject.argumentLink === undefined
        ? null
        : linkMembers(subject.argumentLink),
    ]);
  }

  /**
   * What stands for `member` in a key: an object by the number minted for
   * it on first use, a content identity and a position as they are, each
   * under a mark of its kind so that no two kinds share a key.
   */
  #memberKey(member: NodeBindingSubjectMember): string {
    if (typeof member === "string") return `identity:${member}`;
    if (typeof member === "number") return `position:${member}`;
    let id = this.#subjectIds.get(member);
    if (id === undefined) {
      id = this.#nextSubjectId++;
      this.#subjectIds.set(member, id);
    }
    return `object:${id}`;
  }
}

/**
 * The members of `link` a binding reads: its address, and its schema as a
 * content hash.
 */
function linkMembers(link: NormalizedFullLink): [string, string | null] {
  return [
    addressKey(link),
    link.schema === undefined ? null : hashSchema(link.schema),
  ];
}

/** The weight of an inputs document, including a native snapshot's payload. */
export function nodeBindingInputsWeight(id: URI): number {
  return isImmutableCellId(id)
    ? id.length + estimateFabricValueSize(immutableSnapshot(id).value)
    : id.length;
}
