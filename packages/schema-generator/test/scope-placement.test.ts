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

  it("accepts a cap inside a capped cell's value that names that value's scope", () => {
    // The branch's own `anyOf` holds the alternatives of the value inside its
    // cell, a slot whose scope is declared beside the cell's entry.
    expect(() =>
      assertScopeDeclarationsAreReachable(
        beside(
          {
            anyOf: [
              { type: "null" },
              { type: "string", asCell: [{ kind: "cell", scope: "session" }] },
            ],
            asCell: [{ kind: "cell", scope: "user" }],
            scope: "session",
          },
          "user",
        ),
      )
    ).not.toThrow();
  });

  it("throws for a cap inside a capped cell's value that names another scope than that value's", () => {
    expect(() =>
      assertScopeDeclarationsAreReachable(
        beside(
          {
            anyOf: [
              { type: "null" },
              { type: "string", asCell: [{ kind: "cell", scope: "user" }] },
            ],
            asCell: [{ kind: "cell", scope: "user" }],
            scope: "session",
          },
          "user",
        ),
      )
    ).toThrow("A scope wrapper cannot be a member of a union.");
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

  it("accepts a cell's cap in a `oneOf` branch that names the slot's scope", () => {
    expect(() =>
      assertScopeDeclarationsAreReachable({
        oneOf: [
          { type: "null" },
          { type: "string", asCell: [{ kind: "cell", scope: "user" }] },
        ],
        scope: "user",
      })
    ).not.toThrow();
  });

  it("throws for a cell's cap in an `allOf` branch, though it names the slot's scope", () => {
    // The runtime reads a handle's follow cap through `anyOf` and `oneOf`
    // branches, and through no `allOf`.
    expect(() =>
      assertScopeDeclarationsAreReachable({
        allOf: [
          { type: "string", asCell: [{ kind: "cell", scope: "user" }] },
        ],
        scope: "user",
      })
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
