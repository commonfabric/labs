// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
/**
 * Patterns that read a sub-pattern's result by a key the code fixes: a
 * well-known key (`NAME`, `UI`, `VIEWS`) or a `const` of a literal type. Each
 * such read compiles to a key read on the result rather than a computation
 * over all of it, and `main.test.tsx` checks that the key read reaches the
 * value, in a pattern body and in a collection callback alike.
 */

import {
  type Default,
  NAME,
  pattern,
  UI,
  VIEWS,
  type VNode,
} from "commonfabric";

interface RowInput {
  piece: Default<string, "a">;
}

/** The facts a row offers under `[VIEWS]`. */
export interface RowView {
  rendered: string;
}

/** What a row publishes. */
export interface RowOutput extends RowView {
  [UI]: VNode;
  [NAME]: string;
  [VIEWS]: { row: RowView };
  extra: string;
}

/** The sub-pattern whose result the others read. */
export const Row = pattern<RowInput, RowOutput>(({ piece }) => {
  const view = { rendered: piece };
  return {
    [UI]: <div>{piece}</div>,
    [NAME]: piece,
    [VIEWS]: { row: view },
    ...view,
    extra: piece,
  };
});

/** Name of the member a `const` key reads. */
const KEY = "rendered";

/** What a wrapper republishes of the row it instantiates. */
export interface WrapperOutput {
  [UI]: VNode;
  [NAME]: string;
  [VIEWS]: { row: RowView };
  label: string;
  nested: string;
  viaConst: string;
  shout: string;
}

/** Reads the row's well-known keys, and a `const` key, in the pattern body. */
export const Wrapper = pattern<RowInput, WrapperOutput>(({ piece }) => {
  const row = Row({ piece });
  return {
    [NAME]: row[NAME],
    [VIEWS]: row[VIEWS],
    [UI]: <div>{row[UI]}</div>,
    label: row[NAME],
    nested: row[VIEWS].row.rendered,
    viaConst: row[KEY],
    shout: row[NAME] + "!",
  };
});

/** What one row of a list republishes. */
export interface ListedRow {
  label: string;
  nested: string;
  viaConst: string;
}

/** Reads the same keys inside a collection callback, one row per entry. */
export const Listed = pattern<
  { entries: Default<{ piece: string }[], [{ piece: "a" }, { piece: "b" }]> },
  { rows: ListedRow[] }
>(({ entries }) => ({
  rows: entries.map((entry) => {
    const row = Row({ piece: entry.piece });
    return {
      label: row[NAME],
      nested: row[VIEWS].row.rendered,
      viaConst: row[KEY],
    };
  }),
}));
