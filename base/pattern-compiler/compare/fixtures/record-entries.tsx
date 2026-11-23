/// <cts-enable />
import { computed, pattern } from "commonfabric";

interface Item {
  title: string;
  note: string;
}

interface Row {
  name: string;
  title: string;
}

// A row for each entry of a record: the entry's name, and a field of the
// value the record holds under that name. The text beside the rows is a
// plain value of the result.
export default pattern<
  { byName: Record<string, Item> },
  { kind: string; rows: Row[] }
>(({ byName }) => {
  const rows = computed(() =>
    Object.entries(byName).map(([name, item]) => ({
      name,
      title: item.title + "!",
    }))
  );
  return { kind: "table", rows };
});
