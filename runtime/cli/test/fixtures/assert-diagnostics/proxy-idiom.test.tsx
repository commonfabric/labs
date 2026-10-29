/**
 * Failing assertions that read pattern output through reactive proxies, the
 * way a real pattern test does, rather than through `cell(...).get()`. The
 * operands here are lowered array-method calls and optional chains, so this
 * covers recording around them. Run by assert-diagnostics.test.ts, which
 * expects the failures; it is not a pattern under test.
 */

import { action, assert, pattern, TESTS } from "commonfabric";
import Subject from "./subject.tsx";

export default pattern(() => {
  const list = Subject({ items: [] });

  const action_add = action(() => {
    list.addItem.send({ name: "Coffee", quantity: 2 });
  });

  return {
    [TESTS]: [
      { action: action_add },
      // Fails: the list has one item, not seven.
      { assertion: assert(() => list.items.filter(() => true).length === 7) },
      // Fails: the name is "Coffee".
      { assertion: assert(() => list.items[0]?.name === "Tea") },
    ],
    list,
  };
});
