/// <cts-enable />
import {
  type Confidential,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";
import { exchangeRules, type PolicyOf } from "commonfabric/cfc";

export const rules = exchangeRules([]);

type Sealed<T> = Confidential<T, readonly [PolicyOf<typeof rules>]>;

interface Entry {
  text: string;
}

interface Input {
  mine: Writable<Confidential<string, ["alice"]>>;
  sealed: Writable<Sealed<Entry>[]>;
}

// Writes an input whose type declares a clause at its root.
const overwrite = handler<
  unknown,
  { mine: Writable<Confidential<string, ["alice"]>> }
>((_event, { mine }) => {
  mine.set("written");
});

// Pushes onto an input whose elements declare the clause of a policy.
const seal = handler<unknown, { sealed: Writable<Sealed<Entry>[]> }>(
  (_event, { sealed }) => {
    sealed.push({ text: "sealed" } as Sealed<Entry>);
  },
);

interface Output {
  overwrite: Stream<unknown>;
  seal: Stream<unknown>;
}

export default pattern<Input, Output>(({ mine, sealed }) => {
  return { overwrite: overwrite({ mine }), seal: seal({ sealed }) };
});
