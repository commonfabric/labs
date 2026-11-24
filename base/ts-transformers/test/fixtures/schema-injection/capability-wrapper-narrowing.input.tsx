import { lift, type Writable } from "commonfabric";

type Profile = {
  name: string;
  email: string;
};

type Item = {
  id: string;
  label: string;
};

type State = {
  foo: string;
  profile: Profile;
  items: Item[];
  unused: string;
};

// FIXTURE: capability-wrapper-narrowing
// Verifies: lift inputs narrow from Writable<> to the least capable cell
// wrapper required by callback usage.

const readOnly = lift((input: Writable<State>) => input.key("foo").get());

const setOnly = lift((input: Writable<State>) => {
  input.key("foo").set("updated");
  return 1;
});

const updateOnly = lift((input: Writable<State>) => {
  input.key("profile").update({ name: "Ada" });
  return 1;
});

const pushOnly = lift((input: Writable<State>) => {
  input.key("items").push({ id: "1", label: "First" });
  return 1;
});

const readWrite = lift((input: Writable<State>) => {
  input.key("foo").set(input.key("foo").get().toUpperCase());
  return 1;
});

const comparable = lift((input: Writable<State>) => input.equals(input));

const opaqueMap = lift((input: Writable<Item[]>) =>
  input.map((item) => item.id)
);

export {
  comparable,
  opaqueMap,
  pushOnly,
  readOnly,
  readWrite,
  setOnly,
  updateOnly,
};
