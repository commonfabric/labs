/**
 * Tests for the JSX development runtime, which backs TypeScript's
 * `"jsx": "react-jsxdev"` configuration.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Fragment, jsxDEV } from "../src/jsx-dev-runtime.ts";

describe("jsx-dev-runtime", () => {
  describe("jsxDEV()", () => {
    it("returns a vnode for an element with no children", () => {
      expect(jsxDEV("div", { className: "test" })).toMatchObject({
        type: "vnode",
        name: "div",
        props: { className: "test" },
        children: [],
      });
    });

    it("returns a vnode whose children come from the `children` prop", () => {
      expect(jsxDEV("div", { children: [jsxDEV("p", { children: "Hello" })] }))
        .toMatchObject({
          type: "vnode",
          name: "div",
          children: [
            {
              type: "vnode",
              name: "p",
              children: ["Hello"],
            },
          ],
        });
    });

    it("ignores the key, static-children, source and self arguments", () => {
      expect(jsxDEV(
        "div",
        { children: "Test" },
        "test-key",
        false,
        {
          fileName: "test.tsx",
          lineNumber: 42,
          columnNumber: 10,
        },
        undefined,
      )).toMatchObject({
        type: "vnode",
        name: "div",
        children: ["Test"],
      });
    });

    it("returns a vnode with empty props given null props", () => {
      expect(jsxDEV("div", null)).toMatchObject({
        type: "vnode",
        name: "div",
        props: {},
        children: [],
      });
    });

    it("returns what a component function returns", () => {
      const MyComponent = ({ name }: { name: string }) =>
        jsxDEV("div", { children: `Hello, ${name}` });

      expect(jsxDEV(MyComponent, { name: "World" })).toMatchObject({
        type: "vnode",
        name: "div",
        children: ["Hello, World"],
      });
    });

    it("returns a vnode carrying each child when told they are static", () => {
      expect(jsxDEV(
        "ul",
        {
          children: [
            jsxDEV("li", { children: "Item 1" }),
            jsxDEV("li", { children: "Item 2" }),
          ],
        },
        undefined,
        true,
      )).toMatchObject({
        type: "vnode",
        name: "ul",
        children: [
          {
            type: "vnode",
            name: "li",
            children: ["Item 1"],
          },
          {
            type: "vnode",
            name: "li",
            children: ["Item 2"],
          },
        ],
      });
    });
  });

  describe("Fragment", () => {
    it("returns a `cf-fragment` vnode wrapping its children", () => {
      expect(Fragment({
        children: [
          jsxDEV("p", { children: "Paragraph 1" }),
          jsxDEV("p", { children: "Paragraph 2" }),
        ],
      })).toMatchObject({
        type: "vnode",
        name: "cf-fragment",
        children: [
          {
            type: "vnode",
            name: "p",
            children: ["Paragraph 1"],
          },
          {
            type: "vnode",
            name: "p",
            children: ["Paragraph 2"],
          },
        ],
      });
    });
  });
});
