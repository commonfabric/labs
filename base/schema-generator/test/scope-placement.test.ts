import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { MutableJSONSchema } from "@commonfabric/api";
import {
  assertScopeDeclarationsAreReachable,
  memberScopeWithin,
} from "../src/scope-placement.ts";

/** A slot holding `branch` beside `null`, declaring the user scope at its top. */
const beside = (branch: MutableJSONSchema): MutableJSONSchema => ({
  anyOf: [{ type: "null" }, branch],
  scope: "user",
});

describe("scope-placement", () => {
  it("accepts a scope at the slot's top level beside branches that declare none", () => {
    expect(() =>
      assertScopeDeclarationsAreReachable(beside({ type: "string" }))
    ).not.toThrow();
  });

  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    it(`throws for a cell's cap in an \`${keyword}\` branch, though it names the slot's scope`, () => {
      expect(() =>
        assertScopeDeclarationsAreReachable({
          [keyword]: [
            { type: "null" },
            { type: "string", asCell: [{ kind: "cell", scope: "user" }] },
          ],
          scope: "user",
        })
      ).toThrow("A scope wrapper cannot be a member of a union.");
    });
  }

  it("throws for a scope beside an uncapped cell entry in a branch", () => {
    // Beside a string entry, the `scope` is read as the branch's own.
    expect(() =>
      assertScopeDeclarationsAreReachable(
        beside({ type: "string", asCell: ["cell"], scope: "user" }),
      )
    ).toThrow("A scope wrapper cannot be a member of a union.");
  });

  it("throws for a value's scope in a branch", () => {
    expect(() =>
      assertScopeDeclarationsAreReachable(
        beside({ type: "string", scope: "user" }),
      )
    ).toThrow("A scope wrapper cannot be a member of a union.");
  });

  describe("memberScopeWithin", () => {
    it("returns `undefined` for a scope at a schema's own top level", () => {
      // That scope is the whole value's, which the caller keeps.

      expect(memberScopeWithin([{
        type: "object",
        properties: { x: { type: "string" } },
        scope: "user",
      }], {})).toBeUndefined();
    });

    it("returns a nested member's scope beside the whole value's, with its path", () => {
      expect(memberScopeWithin([{
        properties: {
          a: { properties: { x: { type: "string", scope: "session" } } },
        },
        scope: "user",
      }], {})).toEqual({ scope: "session", member: "a.x" });
    });

    it("returns a definition's own scope where a member reaches it after the value itself did", () => {
      // The scope is the whole value's where the first schema reaches the
      // definition, and a member's where the second does.

      expect(memberScopeWithin([
        { $ref: "#/$defs/U" },
        { properties: { u: { $ref: "#/$defs/U" } } },
      ], { U: { type: "object", scope: "user" } })).toEqual({
        scope: "user",
        member: "u",
      });
    });
  });
});
