// The single `sqliteQuery` node factory, shared by the `db.query` method
// (cell.ts) and the public `sqliteQuery` builder export (builder/built-in.ts) so
// both construct the SAME reactive node instead of each calling
// `createNodeFactory` for the same implementation. Lives in its own module
// (depends only on builder/module.ts, which does not import cell.ts) so cell.ts
// can import it without a cycle (08-open-questions #24).

import { createNodeFactory } from "../../builder/module.ts";

/** @internal Legacy raw query-state factory for persisted compiled graphs. */
// deno-lint-ignore no-explicit-any
export const sqliteQueryStateNodeFactory = createNodeFactory<any, any>({
  type: "ref",
  implementation: "sqliteQuery",
});

/** Direct structured-result factory used by newly compiled graphs. */
// deno-lint-ignore no-explicit-any
export const sqliteQueryNodeFactory = createNodeFactory<any, any>({
  type: "ref",
  implementation: "sqliteQueryResult",
});
