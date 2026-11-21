import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { createSigilLinkFromParsedLink } from "../../../../runtime/runner/src/link-utils.ts";
import { Runtime } from "../../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../../runtime/runner/src/storage/cache.deno.ts";
import type { URI } from "../../../../runtime/runner/src/sigil-types.ts";
import {
  deepLabel,
  deepLabelAlong,
  type StoredReader,
  storedReader,
} from "../deep-label.ts";
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

describe("deepLabel through a link whose path crosses a link", () => {
  it("follows the links on the way to the position a link in the value names, with the label at each", () => {
    // The view holds a link to `element/note` of a document whose
    // `element` is itself a link to the record: the value the link names
    // is the record's note.
    const reader = readerOf(
      {
        view: { text: { to: ["frame", "element", "note"] } },
        frame: { element: { to: ["record"] } },
        record: { note: "n" },
      },
      {
        frame: { "element": { confidentiality: ["frame"], integrity: [] } },
        record: { "note": { confidentiality: ["note"], integrity: [] } },
      },
    );
    expect(sorted(deepLabel(reader, { id: "view", path: [] }))).toEqual({
      confidentiality: ["frame", "note"],
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

describe("storedReader", () => {
  /** What `link()` of the reader gives for a stored link to `scope`. */
  const followed = async (scope: "space" | "user" | undefined) => {
    const signer = await Identity.fromPassphrase("deep-label stored reader");
    const space = signer.did();
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    try {
      return storedReader(tx).link(
        createSigilLinkFromParsedLink({
          space,
          id: "of:target" as URI,
          path: ["inner"],
          ...(scope === undefined ? {} : { scope }),
        }),
        { space, id: "of:holder", scope: "space", path: [] },
      );
    } finally {
      tx.abort();
      await runtime.dispose();
      await storageManager.close();
    }
  };

  it("follows a link to a document of a user in the scope of the user", async () => {
    expect(await followed("user")).toMatchObject({
      id: "of:target",
      scope: "user",
      path: ["inner"],
    });
  });

  it("follows a link that names no scope in the scope of the space", async () => {
    expect(await followed(undefined)).toMatchObject({
      id: "of:target",
      scope: "space",
      path: ["inner"],
    });
  });
});
