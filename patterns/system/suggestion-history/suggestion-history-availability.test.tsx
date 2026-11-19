/** Checks history absence, failed reads, retirement, and usable recovery. */
import {
  action,
  assert,
  type AsyncResult,
  FabricUnavailable,
  type HasError,
  hasError,
  type IsObsolete,
  isObsolete,
  type IsPending,
  isPending,
  type IsSyncing,
  isSyncing,
  observeAvailability,
  pattern,
  TESTS,
  type WishErrorCode,
  Writable,
} from "commonfabric";
import {
  historyEntries,
  type SuggestionHistoryEntry,
} from "./suggestion-history.tsx";

export default pattern(() => {
  const response = new Writable<AsyncResult<Partial<SuggestionHistoryEntry>[]>>(
    new FabricUnavailable(
      "error",
      "network",
      "History read failed",
    ) as HasError,
  );
  const errorCode = new Writable<WishErrorCode | undefined>();
  const entries = historyEntries({ response, errorCode });
  const observed = observeAvailability(entries);
  const result = new Writable({ title: "Recovered suggestion" });
  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          hasError(observed) && observed.message === "History read failed"
        ),
      },
      { action: action(() => errorCode.set("no-match")) },
      { assertion: assert(() => entries.length === 0) },
      { action: action(() => errorCode.set("failed")) },
      {
        assertion: assert(() =>
          hasError(observed) && observed.message === "History read failed"
        ),
      },
      {
        action: action(() => {
          errorCode.set("no-match");
          response.set(new FabricUnavailable("pending") as IsPending);
        }),
      },
      { assertion: assert(() => isPending(observed)) },
      {
        action: action(() =>
          response.set(new FabricUnavailable("syncing") as IsSyncing)
        ),
      },
      { assertion: assert(() => isSyncing(observed)) },
      {
        action: action(() =>
          response.set(
            new FabricUnavailable(
              "obsolete",
              null,
              "Use the new history",
            ) as IsObsolete,
          )
        ),
      },
      {
        assertion: assert(() =>
          isObsolete(observed) && observed.message === "Use the new history"
        ),
      },
      {
        action: action(() =>
          response.set([
            { result, messages: [], timestamp: "2026-11-19" },
            { timestamp: "Malformed" },
          ])
        ),
      },
      {
        assertion: assert(() =>
          entries.length === 1 && entries[0].timestamp === "2026-11-19"
        ),
      },
    ],
  };
});
