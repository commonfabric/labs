/// <cts-enable />
import { handler, pattern, type Stream, Writable } from "commonfabric";

// A handler binding that gives its state a literal: the slot of the
// literal is a constant of the plan.
const copy = handler<void, { result: Writable<string>; message: string }>(
  (_, { result, message }) => {
    result.set(message);
  },
);

export default pattern<{ title: string }>(({ title }) => {
  const result = new Writable("");
  return {
    title,
    result,
    copy: copy({ result, message: "fixed text" }) as Stream<void>,
  };
});
