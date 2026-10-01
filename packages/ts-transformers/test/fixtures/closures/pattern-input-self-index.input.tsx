import {
  handler,
  NAME,
  pattern,
  SELF,
  type Stream,
  UI,
  type VNode,
} from "commonfabric";

interface Input {
  title: string;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  other: unknown;
  otherTitle: string;
  poke: Stream<void>;
}

const Child = pattern<{ room: unknown }, { [UI]: VNode }>(() => ({
  [UI]: <span>child</span>,
}));

const poke = handler<void, { room: unknown }>((_, { room }) => {
  console.log(room);
});

// FIXTURE: pattern-input-self-index
// Verifies: `input[SELF]` in the pattern body reads the pattern's own result
// in place, the way a destructured `[SELF]` binding does
//   input[SELF]                  → input[__cfHelpers.SELF]
//   input[SELF].title            → input[__cfHelpers.SELF].key("title")
//   const self = input[SELF]     → const self = input[__cfHelpers.SELF]
//   input[SELF].title + "!"      → lift over input[__cfHelpers.SELF].key("title")
//   poke({ room: input[SELF] })  → poke({ room: input[__cfHelpers.SELF] })
// Context: `SELF` adds no `$SELF` path to the pattern's input schema
export default pattern<Input, Output>((input) => {
  const self = input[SELF];
  return {
    [NAME]: "Input SELF",
    [UI]: (
      <div>
        <Child room={input[SELF]} />
        <Child room={self} />
        <span>{input[SELF].title}</span>
        <span>{input[SELF].title + "!"}</span>
      </div>
    ),
    title: input.title,
    other: input[SELF],
    otherTitle: input[SELF].title,
    poke: poke({ room: input[SELF] }),
  };
});
