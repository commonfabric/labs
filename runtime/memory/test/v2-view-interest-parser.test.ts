import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { parseViewInterests, parseViewQuery } from "../v2/view-interest.ts";

const query = { roots: [{ id: "of:visible", selector: { path: [] } }] };
const view = {
  id: "screen",
  revision: 0,
  mode: "render",
  componentContractVersion: "1",
  query,
};

describe("view interest parsing", () => {
  it("distinguishes omitted ownership from removing every view", () => {
    expect(parseViewInterests(undefined)).toBeUndefined();
    expect(parseViewInterests([])).toEqual([]);
    expect(parseViewInterests({})).toBeNull();
  });

  const invalidViews = [
    ["non-object", null],
    ["empty id", { ...view, id: "" }],
    ["non-string id", { ...view, id: 1 }],
    ["negative revision", { ...view, revision: -1 }],
    ["fractional revision", { ...view, revision: 0.5 }],
    ["unsafe revision", { ...view, revision: Number.MAX_SAFE_INTEGER + 1 }],
    ["unknown mode", { ...view, mode: "background" }],
    ["missing contract version", {
      ...view,
      componentContractVersion: undefined,
    }],
    ["invalid query", { ...view, query: null }],
  ] as const;
  for (const [name, invalid] of invalidViews) {
    it(`refuses a view with ${name}`, () => {
      expect(parseViewInterests([invalid])).toBeNull();
    });
  }

  it("refuses duplicate ownership ids", () => {
    expect(parseViewInterests([view, { ...view, revision: 1 }])).toBeNull();
  });

  const invalidQueries = [
    ["non-object", null],
    ["missing roots", {}],
    ["historical sequence", { ...query, atSeq: 1 }],
    ["excluded delivery", { ...query, excludeSent: true }],
    ["non-default branch", { ...query, branch: "other" }],
    ["non-object root", { roots: [null] }],
    ["empty root id", { roots: [{ id: "", selector: { path: [] } }] }],
    ["foreign instance", {
      roots: [{ ...query.roots[0], entityScopeKey: "user:other" }],
    }],
    ["unknown scope", { roots: [{ ...query.roots[0], scope: "other" }] }],
    ["non-string path", {
      roots: [{ id: "of:visible", selector: { path: [1] } }],
    }],
    ["string schema", {
      roots: [{ id: "of:visible", selector: { path: [], schema: "string" } }],
    }],
  ] as const;
  for (const [name, invalid] of invalidQueries) {
    it(`refuses a query with ${name}`, () => {
      expect(parseViewQuery(invalid)).toBeNull();
    });
  }

  it("retains each supported scope and schema without sharing caller-owned data", () => {
    for (const scope of ["space", "user", "session"]) {
      for (const schema of [undefined, false, true, { type: "string" }]) {
        const input = [{
          ...view,
          query: {
            roots: [{
              id: "of:visible",
              scope,
              selector: { path: ["value"], schema },
            }],
          },
        }];
        const result = parseViewInterests(input);
        expect(result).toEqual(input);
        input[0].query.roots[0].selector.path.push("changed");
        expect(result?.[0].query.roots[0].selector.path).toEqual(["value"]);
      }
    }
  });
});
