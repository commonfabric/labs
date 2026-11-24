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
  observeAvailability,
  pattern,
  resultOf,
  TESTS,
  Writable,
} from "commonfabric";
import { queryStatus } from "./main.tsx";

export default pattern(() => {
  const state = new Writable<"empty" | "pending" | "retired" | "failed">(
    "empty",
  );
  const request = computed((): AsyncResult<{ rows: string[] }> => {
    switch (state.get()) {
      case "pending":
        return new FabricUnavailable("pending") as IsPending;
      case "retired":
        return new FabricUnavailable("obsolete", null, "") as IsObsolete;
      case "failed":
        return new FabricUnavailable(
          "error",
          "general",
          "Query refused.",
        ) as HasError;
      default:
        return { rows: [] };
    }
  });
  const status = queryStatus(request);
  const value = resultOf(request);
  const rows = observeAvailability(value.rows);

  return {
    [TESTS]: [
      { action: action(() => state.set("pending")) },
      { assertion: assert(() => status.pending && isPending(rows)) },
      { action: action(() => state.set("retired")) },
      {
        assertion: assert(() =>
          !status.pending && status.error === undefined && isObsolete(rows) &&
          rows.message === ""
        ),
      },
      { action: action(() => state.set("failed")) },
      {
        assertion: assert(() =>
          !status.pending && status.error === "Query refused." &&
          hasError(rows) && rows.message === "Query refused."
        ),
      },
      { action: action(() => state.set("empty")) },
      {
        assertion: assert(() =>
          !status.pending && status.error === undefined &&
          resultOf(rows).length === 0
        ),
      },
    ],
  };
});
