/// <cts-enable />
/**
 * A handler's event is not forwarded: what it hands to a pattern is charged as
 * any other callee is, and nothing in it compiles as opaque.
 */
import { handler, pattern, Writable } from "commonfabric";

interface ChildInput {
  target: Writable<string>;
  label: string;
}

const Child = pattern<ChildInput, { label: string }>(({ label }) => ({ label }));

export const addChild = handler<
  { target: Writable<string>; label: string },
  { made: Writable<unknown[]> }
>(({ target, label }, { made }) => {
  made.push(Child({ target, label }));
});
