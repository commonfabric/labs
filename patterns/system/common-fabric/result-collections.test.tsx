/** Checks ordinary and reactive collection operations across native availability. */
import {
  action,
  assert,
  type AsyncResult,
  computed,
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
  resultOf,
  TESTS,
  Writable,
} from "commonfabric";

const CollectionProbe = pattern((
  { request }: { request: AsyncResult<number[]> },
) => ({
  direct: computed(() => resultOf(request).flatMap((n) => [n + 1])),
  alias: computed(() => {
    const usable = resultOf(request);
    return usable.flatMap((n) => [n + 1]);
  }),
  reactive: resultOf(request).flatMap((n) => [n + 1]),
}));

export default pattern(() => {
  const request = new Writable<AsyncResult<number[]>>([1, 2]);
  const values = CollectionProbe({ request });
  const direct = observeAvailability(values.direct);
  const alias = observeAvailability(values.alias);
  const reactive = observeAvailability(values.reactive);
  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          values.direct.join() === "2,3" && values.alias.join() === "2,3" &&
          values.reactive.join() === "2,3"
        ),
      },
      {
        action: action(() =>
          request.set(new FabricUnavailable("pending") as IsPending)
        ),
      },
      {
        assertion: assert(() =>
          isPending(direct) && isPending(alias) && isPending(reactive)
        ),
      },
      {
        action: action(() =>
          request.set(new FabricUnavailable("syncing") as IsSyncing)
        ),
      },
      {
        assertion: assert(() =>
          isSyncing(direct) && isSyncing(alias) && isSyncing(reactive)
        ),
      },
      {
        action: action(() =>
          request.set(
            new FabricUnavailable(
              "error",
              "network",
              "Unavailable list",
            ) as HasError,
          )
        ),
      },
      {
        assertion: assert(() =>
          hasError(direct) && hasError(alias) && hasError(reactive) &&
          direct.message === "Unavailable list" &&
          alias.message === "Unavailable list" &&
          reactive.message === "Unavailable list"
        ),
      },
      {
        action: action(() =>
          request.set(
            new FabricUnavailable(
              "obsolete",
              null,
              "Use the new list",
            ) as IsObsolete,
          )
        ),
      },
      {
        assertion: assert(() =>
          isObsolete(direct) && isObsolete(alias) && isObsolete(reactive) &&
          direct.message === "Use the new list" &&
          alias.message === "Use the new list" &&
          reactive.message === "Use the new list"
        ),
      },
      { action: action(() => request.set([4])) },
      {
        assertion: assert(() =>
          values.direct.join() === "5" && values.alias.join() === "5" &&
          values.reactive.join() === "5"
        ),
      },
    ],
  };
});
