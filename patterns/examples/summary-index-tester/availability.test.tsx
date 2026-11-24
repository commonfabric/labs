import {
  action,
  assert,
  type AsyncResult,
  FabricUnavailable,
  type HasError,
  hasError,
  type IsObsolete,
  isObsolete,
  observeAvailability,
  pattern,
  TESTS,
  type WishErrorCode,
  Writable,
} from "commonfabric";
import type { SummaryIndexEntry } from "../../system/summary-index/summary-index.tsx";
import { summaryIndexEntries } from "./summary-index-tester.tsx";

type Index = {
  entries: SummaryIndexEntry[];
  search: { pattern: unknown; extraParams: { entries: SummaryIndexEntry[] } };
};

export default pattern(() => {
  const response = new Writable<AsyncResult<Index>>(
    new FabricUnavailable("error", "network", "Index refused") as HasError,
  );
  const errorCode = new Writable<WishErrorCode | undefined>("failed");
  const entries = summaryIndexEntries({ response, errorCode });
  const observed = observeAvailability(entries);
  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          hasError(observed) && observed.errorKind === "network" &&
          observed.message === "Index refused"
        ),
      },
      { action: action(() => errorCode.set("no-match")) },
      { assertion: assert(() => entries.length === 0) },
      {
        action: action(() =>
          response.set(
            new FabricUnavailable(
              "obsolete",
              null,
              "Use the new index",
            ) as IsObsolete,
          )
        ),
      },
      {
        assertion: assert(() =>
          isObsolete(observed) && observed.message === "Use the new index"
        ),
      },
      {
        action: action(() =>
          response.set({
            entries: [],
            search: { pattern: {}, extraParams: { entries: [] } },
          })
        ),
      },
      { assertion: assert(() => entries.length === 0) },
    ],
  };
});
