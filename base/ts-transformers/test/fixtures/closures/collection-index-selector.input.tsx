import { Cell, pattern, Writable } from "commonfabric";

// FIXTURE: collection-index-selector
// Verifies: groupBy/keyBy preserve Cell identity and evaluate conditional keys
//   inside one computation before tagging their primitive or Cell key kind.
// Context: A block selector omits empty labels; identity keys share their text.
interface Row {
  label: string;
  owner: Cell<string>;
  useOwner: boolean;
}
export default pattern<{ rows: Writable<Row[]> }>(({ rows }) => {
  const groups = rows.groupBy((row) => row.useOwner ? row.owner : row.label);
  const unique = rows.keyBy((row) => {
    return row.label !== "" ? row.label : undefined;
  });
  return { groups, unique };
});
