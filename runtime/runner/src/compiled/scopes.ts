/**
 * What the adapter of a compiled piece keeps of the scope instances of the
 * documents of the executor (`exec/scope-instances.ts`), behind the
 * experimental option `compiledPatterns`.
 *
 * The executor names a document of the scope `user` or `session` by one
 * text for every principal. The adapter addresses it by its entity and
 * that scope, and the transaction of the run resolves the instance from
 * the identity it carries, as it does for a cell of any pattern: nothing
 * here says which principal a run is for. What the adapter keeps of a
 * document from one transaction to the next (whether the storage holds
 * it, the labels read of it) it keeps for each instance, under the name
 * of the instance.
 */
import {
  type CellScope,
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";

import {
  type Scope,
  scopeOfDocument,
} from "../../../../base/pattern-compiler/exec/scope-instances.ts";
import type { MemorySpace } from "../cell.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { URI } from "../sigil-types.ts";
import { placeOfDocument } from "./names.ts";

/** The scope a name of a document of the executor is of. */
export const cellScopeOf = (doc: string): CellScope =>
  scopeOfDocument(doc).scope ?? "space";

/**
 * The scope key of `identity` in `scope`, as the storage forms it. An
 * identity with no session has no instance of the scope `session`: the
 * key then names none, and a read or a write of such an instance is
 * refused by the transaction.
 */
export const scopeKeyOf = (
  scope: Scope,
  identity: ScopeKeyIdentity,
): string => {
  try {
    return resolveScopeKey(scope, identity);
  } catch {
    return `${scope}:`;
  }
};

/**
 * The name of the instance that `doc` stands for under the scope keys
 * `keyOf` gives: `doc` itself where it names no scope, or names the
 * instance of one key.
 */
export const instanceNameOf = (
  doc: string,
  keyOf: (scope: Scope) => string,
): string => {
  const { base, scope, key } = scopeOfDocument(doc);
  return scope === undefined || key !== undefined
    ? doc
    : `${base}~${keyOf(scope)}`;
};

/**
 * The runtime's address of the document the executor names `doc` in
 * `space`: its entity, and the scope its name is of, which the runtime
 * resolves to the instance of the identity that reads or writes.
 */
export const linkOfDocument = (
  space: MemorySpace,
  doc: string,
): NormalizedFullLink => {
  const { base, scope } = scopeOfDocument(doc);
  return {
    space,
    id: (base.startsWith("of:") ? base : `of:${base}`) as URI,
    path: [],
    scope: scope ?? "space",
  };
};

/** Whether the name `doc` of a document of the executor names a scope. */
export const namesScope = (doc: string): boolean =>
  scopeOfDocument(doc).scope !== undefined;

/**
 * Whether the name `doc` of a document of the executor names no other
 * space than that of its piece (`names.ts`).
 */
export const inSpaceOfPiece = (doc: string): boolean =>
  placeOfDocument(scopeOfDocument(doc).base).space === undefined;

/** A set of documents, each instance of a scoped document by itself. */
export class DocumentInstances extends Set<string> {
  readonly #instanceOf: (doc: string) => string;

  /** Constructs an empty set whose members are named by `instanceOf`. */
  constructor(instanceOf: (doc: string) => string) {
    super();
    this.#instanceOf = instanceOf;
  }

  /** @inheritDoc */
  override has(doc: string): boolean {
    return super.has(this.#instanceOf(doc));
  }

  /** @inheritDoc */
  override add(doc: string): this {
    return super.add(this.#instanceOf(doc));
  }

  /** @inheritDoc */
  override delete(doc: string): boolean {
    return super.delete(this.#instanceOf(doc));
  }
}

/** What is kept of documents, of each instance of a scoped one by itself. */
export class ByDocumentInstance<Value> extends Map<string, Value> {
  readonly #instanceOf: (doc: string) => string;

  /** Constructs an empty map whose keys are named by `instanceOf`. */
  constructor(instanceOf: (doc: string) => string) {
    super();
    this.#instanceOf = instanceOf;
  }

  /** @inheritDoc */
  override has(doc: string): boolean {
    return super.has(this.#instanceOf(doc));
  }

  /** @inheritDoc */
  override get(doc: string): Value | undefined {
    return super.get(this.#instanceOf(doc));
  }

  /** @inheritDoc */
  override set(doc: string, value: Value): this {
    return super.set(this.#instanceOf(doc), value);
  }

  /** @inheritDoc */
  override delete(doc: string): boolean {
    return super.delete(this.#instanceOf(doc));
  }
}
