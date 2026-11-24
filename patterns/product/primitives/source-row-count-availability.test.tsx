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
  type IsObsolete,
  type IsPending,
  type IsSyncing,
  NAME,
  pattern,
  type SqliteQueryResult,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findElementByText,
  propValue,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
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
          propValue(
            findElementByText(count[UI], "cf-alert", "offline"),
            "status",
          ) === "error"
        ),
      },
      {
        action: action(() =>
          read.set(
            new FabricUnavailable(
              "obsolete",
              null,
              "Use the replacement counter",
            ) as IsObsolete,
          )
        ),
      },
      {
        assertion: assert(() =>
          !count.pending && count.total === 0 && count.matching === 0 &&
          count.errorMessage === "" &&
          count[NAME] === "row count retired in records" &&
          propValue(
              findElementByText(
                count[UI],
                "cf-alert",
                "Use the replacement counter",
              ),
              "status",
            ) === "info" &&
          !textContent(count[UI]).includes("0 of 0")
        ),
      },
      {
        action: action(() =>
          read.set(new FabricUnavailable("obsolete") as IsObsolete)
        ),
      },
      {
        assertion: assert(() =>
          count.errorMessage === "" &&
          textContent(count[UI]).includes(
            "This row count output has been retired.",
          )
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
