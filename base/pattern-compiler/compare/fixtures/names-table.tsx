/// <cts-enable />
import { computed, pattern, type Writable } from "commonfabric";

interface Topic {
  title: string;
}

interface Row {
  member: Writable<Topic>;
  name: string;
}

// A row for each entry of a record of references: the reference the
// record holds under a name, and the name. The row reads nothing of what
// the reference names. The text beside the rows is a plain value of the
// result.
export default pattern<
  { names: Record<string, Writable<Topic>> },
  { kind: string; rows: Row[] }
>(({ names }) => {
  const rows = computed(() =>
    Object.entries(names).map(([name, member]) => ({ member, name }))
  );
  return { kind: "table", rows };
});
