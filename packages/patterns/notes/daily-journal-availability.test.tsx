/** Exercises weekly-rollup presentation without invoking a provider. */
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
import { findNodeByProp, textContent } from "../test/vnode-helpers.ts";
import {
  type WeeklyRollup,
  WeeklyRollupPresentation,
} from "./daily-journal.tsx";

const rollup: WeeklyRollup = {
  headline: "A useful week",
  themes: [{ name: "Learning", detail: "Practiced daily" }],
  accomplishments: ["Completed a project"],
  openThreads: ["Plan the next project"],
  mood: "Hopeful",
};

export default pattern(() => {
  const response = new Writable<AsyncResult<WeeklyRollup>>(rollup);
  const subject = WeeklyRollupPresentation({ response });
  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          subject.weeklyRollup?.headline === "A useful week"
        ),
      },
      {
        action: action(() =>
          response.set(new FabricUnavailable("pending") as IsPending)
        ),
      },
      {
        assertion: assert(() =>
          subject.weeklyRollup === undefined &&
          findNodeByProp(subject[UI], "role", "alert") === undefined
        ),
      },
      {
        action: action(() =>
          response.set(new FabricUnavailable("syncing") as IsSyncing)
        ),
      },
      {
        assertion: assert(() =>
          subject.weeklyRollup === undefined &&
          findNodeByProp(subject[UI], "role", "alert") === undefined
        ),
      },
      {
        action: action(() =>
          response.set(
            new FabricUnavailable(
              "error",
              "provider",
              "Rollup provider refused",
            ) as HasError,
          )
        ),
      },
      {
        assertion: assert(() =>
          subject.weeklyRollup === undefined &&
          textContent(subject[UI]).includes("Rollup provider refused")
        ),
      },
      {
        assertion: assert(() =>
          subject.error === "Rollup provider refused" &&
          findNodeByProp(subject[UI], "role", "alert") !== undefined
        ),
      },
      {
        action: action(() =>
          response.set(
            new FabricUnavailable(
              "error",
              "schemaMismatch",
              "Invalid rollup format",
            ) as HasError,
          )
        ),
      },
      {
        assertion: assert(() =>
          subject.weeklyRollup === undefined &&
          subject.error === "Invalid rollup format" &&
          textContent(subject[UI]).includes("Invalid rollup format") &&
          findNodeByProp(subject[UI], "role", "alert") !== undefined
        ),
      },
      { action: action(() => response.set(rollup)) },
      {
        assertion: assert(() =>
          subject.weeklyRollup?.headline === "A useful week" &&
          subject.error === "" &&
          findNodeByProp(subject[UI], "role", "alert") === undefined
        ),
      },
    ],
  };
});
