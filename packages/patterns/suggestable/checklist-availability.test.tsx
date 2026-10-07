/** Exercises the checklist's production presentation with native outcomes. */
import {
  action,
  assert,
  type AsyncResult,
  FabricUnavailable,
  type HasError,
  type IsPending,
  type IsSyncing,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { findElement, propValue, textContent } from "../test/vnode-helpers.ts";
import { type ChecklistItem, ChecklistPresentation } from "./checklist.tsx";

export default pattern(() => {
  const request = new Writable<AsyncResult<{ items: ChecklistItem[] }>>({
    items: [{ label: "First step", done: false }],
  });
  const subject = ChecklistPresentation({
    topic: "Plan",
    responseRequest: request,
  });
  return {
    [TESTS]: [
      { assertion: assert(() => subject.items[0].label === "First step") },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("First step")
        ),
      },
      {
        action: action(() =>
          request.set(new FabricUnavailable("pending") as IsPending)
        ),
      },
      {
        assertion: assert(() => subject.pending && subject.items.length === 0),
      },
      {
        assertion: assert(() =>
          findElement(subject[UI], "cf-loader") !== undefined
        ),
      },
      {
        action: action(() =>
          request.set(new FabricUnavailable("syncing") as IsSyncing)
        ),
      },
      { assertion: assert(() => subject.pending === true) },
      {
        assertion: assert(() =>
          findElement(subject[UI], "cf-loader") !== undefined
        ),
      },
      {
        assertion: assert(() =>
          !textContent(subject[UI]).includes("First step")
        ),
      },
      {
        action: action(() =>
          request.set(
            new FabricUnavailable("error", "provider", "refused") as HasError,
          )
        ),
      },
      {
        assertion: assert(() =>
          subject.pending === false && subject.items.length === 0
        ),
      },
      {
        assertion: assert(() =>
          findElement(subject[UI], "cf-loader") === undefined
        ),
      },
      {
        assertion: assert(() => textContent(subject[UI]).includes("refused")),
      },
      {
        assertion: assert(() =>
          subject.error === "refused" &&
          propValue(findElement(subject[UI], "p"), "role") === "alert"
        ),
      },
      { action: action(() => request.set({ items: [] })) },
      {
        assertion: assert(() =>
          subject.error === "" && findElement(subject[UI], "p") === undefined
        ),
      },
      {
        assertion: assert(() =>
          subject.pending === false && subject.items.length === 0
        ),
      },
      {
        action: action(() =>
          request.set({ items: [{ label: "Recovered step", done: false }] })
        ),
      },
      {
        assertion: assert(() =>
          subject.pending === false &&
          subject.items[0].label === "Recovered step"
        ),
      },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("Recovered step")
        ),
      },
      {
        assertion: assert(() =>
          subject.error === "" && !textContent(subject[UI]).includes("refused")
        ),
      },
    ],
  };
});
