import {
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// W6 positive control: raw `new Date()` and `Math.random()` inside a handler must
// work — coarsened to one second for the clock, pass-through for entropy — since
// a handler is allowed the coarse ambient clock. Firing `stamp` runs them.
interface Output {
  [NAME]: string;
  [UI]: VNode;
  stampedAt: number;
  roll: number;
  stamp: Stream<void>;
}

const doStamp = handler<
  void,
  { stampedAt: Writable<number>; roll: Writable<number> }
>((_, { stampedAt, roll }) => {
  stampedAt.set(new Date().getTime());
  roll.set(Math.floor(Math.random() * 6) + 1);
});

const HandlerRawClockOk = pattern<void, Output>(() => {
  const stampedAt = new Writable(0);
  const roll = new Writable(0);
  const stamp = doStamp({ stampedAt, roll });
  return {
    [NAME]: "handler-raw-clock-ok",
    [UI]: <div />,
    stampedAt,
    roll,
    stamp,
  };
});

export default HandlerRawClockOk;
