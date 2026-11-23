/// <cts-enable />
import {
  type Default,
  lift,
  pattern,
  type ReadonlyCell,
  type Writable,
} from "commonfabric";

interface Item {
  id: string;
  title: string;
  done: boolean;
}

// A `lift` over an array of references whose declared type names one field
// of a member: the body reads each member through its handle, under that
// type.
const doneCount = lift(
  (
    { sources }: {
      sources: ReadonlyCell<{ done: boolean }>[] | Default<[]>;
    },
  ): number => Array.from(sources).filter((source) => source.get().done).length,
);

export default pattern<{ items: Writable<Item[]> }, { done: number }>(
  ({ items }) => ({ done: doneCount({ sources: items }) }),
);
