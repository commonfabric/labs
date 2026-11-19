/** Exercises the production diagram view across native availability outcomes. */
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
  UI,
  Writable,
} from "commonfabric";
import {
  findElement,
  propValue,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import { DiagramPresentation } from "./diagram.tsx";

export default pattern(() => {
  const request = new Writable<AsyncResult<string>>("Initial diagram");
  const subject = DiagramPresentation({
    topic: "Plan",
    responseRequest: request,
  });
  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          subject.diagram === "Initial diagram" &&
          textContent(subject[UI]).includes("Initial diagram")
        ),
      },
      {
        action: action(() =>
          request.set(new FabricUnavailable("pending") as IsPending)
        ),
      },
      {
        assertion: assert(() =>
          subject.pending && subject.error === "" && subject.diagram === "" &&
          findElement(subject[UI], "cf-loader") !== undefined
        ),
      },
      {
        action: action(() =>
          request.set(new FabricUnavailable("syncing") as IsSyncing)
        ),
      },
      {
        assertion: assert(() =>
          subject.pending && subject.availability === "syncing" &&
          subject.error === "" &&
          findElement(subject[UI], "cf-loader") !== undefined
        ),
      },
      {
        action: action(() =>
          request.set(
            new FabricUnavailable(
              "obsolete",
              null,
              "Use the replacement diagram",
            ) as IsObsolete,
          )
        ),
      },
      {
        assertion: assert(() =>
          !subject.pending && subject.availability === "obsolete" &&
          subject.diagram === "" &&
          subject.error === "Use the replacement diagram"
        ),
      },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("Use the replacement diagram") &&
          propValue(findElement(subject[UI], "div"), "role") === "alert"
        ),
      },
      {
        action: action(() =>
          request.set(new FabricUnavailable("obsolete") as IsObsolete)
        ),
      },
      {
        assertion: assert(() =>
          subject.error === "This diagram output has been retired."
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
          !subject.pending && subject.error === "Provider refused" &&
          textContent(subject[UI]).includes("Provider refused")
        ),
      },
      { action: action(() => request.set("Recovered diagram")) },
      {
        assertion: assert(() =>
          subject.diagram === "Recovered diagram" && !subject.pending &&
          subject.error === "" &&
          textContent(subject[UI]).includes("Recovered diagram")
        ),
      },
    ],
  };
});
