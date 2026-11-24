import { action, computed, handler, lift, pattern, type Writable } from "commonfabric";

// FIXTURE: builder-input-path-shrink
// Verifies: builder input schemas shrink to observed paths when reads/writes are specific,
// including explicit type arguments and interprocedural helper calls.

const liftOptional = lift((input: Writable<{ foo: string | undefined; bar: string }>) =>
  input.key("foo").get()
);

const deriveInput: Writable<{ foo: string; bar: string }> = {} as never;
const computedObserved = computed(() => deriveInput.key("foo").get());

const handlerObserved = handler(
  (_event: { id: string }, state: Writable<{ foo: string; bar: string }>) => {
    state.key("foo").get();
  },
);

const handlerExplicit = handler<
  { detail: { message: string; unused: number } },
  Writable<{ foo: string; bar: string }>
>((event, state) => {
  event.detail.message;
  state.key("foo").get();
});

const helper = (value: Writable<{ foo: string; bar: string }>) =>
  value.key("foo").get();

const liftInterprocedural = lift((input: Writable<{ foo: string; bar: string }>) =>
  helper(input)
);

const liftWriteOnly = lift((input: Writable<{ foo: string; bar: string }>) => {
  input.key("foo").set("updated");
  return 1;
});

const liftExplicit = lift<Writable<{ foo: string; bar: string }>, string>(
  (input) => input.key("foo").get(),
);

const actionPattern = pattern((input: Writable<{ foo: string; bar: string }>) => {
  const a = action(() => input.key("foo").get());
  return a;
});

export default {
  liftOptional,
  computedObserved,
  handlerObserved,
  handlerExplicit,
  liftInterprocedural,
  liftWriteOnly,
  liftExplicit,
  actionPattern,
};
