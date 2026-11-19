import {
  action,
  assert,
  type AsyncResult,
  FabricUnavailable,
  type IsPending,
  isPending,
  observeAvailability,
  pattern,
  resultOf,
  TESTS,
  Writable,
} from "commonfabric";

const SearchConsumer = pattern(({
  enabled,
  response,
}: { enabled: boolean; response: AsyncResult<{ data: string }> }) => {
  const search = resultOf(response);
  const data = enabled ? search.data : null;
  return { data };
});

export default pattern(() => {
  const enabled = new Writable(false);
  const response = new Writable<AsyncResult<{ data: string }>>(
    new FabricUnavailable("pending") as IsPending,
  );
  const search = SearchConsumer({ enabled, response });
  const observed = observeAvailability(search.data);
  return {
    [TESTS]: [
      { assertion: assert(() => search.data === null) },
      { action: action(() => enabled.set(true)) },
      { assertion: assert(() => isPending(observed)) },
      { action: action(() => response.set({ data: "Glaze" })) },
      { assertion: assert(() => search.data === "Glaze") },
      { action: action(() => enabled.set(false)) },
      { assertion: assert(() => search.data === null) },
      {
        action: action(() =>
          response.set(new FabricUnavailable("pending") as IsPending)
        ),
      },
      { assertion: assert(() => search.data === null) },
    ],
  };
});
