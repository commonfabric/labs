/** Exercises the image-analysis presentation with native producer outcomes. */
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
import { ImageAnalysisPresentation } from "./image-analysis.tsx";
import { textContent } from "./test/vnode-helpers.ts";

export default pattern(() => {
  const request = new Writable<AsyncResult<string>>("First description");
  const subject = ImageAnalysisPresentation({ responseRequest: request });
  return {
    [TESTS]: [
      { assertion: assert(() => subject.response === "First description") },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("First description")
        ),
      },
      {
        action: action(() =>
          request.set(new FabricUnavailable("pending") as IsPending)
        ),
      },
      {
        assertion: assert(() =>
          subject.pending && subject.response === undefined
        ),
      },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("Analyzing...")
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
          textContent(subject[UI]).includes("Analyzing...")
        ),
      },
      {
        assertion: assert(() =>
          !textContent(subject[UI]).includes("First description")
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
          subject.pending === false && subject.response === undefined
        ),
      },
      {
        assertion: assert(() =>
          !textContent(subject[UI]).includes("Analyzing...")
        ),
      },
      { action: action(() => request.set("")) },
      {
        assertion: assert(() =>
          subject.pending === false && subject.response === ""
        ),
      },
      { action: action(() => request.set("Recovered description")) },
      {
        assertion: assert(() =>
          subject.pending === false &&
          subject.response === "Recovered description"
        ),
      },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("Recovered description")
        ),
      },
    ],
  };
});
