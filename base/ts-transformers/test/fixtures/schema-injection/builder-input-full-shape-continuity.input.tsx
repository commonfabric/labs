import { lift, pattern, type Writable } from "commonfabric";

// FIXTURE: builder-input-full-shape-continuity
// Verifies: builder input schemas stay conservative/full-shape when the authored contract
// does not justify path shrinking.

const liftWrapped = lift((input: Writable<{ foo: string; bar: string }>) =>
  input.get().foo
);

const patternFullShape = pattern((input: Writable<{ foo: string; bar: string }>) =>
  input.key("foo")
);

const patternExplicit = pattern<
  Writable<{ foo: string; bar: string }>,
  Writable<string>
>((input) => input.key("foo"));

const liftPassthrough = lift((input: Writable<{ foo: string; bar: string }>) =>
  input
);

const helper = (value: Writable<{ foo: string; bar: string }>) =>
  value.key("foo");

const patternHelper = pattern((input: Writable<{ foo: string; bar: string }>) =>
  helper(input)
);

const wildcardLift = lift((input: Writable<{ foo: string; bar: string }>) => {
  const foo = input.key("foo").get();
  Object.keys(input.get());
  return foo;
});

export default {
  liftWrapped,
  patternFullShape,
  patternExplicit,
  liftPassthrough,
  patternHelper,
  wildcardLift,
};
