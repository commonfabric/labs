import {
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// Handler time is bound to the triggering event and carried forward to events a
// handler emits. `first` stamps its clock and sends `second`; `second` stamps
// its own. Because `second` carries `first`'s event instant forward, both stamps
// read the same value even though real wall-clock time elapses between the two
// handler runs — which is what denies a causal chain a clock that advances.
interface Output {
  [NAME]: string;
  [UI]: VNode;
  stampFirst: number;
  stampSecond: number;
  first: Stream<void>;
  second: Stream<void>;
}

const stampSecondHandler = handler<void, { stampSecond: Writable<number> }>(
  (_, { stampSecond }) => {
    stampSecond.set(Date.now());
  },
);

const stampFirstHandler = handler<
  void,
  { stampFirst: Writable<number>; second: Stream<void> }
>((_, { stampFirst, second }) => {
  stampFirst.set(Date.now());
  second.send();
});

const HandlerEventTimeCarryforward = pattern<void, Output>(() => {
  const stampFirst = new Writable(0);
  const stampSecond = new Writable(0);
  const second = stampSecondHandler({ stampSecond });
  const first = stampFirstHandler({ stampFirst, second });
  return {
    [NAME]: "handler-event-time-carryforward",
    [UI]: <div />,
    stampFirst,
    stampSecond,
    first,
    second,
  };
});

export default HandlerEventTimeCarryforward;
