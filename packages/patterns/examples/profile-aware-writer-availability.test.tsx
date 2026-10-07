/** Exercises the writer's production result presentation with native errors. */
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
import {
  findElement,
  findNode,
  propValue,
  textContent,
} from "../test/vnode-helpers.ts";
import { ProfileWriterResultPresentation } from "./profile-aware-writer.tsx";

export default pattern(() => {
  const request = new Writable<AsyncResult<string>>("First text");
  const writer = ProfileWriterResultPresentation({
    topic: "Weather",
    resultRequest: request,
  });
  return {
    [TESTS]: [
      {
        assertion: assert(() => textContent(writer[UI]).includes("First text")),
      },
      {
        action: action(() =>
          request.set(new FabricUnavailable("pending") as IsPending)
        ),
      },
      {
        assertion: assert(() =>
          writer.availability === "pending" && writer.error === ""
        ),
      },
      {
        assertion: assert(() =>
          findElement(writer[UI], "cf-loader") !== undefined
        ),
      },
      {
        action: action(() =>
          request.set(new FabricUnavailable("syncing") as IsSyncing)
        ),
      },
      {
        assertion: assert(() =>
          writer.availability === "syncing" && writer.error === ""
        ),
      },
      {
        assertion: assert(() =>
          findNode(
            writer[UI],
            (node) => propValue(node, "role") === "alert",
          ) === undefined
        ),
      },
      {
        assertion: assert(() =>
          findNode(
            writer[UI],
            (node) => propValue(node, "role") === "status",
          ) !== undefined
        ),
      },
      {
        action: action(() =>
          request.set(
            new FabricUnavailable(
              "error",
              "schemaMismatch",
              "unexpected text",
            ) as HasError,
          )
        ),
      },
      {
        assertion: assert(() =>
          writer.availability === "error" &&
          writer.errorKind === "schemaMismatch"
        ),
      },
      { assertion: assert(() => writer.error === "unexpected text") },
      {
        assertion: assert(() =>
          findNode(
            writer[UI],
            (node) => propValue(node, "role") === "alert",
          ) !== undefined
        ),
      },
      {
        assertion: assert(() =>
          textContent(writer[UI]).includes("unexpected text")
        ),
      },
      {
        action: action(() =>
          request.set(
            new FabricUnavailable(
              "error",
              "provider",
              "provider refused",
            ) as HasError,
          )
        ),
      },
      {
        assertion: assert(() =>
          writer.availability === "error" && writer.errorKind === "provider" &&
          writer.error === "provider refused"
        ),
      },
      { action: action(() => request.set("Recovered text")) },
      {
        assertion: assert(() =>
          writer.availability === "ready" && writer.error === "" &&
          writer.errorKind === undefined
        ),
      },
      {
        assertion: assert(() =>
          textContent(writer[UI]).includes("Recovered text")
        ),
      },
    ],
  };
});
