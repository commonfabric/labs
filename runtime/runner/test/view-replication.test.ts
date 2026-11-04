import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  collectViewAncestors,
  selectViewData,
  ViewDependencyGraph,
  type ViewExecutionNode,
} from "../src/view-replication.ts";

const address = (id: string, path: string[] = []) => ({
  space: "did:key:z6Mk-view" as const,
  id: `of:${id}` as const,
  type: "application/json" as const,
  scope: "space" as const,
  path,
});
function node(
  id: string,
  reads: string[],
  writes: string[],
  kind: ViewExecutionNode["kind"] = "computation",
): ViewExecutionNode {
  return {
    id,
    kind,
    piece: address("piece"),
    log: {
      reads: reads.map((id) => address(id)),
      shallowReads: [],
      writes: writes.map((id) => address(id)),
    },
    writes: writes.map((id) => address(id)),
  };
}

describe("view replication selection", () => {
  it("isolates producer lookups by space and scope while normalizing space scope", () => {
    const same = node("same", [], ["shared"]);
    same.writes[0].scope = undefined;
    const user = node("user", [], ["shared"]);
    user.writes[0].scope = "user";
    const session = node("session", [], ["shared"]);
    session.writes[0].scope = "session";
    const foreign = node("foreign", [], ["shared"]);
    foreign.writes[0].space = "did:key:z6Mk-other";
    const graph = new ViewDependencyGraph([same, user, session, foreign]);
    expect([...graph.ancestors([address("shared")])]).toEqual([same]);
    expect([...graph.ancestors([{ ...address("shared"), scope: "user" }])])
      .toEqual([user]);
    expect([...graph.ancestors([{ ...address("shared"), scope: "session" }])])
      .toEqual([session]);
  });

  it("follows observed write surfaces for producer certification", () => {
    const upstream = node("upstream", ["input"], ["declared"]);
    upstream.log.writes = [address("actual", ["child"])];
    const downstream = node("downstream", ["actual"], ["ui"]);
    const nodes = [upstream, downstream];
    expect([...new ViewDependencyGraph(nodes).ancestors([address("ui")])])
      .toEqual([downstream]);
    const graph = new ViewDependencyGraph(
      nodes,
      (node) => [...node.writes, ...node.log.writes],
    );
    expect(new Set(graph.ancestors([address("ui")])))
      .toEqual(new Set(nodes));
  });

  it("follows shallow ancestor and direct child writes while excluding deeper writes", () => {
    const root = node("root", [], ["shared"]);
    const child = node("child", [], ["shared"]);
    child.writes[0].path = ["item", "child"];
    const deep = node("deep", [], ["shared"]);
    deep.writes[0].path = ["item", "child", "deep"];
    const sibling = node("sibling", [], ["shared"]);
    sibling.writes[0].path = ["sibling"];
    const graph = new ViewDependencyGraph([root, child, deep, sibling]);
    expect(new Set(graph.ancestors([], [address("shared", ["item"])])))
      .toEqual(new Set([root, child]));
  });

  it("selects reversed chains and shared descendants exactly once", () => {
    const nodes = [
      node("render", ["left", "right"], ["ui"]),
      node("right", ["input"], ["right"]),
      node("left", ["input"], ["left"]),
      node("hidden", ["input"], ["hidden"]),
    ];
    const selected = selectViewData(
      nodes,
      [address("ui")],
      [address("input")],
      new Set(),
    );
    expect(selected.actions).toEqual(["render", "right", "left"]);
    expect(selected.reads.map((read) => read.id)).not.toContain("of:hidden");
  });

  it("selects failure ancestry across boundaries without including sibling outputs", () => {
    const visible = node("visible", ["upstream"], []);
    visible.writes = [address("shared", ["shown"])];
    const hidden = node("hidden", [], []);
    hidden.writes = [address("shared", ["hidden"])];
    const upstream = node("boundary", [], ["upstream"], "boundary");
    expect([...collectViewAncestors(
      [visible, hidden, upstream],
      [address("shared", ["shown"])],
    )].map((node) => node.id)).toEqual(["visible", "boundary"]);
  });

  it("uses observed side inputs only for the visible interaction cone", () => {
    const selected = selectViewData(
      [
        node("handler", ["draft"], ["draft"], "handler"),
        node("preview", ["draft", "options"], ["preview"]),
        node("render", ["preview", "result"], ["ui"]),
        node("fetch", ["request"], ["result"], "boundary"),
        node("request", ["secret-config", "draft"], ["request"]),
        node("offscreen", ["draft", "offscreen-data"], ["offscreen"]),
      ],
      [address("ui")],
      [],
      new Set(["handler"]),
    );
    expect(selected.actions.toSorted()).toEqual([
      "handler",
      "preview",
      "render",
    ]);
    expect(new Set(selected.reads.map((read) => read.id))).toEqual(
      new Set([
        "of:ui",
        "of:draft",
        "of:options",
        "of:preview",
        "of:result",
      ]),
    );
  });

  it("supports direct bindings without a handler observation", () => {
    const selected = selectViewData(
      [
        node("render", ["input"], ["ui"]),
      ],
      [address("ui")],
      [address("input")],
      new Set(),
    );
    expect(selected.actions).toEqual(["render"]);
  });

  it("excludes computations that affect rendering only through a server boundary", () => {
    const selected = selectViewData(
      [
        node("request", ["input"], ["request"]),
        node("fetch", ["request"], ["result"], "boundary"),
        node("render", ["result"], ["ui"]),
      ],
      [address("ui")],
      [address("input")],
      new Set(),
    );
    expect(selected.actions).toEqual([]);
    expect(selected.reads).toEqual([address("ui")]);
  });

  it("does not select deep sibling writers as ancestors of shallow reads", () => {
    const visible = node("visible", ["trigger"], ["ui"]);
    visible.log.shallowReads = [address("container")];
    const hidden = node("hidden", ["trigger", "hidden-input"], []);
    hidden.writes = [address("container", ["item", "deep"])];
    hidden.log.writes = hidden.writes;
    const selected = selectViewData([visible, hidden], [address("ui")], [
      address("trigger"),
    ], new Set());
    expect(selected.actions).toEqual(["visible"]);
    expect(selected.reads.map((read) => read.id)).not.toContain(
      "of:hidden-input",
    );
    const rendererOnly = selectViewData(
      [hidden],
      [],
      [address("trigger")],
      new Set(),
      [address("container")],
    );
    expect(rendererOnly.actions).toEqual([]);
  });

  it("terminates cyclic cones and keeps deep writes out of shallow-read edges", () => {
    const shallow = node("shallow", [], ["ui"]);
    shallow.log.shallowReads = [address("input")];
    const selected = selectViewData(
      [
        shallow,
        node("a", ["b"], ["a"]),
        node("b", ["a"], ["b"]),
      ],
      [address("ui"), address("b")],
      [address("input", ["item", "deep"]), address("a")],
      new Set(),
    );
    expect(selected.actions.toSorted()).toEqual(["a", "b"]);
  });
});
