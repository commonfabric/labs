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
  extra: string;
}

interface Output {
  shout: string;
  unrendered: boolean;
  viewless: boolean;
}

const Row = pattern<RowInput, RowOutput>((input) => {
  const view = { rendered: input.piece };
  return {
    [UI]: <div />,
    [NAME]: input.piece,
    [VIEWS]: { row: view },
    ...view,
    extra: input.piece,
  };
});

// FIXTURE: pattern-body-well-known-key-computation
// Verifies: a computation over `row[K]`, K a well-known key, lifts with an
// input schema that declares only that key of `row`
//   row[NAME] + "!"          → lift over { row: { $NAME } }
//   row[UI] === undefined    → lift over { row: { $UI } }
//   row[VIEWS] === undefined → lift over { row: { $VIEWS } }
// Context: the lift body reads `row[__cfHelpers.K]`; `rendered` and `extra`
// stay out of every input schema
export default pattern<RowInput, Output>(({ piece }) => {
  const row = Row({ piece });
  return {
    shout: row[NAME] + "!",
    unrendered: row[UI] === undefined,
    viewless: row[VIEWS] === undefined,
  };
});
