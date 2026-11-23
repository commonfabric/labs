/// <cts-enable />
import { computed, handler, pattern, Writable } from "commonfabric";

const put = handler<
  { name: string; value: string },
  { record: Writable<Record<string, string>> }
>(({ name, value }, { record }) => {
  record.key(name).set(value);
});

const list = handler<
  unknown,
  { record: Writable<Record<string, string>>; listed: Writable<string> }
>((_, { record, listed }) => {
  listed.set(Object.keys(record.get() ?? {}).join(","));
});

// Value code that observes the order of the members of a record: the names
// of a stored record, read by a computation and by a handler through a
// handle, and the names of a record that one computation made and another
// reads.
export default pattern<{ record: Writable<Record<string, string>> }>(
  ({ record }) => {
    const listed = Writable.of("");
    const names = computed(() => Object.keys(record).join(","));
    const made = computed(() => ({ zeta: record.zeta ?? "", alpha: "a" }));
    const madeNames = computed(() => Object.keys(made).join(","));
    return {
      names,
      madeNames,
      listed,
      put: put({ record }),
      list: list({ record, listed }),
    };
  },
);
