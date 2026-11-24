/** Checks confirmed absence separately from failure, retirement, and loading. */
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
import { optionalWishText } from "./optional-wish-text.ts";

export default pattern(() => {
  const response = new Writable<AsyncResult<string>>(
    new FabricUnavailable("error", "general", "No context found") as HasError,
  );
  const errorCode = new Writable<WishErrorCode | undefined>();
  const text = optionalWishText({ response, errorCode });
  const observed = observeAvailability(text);
  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          hasError(observed) && observed.message === "No context found"
        ),
      },
      { action: action(() => errorCode.set("no-match")) },
      { assertion: assert(() => text === "") },
      { action: action(() => errorCode.set("failed")) },
      {
        assertion: assert(() =>
          hasError(observed) && observed.message === "No context found"
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
              "Use new context",
            ) as IsObsolete,
          )
        ),
      },
      {
        assertion: assert(() =>
          isObsolete(observed) && observed.message === "Use new context"
        ),
      },
      { action: action(() => response.set("Ada's preferences")) },
      { assertion: assert(() => text === "Ada's preferences") },
      {
        action: action(() => {
          errorCode.set(undefined);
          response.set(
            new FabricUnavailable(
              "error",
              "network",
              "Context unavailable",
            ) as HasError,
          );
        }),
      },
      {
        assertion: assert(() =>
          hasError(observed) && observed.message === "Context unavailable"
        ),
      },
      { action: action(() => response.set("")) },
      { assertion: assert(() => text === "") },
    ],
  };
});
