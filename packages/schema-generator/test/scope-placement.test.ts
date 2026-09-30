import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { MutableJSONSchema, SchemaScope } from "@commonfabric/api";
import { assertScopeDeclarationsAreReachable } from "../src/scope-placement.ts";

/** A slot holding `branch` beside `null`, declaring `scope` at its top. */
const beside = (
  branch: MutableJSONSchema,
  scope?: SchemaScope,
): MutableJSONSchema => ({
  anyOf: [{ type: "null" }, branch],
  ...(scope === undefined ? {} : { scope }),
});

describe("scope-placement", () => {
  it("accepts a cell's cap in a branch that names the slot's scope", () => {
    expect(() =>
      assertScopeDeclarationsAreReachable(
        beside(
          { type: "string", asCell: [{ kind: "cell", scope: "user" }] },
          "user",
        ),
      )
    ).not.toThrow();
  });

  it("accepts the scope of a value inside a capped cell in a branch", () => {
    expect(() =>
      assertScopeDeclarationsAreReachable(
        beside(
          {
            type: "string",
            asCell: [{ kind: "cell", scope: "user" }],
            scope: "session",
          },
          "user",
        ),
      )
    ).not.toThrow();
  });

  it("throws for a cell's cap in a branch that names another scope than the slot's", () => {
    expect(() =>
      assertScopeDeclarationsAreReachable(
        beside(
          { type: "string", asCell: [{ kind: "cell", scope: "session" }] },
          "user",
        ),
      )
    ).toThrow("A scope wrapper cannot be a member of a union.");
  });

  it("throws for a cell's cap in a branch of a slot that declares no scope", () => {
    expect(() =>
      assertScopeDeclarationsAreReachable(
        beside({ type: "string", asCell: [{ kind: "cell", scope: "user" }] }),
      )
    ).toThrow("A scope wrapper cannot be a member of a union.");
  });

  it("throws for a scope beside an uncapped cell entry in a branch, whatever the slot's scope", () => {
    // Beside a string entry, the `scope` is read as the branch's own.
    expect(() =>
      assertScopeDeclarationsAreReachable(
        beside({ type: "string", asCell: ["cell"], scope: "user" }, "user"),
      )
    ).toThrow("A scope wrapper cannot be a member of a union.");
  });

  it("throws for a value's scope in a branch", () => {
    expect(() =>
      assertScopeDeclarationsAreReachable(
        beside({ type: "string", scope: "user" }, "user"),
      )
    ).toThrow("A scope wrapper cannot be a member of a union.");
  });
});
