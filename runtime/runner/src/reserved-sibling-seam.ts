/**
 * The reserved siblings: the document-root siblings of `value` that hold
 * runtime state rather than user data, and that no meta field covers.
 *
 * `cfc` holds the persisted CFC label map. `source` names the entity a
 * document was derived from. The CFC prepare pass excludes both from its
 * accounting — a read of one is left out of the flow join, and a write to one
 * is left out of schema write policy and flow-label attachment — so the
 * writes it accounts for are the writes on the value surface. That exclusion
 * describes the runtime's own bookkeeping, and it holds only while the
 * runtime is the one writing here, which the write chokepoint establishes: a
 * write reaching one of these from outside the privileged persistence scope
 * is recorded, and the commit boundary turns each record into a fail-closed
 * reason. A name added to this list joins both the exclusion and the guard.
 *
 * The meta fields are a separate seam with a separate guard: a write there
 * names the program a piece runs, and is refused outright rather than
 * recorded. See {@link file://./meta-seam.ts}.
 */
export const RESERVED_SIBLINGS = Object.freeze(["cfc", "source"] as const);

/** One of the {@link RESERVED_SIBLINGS}. */
export type ReservedSibling = typeof RESERVED_SIBLINGS[number];

/** Whether the given field name addresses a reserved sibling. */
export function isReservedSibling(field: string): field is ReservedSibling {
  return RESERVED_SIBLING_SET.has(field);
}

const RESERVED_SIBLING_SET: ReadonlySet<string> = new Set(RESERVED_SIBLINGS);
