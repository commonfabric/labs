/** Exercises the production budget state with native outcomes and recovery. */
import {
  action,
  assert,
  type AsyncResult,
  FabricUnavailable,
  type HasError,
  type IsObsolete,
  type IsPending,
  type IsSyncing,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import { budgetPresentationState } from "./budget-planner.tsx";

export default pattern(() => {
  const request = new Writable<
    AsyncResult<{
      items: { name: string; amount: number }[];
    }>
  >({ items: [{ name: "Supplies", amount: 20 }] });
  const state = budgetPresentationState({ topic: "Plan", request });
  const noTopic = budgetPresentationState({ topic: "", request });
  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          state.response.items[0]?.name === "Supplies" && !state.pending &&
          state.error === ""
        ),
      },
      {
        action: action(() =>
          request.set(new FabricUnavailable("pending") as IsPending)
        ),
      },
      {
        assertion: assert(() =>
          state.pending && state.error === "" &&
          state.response.items.length === 0
        ),
      },
      {
        action: action(() =>
          request.set(new FabricUnavailable("syncing") as IsSyncing)
        ),
      },
      {
        assertion: assert(() =>
          state.pending && state.error === "" &&
          state.response.items.length === 0
        ),
      },
      {
        action: action(() =>
          request.set(
            new FabricUnavailable(
              "obsolete",
              null,
              "Use the replacement budget",
            ) as IsObsolete,
          )
        ),
      },
      {
        assertion: assert(() =>
          !state.pending && state.error === "Use the replacement budget" &&
          state.response.items.length === 0
        ),
      },
      {
        action: action(() =>
          request.set(new FabricUnavailable("obsolete") as IsObsolete)
        ),
      },
      {
        assertion: assert(() =>
          state.error === "This budget output has been retired."
        ),
      },
      {
        action: action(() =>
          request.set(
            new FabricUnavailable(
              "error",
              "provider",
              "Provider refused",
            ) as HasError,
          )
        ),
      },
      {
        assertion: assert(() =>
          !state.pending && state.error === "Provider refused" &&
          state.response.items.length === 0
        ),
      },
      {
        assertion: assert(() =>
          !noTopic.pending && noTopic.error === "" &&
          noTopic.response.items.length === 0
        ),
      },
      {
        action: action(() =>
          request.set({ items: [{ name: "Recovered", amount: 30 }] })
        ),
      },
      {
        assertion: assert(() =>
          state.response.items[0]?.name === "Recovered" && !state.pending &&
          state.error === ""
        ),
      },
    ],
  };
});
