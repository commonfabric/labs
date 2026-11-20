import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { deepLabel, deepLabelAlong, type StoredReader } from "../deep-label.ts";
import type { Label } from "../template.ts";

type Address = { id: string; path: readonly string[] };

/**
 * A reader over documents held as plain values, where `{ to: [id, ...path] }`
 * is a link and each document has a label per path.
 */
const readerOf = (
  documents: Record<string, unknown>,
  labels: Record<string, Record<string, Label>>,
): StoredReader<Address> => ({
  value: ({ id, path }) => {
    let value = documents[id];
    for (const segment of path) {
      value = (value as Record<string, unknown>)?.[segment];
    }
    return value;
  },
  label: ({ id, path }) =>
    labels[id]?.[path.join("/")] ?? { confidentiality: [], integrity: [] },
  link: (value) => {
    const to = (value as { to?: string[] } | null)?.to;
    return Array.isArray(to) ? { id: to[0], path: to.slice(1) } : undefined;
  },
  path: ({ path }) => path,
  withPath: ({ id }, path) => ({ id, path }),
  key: ({ id, path }) => JSON.stringify([id, path]),
});

const sorted = (label: Label): Label => ({
  confidentiality: [...label.confidentiality].sort(),
  integrity: [...label.integrity].sort(),
});

describe("deepLabel", () => {
  it("gives a value held in place and the same value held behind links one label", () => {
    // The compiled document holds the view in place; today's holds a link
    // at the view and another at its child.
    const inPlace = readerOf(
      { result: { ui: { children: [{ text: "a" }] } } },
      {
        result: {
          "ui": { confidentiality: ["view"], integrity: ["P"] },
          "ui/children/0": { confidentiality: ["child"], integrity: ["P"] },
        },
      },
    );
    const behindLinks = readerOf(
      {
        result: { ui: { to: ["view"] } },
        view: { children: [{ to: ["child"] }] },
        child: { text: "a" },
      },
      {
        view: { "": { confidentiality: ["view"], integrity: ["P"] } },
        child: { "": { confidentiality: ["child"], integrity: ["P"] } },
      },
    );
    const at = { id: "result", path: ["ui"] };
    expect(sorted(deepLabel(inPlace, at))).toEqual({
      confidentiality: ["child", "view"],
      integrity: ["P"],
    });
    expect(sorted(deepLabel(behindLinks, at))).toEqual(
      sorted(deepLabel(inPlace, at)),
    );
  });

  it("does not read a position outside the value at the address", () => {
    const reader = readerOf(
      { result: { a: 1, b: 2 } },
      {
        result: {
          "a": { confidentiality: ["a"], integrity: [] },
          "b": { confidentiality: ["b"], integrity: [] },
        },
      },
    );
    expect(deepLabel(reader, { id: "result", path: ["a"] })).toEqual({
      confidentiality: ["a"],
      integrity: [],
    });
  });

  it("reads each position of a cycle of links once", () => {
    const reader = readerOf(
      { a: { next: { to: ["b"] } }, b: { next: { to: ["a"] } } },
      {
        a: { "": { confidentiality: ["a"], integrity: [] } },
        b: { "": { confidentiality: ["b"], integrity: [] } },
      },
    );
    expect(sorted(deepLabel(reader, { id: "a", path: [] }))).toEqual({
      confidentiality: ["a", "b"],
      integrity: [],
    });
  });
});

describe("deepLabelAlong", () => {
  it("follows a link on the way to the address, with the label at the link", () => {
    const reader = readerOf(
      {
        result: { ui: { to: ["view"] } },
        view: { children: [{ text: "a" }, { text: "b" }] },
      },
      {
        result: { "ui": { confidentiality: ["link"], integrity: [] } },
        view: {
          "children/0": { confidentiality: ["first"], integrity: [] },
          "children/1": { confidentiality: ["second"], integrity: [] },
        },
      },
    );
    expect(
      sorted(deepLabelAlong(reader, {
        id: "result",
        path: ["ui", "children", "0"],
      })),
    ).toEqual({ confidentiality: ["first", "link"], integrity: [] });
  });
});
