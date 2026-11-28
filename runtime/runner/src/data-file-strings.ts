/**
 * The record a runtime keeps of the strings `dataFile` readers return, and
 * the walk that writes each recorded string into a result projection as a
 * link to the code document holding it rather than inline, so that a space
 * stores a data file a pattern passes to its view once rather than once per
 * piece (`docs/specs/iframe-static-assets.md`, part 1). Only a string of at
 * least `SHORTEST_LINKED` characters that the bounded record still holds is
 * linked; a shorter one, or one the record has evicted, is written inline in
 * every result that carries it.
 */

import { LRUCache } from "@commonfabric/collections/cache";
import { taggedHashStringOf } from "@commonfabric/data-model";
import { isPlainObject } from "@commonfabric/js-values/types";

import { isPrimitiveCellLink } from "./link-types.ts";
import { createSigilLinkFromParsedLink } from "./link-utils.ts";
import type { MemorySpace } from "./runtime.ts";

/**
 * Shortest string stored by reference. A link takes about 170 characters, and
 * the code document it names is one more document for every read of the
 * result to load, so a string well under a kilobyte saves too little to pay
 * for that.
 */
const SHORTEST_LINKED = 1024;

/** Most strings `DataFileStrings` holds at once. */
const MOST_STRINGS = 10_000;

/** Most characters, all its strings together, `DataFileStrings` holds. */
const MOST_CHARACTERS = 32 * 1024 * 1024;

/** What `DataFileStrings.linkInto()` returns. */
export interface LinkedValue {
  /** The value, with each recorded string replaced by a link. */
  value: unknown;

  /** Each string a link in `value` names, once, for the caller to stage. */
  documents: readonly string[];
}

/**
 * The strings `dataFile` readers have returned in one runtime, which setup
 * writes into a result document as links to code documents holding them
 * rather than inline. A pattern passes a data file to its view as a prop, so
 * written inline, every piece would store its own copy of the file
 * (`docs/specs/iframe-static-assets.md`, part 1).
 *
 * A code document carries no CFC envelope, so only program content goes into
 * one: a string reaches the set by a reader returning it, and no other way.
 * Setup links only the string leaves of a result projection: the pattern's own
 * constants, and a name a later setup carries over from the stored result. A
 * value computed at run time reaches a result document as a link to its cell.
 * A leaf equal to a recorded string holds program content however it got
 * there, so linking it exposes nothing the program does not.
 *
 * The set is bounded, by count and by total length, and drops the string used
 * least recently once it is full. A string it dropped is written inline by the
 * next setup that writes it, which costs that piece the copy this saves and
 * nothing else; a reader returning it again records it again.
 */
export class DataFileStrings {
  /** Each recorded string, with the id of its code document once computed. */
  #codeDocumentIds = new LRUCache<string, string | null>({
    capacity: MOST_STRINGS,
    maxWeight: MOST_CHARACTERS,
    weigh: (text) => text.length,
  });

  /**
   * Records `text` as returned by a data-file reader. A string shorter than
   * the shortest one stored by reference is not recorded, and nor is one
   * longer than all the set holds together.
   */
  record(text: string): void {
    if (text.length < SHORTEST_LINKED || text.length > MOST_CHARACTERS) return;
    if (this.#codeDocumentIds.has(text)) {
      this.#codeDocumentIds.get(text);
    } else {
      this.#codeDocumentIds.put(text, null);
    }
  }

  /** Forgets every recorded string. */
  clear(): void {
    this.#codeDocumentIds.clear();
  }

  /**
   * Returns `value` with each recorded string in it replaced by a link to the
   * code document in `space` that holds it, along with the strings those
   * links name. The caller stages each one's code document in the
   * transaction that writes the value.
   *
   * The walk descends arrays and plain records and nothing else: a link, a
   * cell, and a fabric special object are returned as themselves, and so is
   * any container under which nothing was replaced, so a value holding no
   * recorded string comes back by identity.
   */
  linkInto(value: unknown, space: MemorySpace): LinkedValue {
    if (this.#codeDocumentIds.size === 0) return { value, documents: [] };
    const documents = new Set<string>();
    const linked = this.#link(value, space, documents);
    return { value: linked, documents: [...documents] };
  }

  /**
   * Helper for `linkInto()`, which returns what stands in for `value`, adding
   * each string it links to `documents`.
   */
  #link(value: unknown, space: MemorySpace, documents: Set<string>): unknown {
    if (typeof value === "string") {
      if (!this.#codeDocumentIds.has(value)) return value;
      documents.add(value);
      // A link with no scope of its own takes the scope of the document
      // holding it, and a result document can be user- or session-scoped. The
      // code document is in the space.
      return createSigilLinkFromParsedLink({
        id: this.#codeDocumentId(value),
        path: [],
        space,
        scope: "space",
      });
    }
    // A link under the legacy representation is a plain record, so it is
    // recognized before the container question would descend into it.
    if (isPrimitiveCellLink(value)) return value;
    if (Array.isArray(value)) {
      let copy: unknown[] | undefined;
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) continue;
        const element = this.#link(value[i], space, documents);
        if (element !== value[i]) {
          // `slice()`, unlike a spread, keeps the array's holes.
          copy ??= value.slice();
          copy[i] = element;
        }
      }
      return copy === undefined ? value : Object.freeze(copy);
    }
    if (isPlainObject(value)) {
      let copy: Record<string, unknown> | undefined;
      for (const [key, member] of Object.entries(value)) {
        const replaced = this.#link(member, space, documents);
        if (replaced !== member) {
          copy ??= { ...value };
          copy[key] = replaced;
        }
      }
      return copy === undefined ? value : Object.freeze(copy);
    }
    return value;
  }

  /** Helper for `#link()`, which returns the id of `text`'s code document. */
  #codeDocumentId(text: string): `cid:${string}` {
    let id = this.#codeDocumentIds.get(text);
    if (id === null || id === undefined) {
      id = `cid:${taggedHashStringOf(text)}`;
      this.#codeDocumentIds.put(text, id);
    }
    return id as `cid:${string}`;
  }
}
