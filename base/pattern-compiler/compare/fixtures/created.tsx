/// <cts-enable />
import {
  Cell,
  type Confidential,
  lift,
  pattern,
  UI,
  Writable,
} from "commonfabric";

type Noted = Confidential<string, ["alice"]>;

// A `lift` with no labeled input creates a cell under a type that
// declares a clause, writes it, and returns the handle (the form of
// `makePromptInfluenceDisclosure` in
// `patterns/examples/cfc-spec-gallery/main.tsx`).
const make = lift<{ id: string; content: string }, Writable<Noted>>((input) =>
  Cell.for<Noted>(input.id).set(input.content as Noted)
);

function Card({ value }: { value: Writable<string> }) {
  return <cf-cfc-label $value={value} />;
}

interface Input {
  note: string;
}

export default pattern<Input>((_input) => {
  const made = make({ id: "created-fixture", content: "text" });
  return {
    [UI]: (
      <div>
        <cf-cfc-label $value={made} />
        {Card({ value: made })}
      </div>
    ),
  };
});
