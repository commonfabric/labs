import { NAME, pattern, UI, VIEWS, type VNode } from "commonfabric";

interface RowInput {
  piece: string;
}

interface RowView {
  rendered: string;
}

interface RowOutput {
  [UI]: VNode;
  [NAME]: string;
  [VIEWS]: { row: RowView };
}

const Row = pattern<RowInput, RowOutput>((input) => ({
  [UI]: <div />,
  [NAME]: input.piece,
  [VIEWS]: { row: { rendered: input.piece } },
}));

// FIXTURE: pattern-factory-result-key-destructure
// Verifies: destructuring well-known keys off a pattern-factory result keys
// each binding by the key's string
//   { [NAME]: name }   → .key("$NAME")
//   { [VIEWS]: views } → .key("$VIEWS")
//   { [UI]: ui }       → .key("$UI")
export default pattern<RowInput, RowOutput>(({ piece }) => {
  const { [NAME]: name, [VIEWS]: views, [UI]: ui } = Row({ piece });
  return { [NAME]: name, [VIEWS]: views, [UI]: ui };
});
