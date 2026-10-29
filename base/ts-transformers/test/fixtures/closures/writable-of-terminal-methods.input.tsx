/**
 * new Writable() result accessed via .get()/.set() in action
 * callbacks. These are terminal methods handled correctly regardless
 * of opaque classification — new Writable() is an opaque origin and
 * .get()/.set() are terminal methods.
 */

import { action, pattern, UI, Writable } from "commonfabric";

interface State {
  title: string;
}

// FIXTURE: writable-of-terminal-methods
// Verifies: new Writable() gets schema annotation, and action() with .set() becomes handler()
//   new Writable(0) → new Writable(0, { type: "number" })
//   action(() => { counter.set(0); label.set("Count"); }) → handler(false, captureSchema, (_, { counter, label }) => ...)
//   ({ title }) → (__cf_pattern_input) => { title = __cf_pattern_input.key("title"); }
// Context: new Writable() produces opaque cells. The .set() calls inside
//   action() are terminal methods that require the action to be rewritten as a
//   handler with captured cell references (counter, label) in its schema.
export default pattern<State>(({ title }) => {
  const counter = new Writable(0);
  const label = new Writable("Count");

  const reset = action(() => {
    counter.set(0);
    label.set("Count");
  });

  return {
    [UI]: (
      <div>
        <span>{title} {label}: {counter}</span>
        <cf-button onClick={reset}>Reset</cf-button>
      </div>
    ),
    counter,
    label,
  };
});
