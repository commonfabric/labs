import { NAME, pattern, UI, VIEWS, type VNode } from "commonfabric";

interface RowInput {
  piece: string;
}

interface RowView {
  rendered: string;
}

interface RowOutput extends RowView {
  [UI]: VNode;
  [NAME]: string;
  [VIEWS]: { row: RowView };
}

interface CoreOutput extends RowOutput {
  extra: string;
}

interface WrapperOutput extends RowOutput {
  label: string;
  nested: string;
}

const Row = pattern<RowInput, CoreOutput>((input) => {
  const view = { rendered: input.piece };
  return {
    [UI]: <div />,
    [NAME]: input.piece,
    [VIEWS]: { row: view },
    ...view,
    extra: input.piece,
  };
});

// FIXTURE: pattern-body-factory-result-key-access
// Verifies: `row[K]`, where K is a well-known key (NAME, UI, VIEWS) and `row`
// is a pattern-factory result bound in the pattern body, lowers to
// `row.key(__cfHelpers.K)` with no lift
//   [NAME]: row[NAME]          → row.key(__cfHelpers.NAME)
//   label: row[NAME]           → row.key(__cfHelpers.NAME)
//   row[VIEWS].row.rendered    → row.key(__cfHelpers.VIEWS, "row", "rendered")
//   <div>{row[UI]}</div>       → <div>{row.key(__cfHelpers.UI)}</div>
// Context: the same reads inside a collection callback are covered by
// map-pattern-factory-result-key-access; the two contexts lower alike
export default pattern<RowInput, WrapperOutput>(({ piece }) => {
  const row = Row({ piece });
  return {
    [NAME]: row[NAME],
    [VIEWS]: row[VIEWS],
    rendered: row.rendered,
    label: row[NAME],
    nested: row[VIEWS].row.rendered,
    [UI]: <div>{row[UI]}</div>,
  };
});
