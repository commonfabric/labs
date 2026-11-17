import { taggedHashStringOf } from "@commonfabric/data-model";
import { isPlainObject } from "@commonfabric/js-values/types";

import { isPrimitiveCellLink } from "./link-types.ts";
import { createSigilLinkFromParsedLink } from "./link-utils.ts";
import type { MemorySpace } from "./runtime.ts";

/**
 * Shortest string stored by reference. A link to a code document takes about
 * as many characters as a string a little under this length, so a shorter one
 * stays inline.
 */
const SHORTEST_LINKED = 1024;

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
 * one: a string reaches the set by a reader returning it, and no other way. A
 * string equal to a recorded one is linked wherever it occurs, which exposes
 * nothing, since the space holds that text unlabeled already.
 *
 * Recorded strings are held for the runtime's lifetime, as the modules that
 * read them are.
 */
export class DataFileStrings {
  /** Each recorded string, with the id of its code document once computed. */
  #codeDocumentIds = new Map<string, string | undefined>();

  /**
   * Records `text` as returned by a data-file reader. A string shorter than
   * the shortest one stored by reference is not recorded.
   */
  record(text: string): void {
    if (text.length < SHORTEST_LINKED) return;
    if (!this.#codeDocumentIds.has(text)) {
      this.#codeDocumentIds.set(text, undefined);
    }
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
      return createSigilLinkFromParsedLink({
        id: this.#codeDocumentId(value),
        path: [],
        space,
      });
    }
    // A link under the legacy representation is a plain record, so it is
    // recognized before the container question would descend into it.
    if (isPrimitiveCellLink(value)) return value;
    if (Array.isArray(value)) {
      let copy: unknown[] | undefined;
      for (let i = 0; i < value.length; i++) {
        const element = this.#link(value[i], space, documents);
        if (element !== value[i]) {
          copy ??= [...value];
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
    if (id === undefined) {
      id = `cid:${taggedHashStringOf(text)}`;
      this.#codeDocumentIds.set(text, id);
    }
    return id as `cid:${string}`;
  }
}
