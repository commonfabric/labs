/** Exercises production stage labels and retry across native outcomes. */

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
import { textContent } from "../test/vnode-helpers.ts";
import { WriteAndRunStatus } from "./write-and-run.tsx";

export default pattern(() => {
  const generatedRequest = new Writable<AsyncResult<string>>(
    new FabricUnavailable("error", "general", "provider offline") as HasError,
  );
  const compileRequest = new Writable<
    AsyncResult<Record<string, unknown> | number | number[]>
  >(
    new FabricUnavailable("error", "general", "provider offline") as HasError,
  );
  const subject = WriteAndRunStatus({ generatedRequest, compileRequest });

  return {
    [TESTS]: [
      { render: subject[UI] },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes(
            "Generation error: provider offline",
          ) &&
          !textContent(subject[UI]).includes("Compile error:") &&
          !textContent(subject[UI]).includes("Compiling pattern...")
        ),
      },
      { assertion: assert(() => subject.error === "provider offline") },
      {
        action: action(() => {
          generatedRequest.set(new FabricUnavailable("pending") as IsPending);
          compileRequest.set(new FabricUnavailable("pending") as IsPending);
        }),
      },
      { render: subject[UI] },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("Generating code...") &&
          !textContent(subject[UI]).includes("Generation error:")
        ),
      },
      {
        action: action(() => {
          generatedRequest.set(new FabricUnavailable("syncing") as IsSyncing);
          compileRequest.set(new FabricUnavailable("syncing") as IsSyncing);
        }),
      },
      { render: subject[UI] },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("Generating code...") &&
          !textContent(subject[UI]).includes("Compiling pattern...")
        ),
      },
      { action: action(() => generatedRequest.set("usable pattern source")) },
      { render: subject[UI] },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("Compiling pattern...") &&
          !textContent(subject[UI]).includes("Generating code...")
        ),
      },
      {
        action: action(() =>
          compileRequest.set(
            new FabricUnavailable(
              "error",
              "compile",
              "invalid pattern",
            ) as HasError,
          )
        ),
      },
      { render: subject[UI] },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("Compile error: invalid pattern") &&
          !textContent(subject[UI]).includes("Generation error:")
        ),
      },
      { assertion: assert(() => subject.error === "invalid pattern") },
      { action: action(() => compileRequest.set({ value: 42 })) },
      { render: subject[UI] },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("Open Generated Pattern") &&
          !textContent(subject[UI]).includes("Compile error:") &&
          !textContent(subject[UI]).includes("Generation error:")
        ),
      },
      { assertion: assert(() => subject.error === undefined) },
      { action: action(() => compileRequest.set(42)) },
      { render: subject[UI] },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("Open Generated Pattern") &&
          subject.error === undefined
        ),
      },
      { action: action(() => compileRequest.set([1, 2])) },
      { render: subject[UI] },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("Open Generated Pattern") &&
          subject.error === undefined
        ),
      },
      {
        action: action(() =>
          generatedRequest.set(
            new FabricUnavailable(
              "error",
              "general",
              "retry offline",
            ) as HasError,
          )
        ),
      },
      { render: subject[UI] },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes(
            "Generation error: retry offline",
          ) &&
          !textContent(subject[UI]).includes("Open Generated Pattern") &&
          !textContent(subject[UI]).includes("Compile error:")
        ),
      },
      { assertion: assert(() => subject.error === "retry offline") },
    ],
  };
});
