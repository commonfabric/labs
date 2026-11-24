/**
 * Tests for the JSX automatic runtime, which backs TypeScript's
 * `"jsx": "react-jsx"` configuration.
 *
 * The functions are imported directly rather than exercised through a JSX
 * expression, so that each argument the automatic runtime passes — the key,
 * the static-children flag — can be supplied explicitly.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Fragment, jsx, jsxs } from "../src/jsx-runtime.ts";

describe("jsx-runtime", () => {
  describe("jsx()", () => {
    it("returns a vnode for an element with no children", () => {
      expect(jsx("div", { className: "test" })).toMatchObject({
        type: "vnode",
        name: "div",
        props: { className: "test" },
        children: [],
      });
    });

    it("returns a vnode whose children come from the `children` prop", () => {
      expect(jsx("div", { children: [jsx("p", { children: "Hello" })] }))
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

    it("wraps a single non-array child in a one-element children array", () => {
      expect(jsx("div", { children: "Hello" })).toMatchObject({
        type: "vnode",
        name: "div",
        children: ["Hello"],
      });
    });

    it("returns a vnode with empty props given null props", () => {
      expect(jsx("div", null)).toMatchObject({
        type: "vnode",
        name: "div",
        props: {},
        children: [],
      });
    });

    it("ignores the key argument", () => {
      expect(jsx("li", { children: "Item 1" }, "item-1")).toMatchObject({
        type: "vnode",
        name: "li",
        children: ["Item 1"],
      });
    });

    it("returns what a component function returns", () => {
      const MyComponent = ({ name }: { name: string }) =>
        jsx("div", { children: `Hello, ${name}` });

      expect(jsx(MyComponent, { name: "World" })).toMatchObject({
        type: "vnode",
        name: "div",
        children: ["Hello, World"],
      });
    });

    it("returns a vnode tree for a nested structure", () => {
      expect(jsx("div", {
        className: "container",
        children: [
          jsx("h1", { children: "Title" }),
          jsx("p", { children: "Description" }),
          jsx("ul", {
            children: [
              jsx("li", { children: "Item 1" }),
              jsx("li", { children: "Item 2" }),
            ],
          }),
        ],
      })).toMatchObject({
        type: "vnode",
        name: "div",
        props: { className: "container" },
        children: [
          {
            type: "vnode",
            name: "h1",
            children: ["Title"],
          },
          {
            type: "vnode",
            name: "p",
            children: ["Description"],
          },
          {
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
          },
        ],
      });
    });
  });

  describe("jsxs()", () => {
    it("is the same function as `jsx()`", () => {
      expect(jsxs).toBe(jsx);
    });

    it("returns a vnode carrying each of the static children", () => {
      expect(jsxs("ul", {
        children: [
          jsx("li", { children: "Item 1" }),
          jsx("li", { children: "Item 2" }),
        ],
      })).toMatchObject({
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
          jsx("p", { children: "Paragraph 1" }),
          jsx("p", { children: "Paragraph 2" }),
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
