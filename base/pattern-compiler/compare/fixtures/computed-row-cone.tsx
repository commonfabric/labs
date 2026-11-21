/// <cts-enable />
import { computed, handler, pattern, Writable } from "commonfabric";

const setMark = handler<{ mark: string }, { mark: Writable<string> }>(
  (event, { mark }) => {
    mark.set(event.mark);
  },
);

// `rows` is an array that a computation returns from two inputs, so its
// elements are at no stored position. Each element of `marked` is computed
// from a row and from the cell `mark`: when a handler changes `mark`, the
// elements are computed again in a transaction that does not compute
// `rows`, and what they hold still depends on both inputs.
export default pattern<{ names: string[]; suffix: string }>(
  ({ names, suffix }) => {
    const mark = Writable.of("");
    const rows = computed(() =>
      names.map((name) => ({ title: `${name}${suffix}` }))
    );
    return {
      marked: rows.map((row) => ({ text: `${row.title}${mark.get()}` })),
      setMark: setMark({ mark }),
    };
  },
);
