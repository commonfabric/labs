/**
 * Fixture: action closing over SELF requires inputs with defaults so the
 * piece data always satisfies the output schema's required properties.
 */

import { action, type Default, NAME, pattern, SELF, UI, type VNode, Writable } from "commonfabric";

interface TestOutput {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  count: number;
}

// FIXTURE: action-self-closure
// Verifies: action() closing over SELF captures self properties in the handler
//   action(() => console.log(self.title)) → handler(eventSchema, { self: { title } }, (_, { self }) => ...)({ self: { title: self.key("title") } })
//   action(() => { self; count.set(...) }) → handler(eventSchema, { self: TestOutput, count: asCell }, ...)({ self, count })
// Context: SELF reference requires Default<> inputs so output schema is always satisfied
export default pattern<{ title: Default<string, ""> }, TestOutput>(
  ({ title, [SELF]: self }) => {
    const count = new Writable(0);

    // Action closing over `self` — works because all inputs use Default<>
    const showSelf = action((_: Record<string, never>) => {
      console.log("self.title:", self.title);
    });

    // Action closing over both `self` and `count`
    const incrementWithSelf = action((_: Record<string, never>) => {
      console.log("self:", self);
      count.set(count.get() + 1);
    });

    return {
      [NAME]: "Action SELF Test",
      [UI]: (
        <div>
          <cf-button onClick={showSelf}>Show Self</cf-button>
          <cf-button onClick={incrementWithSelf}>Increment with Self</cf-button>
        </div>
      ),
      title,
      count,
    };
  },
);
