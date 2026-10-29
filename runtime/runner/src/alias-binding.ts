/**
 * The `$alias` binding form, which appears inside saved pattern node graphs.
 *
 * An `$alias` record is not a link, and it will not become one. A link
 * addresses a document: it carries the identifier of a document that exists,
 * and a read or a write through it lands there. An `$alias` record carries no
 * such identifier. It names a position that acquires a document only when the
 * pattern graph is instantiated, in one of three ways:
 *
 * - By role. `cell: "argument"` and `cell: "result"` name the argument and
 *   result cells of whichever pattern instance the graph is being run as. A
 *   pattern graph is a template, compiled once and instantiated against many
 *   different pairs of documents, so at the time the record is written
 *   neither document exists.
 * - By derivation. `partialCause` names a document to mint from the
 *   instance's result cell and that cause, at the instance's own scope. That
 *   is a computation, not an address.
 * - By nesting level. `defer` counts how many instantiations away the
 *   record's pattern is. Each unwrapping decrements it, and the record names
 *   anything at all only once it reaches zero. A link has no analogue: it
 *   addresses a document now, or it is invalid.
 *
 * Expressing these as links would mean teaching the link payload a role
 * selector, a partial cause and a nesting counter, and teaching every walk
 * that consumes links — storage sync, the memory schema-table link extractor,
 * contextual flow control, the filesystem JSON mapping — to recognize a link
 * that does not yet address anything. That trades one binding form for three
 * new fields in the type all of those walks depend on, and for a link model
 * whose central invariant no longer holds. So the binding stays, and it stays
 * outside the link model: nothing here is reachable through the link parsers,
 * and an `$alias` record found in data is data.
 *
 * Pattern compilation emits these records. `builder/pattern.ts` mints them,
 * `builder/to-encodable-form.ts` re-levels them for nested patterns, and the
 * runner synthesizes one when it wraps a bare module as a pattern. Saved
 * graphs hold them durably, so the reader here outlives any change to the
 * writers.
 *
 * Two functions resolve a binding, both in `pattern-binding.ts` and both
 * given the instance's argument link and result cell:
 * `unwrapOneLevelAndBindToDoc` and `sendValueToBinding`. Anything walking a
 * binding after unwrapping sees sigil links; an `$alias` record surviving
 * that far belongs to a nested pattern and is inert at this level.
 */

import type { CellScope, JSONSchema, JSONValue } from "@commonfabric/api";
import { isObjectNotArray } from "@commonfabric/utils/types";

type AliasBindingBase = {
  path: readonly string[];
  schema?: JSONSchema;
};

// Named-cell aliases carry no scope: the referenced argument/result cell's
// own link determines the scope when the binding is unwrapped.
type AliasBindingNamedCell = AliasBindingBase & {
  cell: "result" | "argument";
  partialCause?: never;
  scope?: never;
  defer?: number;
};

/**
 * These are partial bindings that may not be applicable to the current
 * pattern. We track the defer count, and each time we unwrap bindings,
 * we decrement that. Once it's 0, we know that it's associated with the
 * current pattern, and we can generate real cells based ont the combination
 * of the pattern's result (parent) and the partialCause.
 *
 * `scope` names where the derived internal cell is minted. It is a concrete
 * `CellScope`: "inherit" is never generated (the builder's `cell.export()`
 * filters non-cell scopes), and would mean the same as omitting it.
 */
type AliasBindingPartialCause = AliasBindingBase & {
  cell?: never;
  partialCause: JSONValue;
  scope?: CellScope;
  defer?: number;
};

export type AliasBinding = {
  $alias:
    | AliasBindingNamedCell
    | AliasBindingPartialCause;
};

/**
 * Check if value is an `$alias` pattern binding.
 *
 * The recognition is positional: a record reads as a binding because of where
 * it sits, inside a pattern node graph, and a record of the same shape in
 * ordinary data is ordinary data. Nothing in the link model consults this.
 */
export function isAliasBinding(value: any): value is AliasBinding {
  return isObjectNotArray(value) && "$alias" in value &&
    isObjectNotArray(value.$alias) &&
    Array.isArray(value.$alias.path) &&
    (value.$alias.partialCause !== undefined ||
      value.$alias.cell === "result" || value.$alias.cell === "argument");
}
