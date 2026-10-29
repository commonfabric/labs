// The UI helpers a pattern reaches through the `commonfabric` builder surface.
// A pattern calls them by name, so what matters is the node shape they hand
// back through that surface rather than through a direct module import.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { createBuilder } from "../src/builder/factory.ts";

describe("ui-helper-runtime", () => {
  describe("UiAction()", () => {
    it("returns a `ct-button` node carrying the action as a data attribute", () => {
      const { commonfabric } = createBuilder();

      expect(
        commonfabric.UiAction({
          action: "SubmitDirectCommand",
          children: "Go",
        }),
      ).toEqual({
        type: "vnode",
        name: "ct-button",
        props: { "data-ui-action": "SubmitDirectCommand" },
        children: ["Go"],
      });
    });

    it("returns the tag named by `as` in place of `ct-button`", () => {
      const { commonfabric } = createBuilder();

      expect(
        commonfabric.UiAction({ as: "ct-link", action: "OpenPiece" }),
      ).toEqual({
        type: "vnode",
        name: "ct-link",
        props: { "data-ui-action": "OpenPiece" },
        children: [],
      });
    });
  });

  describe("UiPromptSlot()", () => {
    it("returns a `ct-textarea` node carrying the surface and role as data attributes", () => {
      const { commonfabric } = createBuilder();

      expect(
        commonfabric.UiPromptSlot({
          surface: "PromptPane",
          role: "assistant",
        }),
      ).toEqual({
        type: "vnode",
        name: "ct-textarea",
        props: {
          "data-ui-surface": "PromptPane",
          "data-ui-role": "assistant",
        },
        children: [],
      });
    });
  });

  describe("UiDisclosure()", () => {
    it("returns a `ct-card` node carrying the kind as a data attribute", () => {
      const { commonfabric } = createBuilder();

      expect(
        commonfabric.UiDisclosure({ kind: "warning", children: "Heads up" }),
      ).toEqual({
        type: "vnode",
        name: "ct-card",
        props: { "data-ui-disclosure-kind": "warning" },
        children: ["Heads up"],
      });
    });
  });

  describe("h()", () => {
    it("returns a vnode for an intrinsic element", () => {
      const { commonfabric } = createBuilder();

      expect(commonfabric.h("div", { id: "root" }, "text")).toEqual({
        type: "vnode",
        name: "div",
        props: { id: "root" },
        children: ["text"],
      });
    });
  });
});
