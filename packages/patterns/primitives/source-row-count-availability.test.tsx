/**
 * Exercises the row count's production presentation with native unavailable
 * query results, including recovery and a genuinely empty aggregate.
 */
import {
  action,
  assert,
  type AsyncResult,
  FabricUnavailable,
  type HasError,
  type IsPending,
  type IsSyncing,
  NAME,
  pattern,
  type SqliteQueryResult,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { findElementByText, textContent } from "../test/vnode-helpers.ts";
import {
  type CountRow,
  SourceRowCountPresentation,
} from "./source-row-count.tsx";

export default pattern(() => {
  const read = new Writable<AsyncResult<SqliteQueryResult<CountRow>>>({
    rows: [{ total: 3, matching: 2 }],
  });
  const count = SourceRowCountPresentation({
    countRead: read,
    table: "records",
    predicate: "active = 1",
  });

  return {
    [TESTS]: [
      { assertion: assert(() => textContent(count[UI]).includes("2 of 3")) },
      {
        action: action(() => {
          read.set(new FabricUnavailable("pending") as IsPending);
        }),
      },
      { assertion: assert(() => count.pending) },
      { assertion: assert(() => count[NAME] === "counting rows in records") },
      { assertion: assert(() => textContent(count[UI]).includes("counting")) },
      { assertion: assert(() => !textContent(count[UI]).includes("0 of 0")) },
      { assertion: assert(() => count.errorMessage === "") },
      {
        action: action(() => {
          read.set(new FabricUnavailable("syncing") as IsSyncing);
        }),
      },
      { assertion: assert(() => count.pending) },
      { assertion: assert(() => count[NAME] === "counting rows in records") },
      { assertion: assert(() => textContent(count[UI]).includes("counting")) },
      { assertion: assert(() => !textContent(count[UI]).includes("0 of 0")) },
      { assertion: assert(() => count.errorMessage === "") },
      {
        action: action(() => {
          read.set(
            new FabricUnavailable("error", "network", "offline") as HasError,
          );
        }),
      },
      { assertion: assert(() => count.pending === false) },
      { assertion: assert(() => count.errorMessage === "offline") },
      {
        assertion: assert(() =>
          findElementByText(count[UI], "cf-alert", "offline") !== undefined
        ),
      },
      { action: action(() => read.set({ rows: [{ total: 0, matching: 0 }] })) },
      { assertion: assert(() => count.pending === false) },
      { assertion: assert(() => count.errorMessage === "") },
      { assertion: assert(() => textContent(count[UI]).includes("0 of 0")) },
      { action: action(() => read.set({ rows: [{ total: 5, matching: 4 }] })) },
      { assertion: assert(() => count.total === 5 && count.matching === 4) },
      { assertion: assert(() => textContent(count[UI]).includes("4 of 5")) },
    ],
  };
});
