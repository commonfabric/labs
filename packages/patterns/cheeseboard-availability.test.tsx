/** Exercises the production pizza presentation across native fetch outcomes. */

import {
  action,
  assert,
  type AsyncResult,
  computed,
  FabricUnavailable,
  type HasError,
  hasError,
  type IsPending,
  isPending,
  type IsSyncing,
  isSyncing,
  observeAvailability,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { CheeseboardPresentation, type WebReadResult } from "./cheeseboard.tsx";
import { textContent } from "./test/vnode-helpers.ts";

export default pattern(() => {
  const request = new Writable<AsyncResult<WebReadResult>>({
    content: "Tue Jul 15\n\n### Pizza\n\nRoasted tomatoes and basil\n",
    metadata: { word_count: 8 },
  });
  const subject = CheeseboardPresentation({ responseRequest: request });
  const pizzas = observeAvailability(subject.pizzaList);
  const scheduleState = computed(() => {
    if (isPending(pizzas)) return "pending";
    if (isSyncing(pizzas)) return "syncing";
    if (hasError(pizzas)) return `${pizzas.errorKind}: ${pizzas.errorMessage}`;
    return "usable";
  });

  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          subject.pizzaList[0][0] === "Tue Jul 15" &&
          subject.pizzaList[0][1] === "Roasted tomatoes and basil"
        ),
      },
      { render: subject[UI] },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("Roasted tomatoes and basil")
        ),
      },
      {
        action: action(() =>
          request.set(new FabricUnavailable("pending") as IsPending)
        ),
      },
      { assertion: assert(() => scheduleState === "pending") },
      {
        action: action(() =>
          request.set(new FabricUnavailable("syncing") as IsSyncing)
        ),
      },
      { assertion: assert(() => scheduleState === "syncing") },
      {
        action: action(() =>
          request.set(
            new FabricUnavailable(
              "error",
              "schemaMismatch",
              "content is missing",
            ) as HasError,
          )
        ),
      },
      {
        assertion: assert(() =>
          scheduleState === "schemaMismatch: content is missing"
        ),
      },
      {
        action: action(() =>
          request.set({ content: "", metadata: { word_count: 0 } })
        ),
      },
      {
        assertion: assert(() =>
          scheduleState === "usable" && subject.pizzaList.length === 0
        ),
      },
      {
        action: action(() =>
          request.set({
            content: "Wed Jul 16\n\n### Pizza\n\nSweet corn and peppers\n",
            metadata: { word_count: 8 },
          })
        ),
      },
      {
        assertion: assert(() =>
          subject.pizzaList.length === 1 &&
          subject.pizzaList[0][0] === "Wed Jul 16" &&
          subject.pizzaList[0][1] === "Sweet corn and peppers"
        ),
      },
      { render: subject[UI] },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("Sweet corn and peppers")
        ),
      },
    ],
  };
});
