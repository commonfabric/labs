import { computed, pattern } from "commonfabric";

// FIXTURE: pattern-vs-computed-logical-and
// Verifies: top-level pattern JSX logical roots lower structurally, but computed-owned logical roots stay authored
//   <div>{foo && name}</div> in a pattern body → __cfHelpers.when(...)
//   <div>{computed(() => foo && bar)}</div> keeps the authored && inside the computed callback
export const PatternLogicalAnd = pattern<{
  foo: boolean;
  user: { name: string };
}>(({ foo, user: { name } }) => (
  <div>{foo && name}</div>
));

export const ComputedLogicalAnd = pattern<{ foo: boolean; bar: string }>((
  { foo, bar },
) => (
  <div>{computed(() => foo && bar)}</div>
));
