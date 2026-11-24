/**
 * Test Pattern: handler capture rehydration with `.key(...).equals(...)`
 *
 * This probes two variants of the same source-level shape:
 * - handler state typed with `inboxItem: Writable<InboxItem>`
 * - handler state typed with `inboxItem: Cell<InboxItem>`
 *
 * In both cases the source pattern still accepts plain `InboxItem[]` input and
 * binds the per-item handler from inside `.map(...)`.
 *
 * Run:
 *   deno task cf test patterns/dev/gideon-tests/test-handler-capture-key-equals.test.tsx --verbose
 */
import { action, assert, pattern, TESTS } from "commonfabric";
import {
  CellInboxItemCapturePattern,
  WritableInboxItemCapturePattern,
} from "./test-handler-capture-key-equals.tsx";

const makeInboxItems = () => [
  { id: "a", text: "same" },
  { id: "b", text: "same" },
  { id: "c", text: "other" },
];

export default pattern(() => {
  const writableSubject = WritableInboxItemCapturePattern({
    inboxItems: makeInboxItems(),
  });
  const cellSubject = CellInboxItemCapturePattern({
    inboxItems: makeInboxItems(),
  });

  const action_remove_middle_writable = action(() => {
    const handlers = writableSubject.deleteHandlers.filter(() => true);
    handlers[1]?.send();
  });

  const action_remove_middle_cell = action(() => {
    const handlers = cellSubject.deleteHandlers.filter(() => true);
    handlers[1]?.send();
  });

  const assert_writable_initial_handlers = assert(() => {
    return writableSubject.deleteHandlers.filter(() => true).length === 3;
  });

  const assert_cell_initial_handlers = assert(() => {
    return cellSubject.deleteHandlers.filter(() => true).length === 3;
  });

  const assert_writable_initial_items = assert(() => {
    const items = writableSubject.inboxItems.filter(() => true);
    return items.length === 3 &&
      items[0]?.id === "a" &&
      items[1]?.id === "b" &&
      items[2]?.id === "c";
  });

  const assert_cell_initial_items = assert(() => {
    const items = cellSubject.inboxItems.filter(() => true);
    return items.length === 3 &&
      items[0]?.id === "a" &&
      items[1]?.id === "b" &&
      items[2]?.id === "c";
  });

  const assert_writable_removed_middle = assert(() => {
    const items = writableSubject.inboxItems.filter(() => true);
    return items.length === 2 &&
      items[0]?.id === "a" &&
      items[1]?.id === "c" &&
      !items.some((item) => item.id === "b");
  });

  const assert_cell_removed_middle = assert(() => {
    const items = cellSubject.inboxItems.filter(() => true);
    return items.length === 2 &&
      items[0]?.id === "a" &&
      items[1]?.id === "c" &&
      !items.some((item) => item.id === "b");
  });

  return {
    [TESTS]: [
      { assertion: assert_writable_initial_handlers },
      { assertion: assert_writable_initial_items },
      { action: action_remove_middle_writable },
      { assertion: assert_writable_removed_middle },

      { assertion: assert_cell_initial_handlers },
      { assertion: assert_cell_initial_items },
      { action: action_remove_middle_cell },
      { assertion: assert_cell_removed_middle },
    ],
    writableSubject,
    cellSubject,
  };
});
