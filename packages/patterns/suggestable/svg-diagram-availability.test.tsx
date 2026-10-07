/** Exercises diagram presentation using native producer outcomes. */
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
import { SvgDiagramPresentation } from "./svg-diagram.tsx";

export default pattern(() => {
  const request = new Writable<AsyncResult<string>>("<svg>first</svg>");
  const diagram = SvgDiagramPresentation({
    topic: "Weather",
    responseRequest: request,
  });
  return {
    [TESTS]: [
      { assertion: assert(() => diagram.diagram === "<svg>first</svg>") },
      {
        action: action(() =>
          request.set(new FabricUnavailable("pending") as IsPending)
        ),
      },
      {
        assertion: assert(() =>
          diagram.pending && diagram.availability === "pending"
        ),
      },
      {
        assertion: assert(() =>
          findElement(diagram[UI], "cf-loader") !== undefined
        ),
      },
      {
        action: action(() =>
          request.set(new FabricUnavailable("syncing") as IsSyncing)
        ),
      },
      {
        assertion: assert(() =>
          diagram.availability === "syncing" && diagram.error === ""
        ),
      },
      { assertion: assert(() => diagram.pending === true) },
      {
        assertion: assert(() =>
          textContent(diagram[UI]).includes("Waiting for synchronized data.")
        ),
      },
      {
        assertion: assert(() =>
          findNode(
            diagram[UI],
            (node) => propValue(node, "role") === "alert",
          ) ===
            undefined
        ),
      },
      {
        assertion: assert(() =>
          findNode(
            diagram[UI],
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
              "unexpected SVG",
            ) as HasError,
          )
        ),
      },
      { assertion: assert(() => diagram.availability === "error") },
      { assertion: assert(() => diagram.errorKind === "schemaMismatch") },
      { assertion: assert(() => diagram.error === "unexpected SVG") },
      {
        assertion: assert(() =>
          textContent(diagram[UI]).includes("unexpected SVG")
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
          diagram.errorKind === "provider" &&
          diagram.error === "provider refused"
        ),
      },
      { action: action(() => request.set("<svg>recovered</svg>")) },
      {
        assertion: assert(() =>
          diagram.availability === "ready" && diagram.error === "" &&
          diagram.errorKind === undefined
        ),
      },
      { assertion: assert(() => diagram.diagram === "<svg>recovered</svg>") },
      {
        assertion: assert(() =>
          propValue(findElement(diagram[UI], "cf-svg"), "content") ===
            "<svg>recovered</svg>"
        ),
      },
    ],
  };
});
