/// <cts-enable />
import { pattern, UI, type VNode, Writable } from "commonfabric";

// A state cell given to a pattern compiled in, whose UI binds it to an
// element property by reference.
const Field = pattern<{ value: Writable<string> }, { [UI]: VNode }>(
  ({ value }) => ({ [UI]: <cf-input $value={value} /> }),
);

export default pattern<{ title: string }>(({ title }) => {
  const text = new Writable("start");
  return { title, controls: <Field value={text} /> };
});
