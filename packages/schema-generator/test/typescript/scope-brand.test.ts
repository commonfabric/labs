import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { getScopeBrand } from "../../src/typescript/scope-brand.ts";
import { getTypeFromCode, getTypeFromFiles } from "../utils.ts";

describe("scope-brand", () => {
  /** The brand `getScopeBrand` reads on the type `Subject` in `code`. */
  async function brandOf(code: string) {
    const { type, checker } = await getTypeFromCode(code, "Subject");
    const brand = getScopeBrand(type, checker);
    return brand && {
      scope: brand.scope,
      payload: brand.payload.map((alternative) =>
        alternative.map((part) => checker.typeToString(part))
      ),
    };
  }

  it("returns the scope and payload of a scope wrapper", async () => {
    expect(
      await brandOf(`
type Inner = { a: string };
type Subject = PerSession<Inner>;
`),
    ).toEqual({ scope: "session", payload: [["Inner"]] });
  });

  it("returns the scope of a scope wrapper reached through an alias", async () => {
    expect(
      await brandOf(`
type Inner = { a: string };
type Rec = PerUser<Inner>;
type Subject = Rec;
`),
    ).toEqual({ scope: "user", payload: [["Inner"]] });
  });

  it("returns every member of an intersection payload", async () => {
    expect(
      await brandOf(`
type A = { a: string };
type B = { b: number };
type Subject = PerSpace<A & B>;
`),
    ).toEqual({ scope: "space", payload: [["A", "B"]] });
  });

  it("returns the scope of a brand keyed by an imported `SCOPE_BRAND`", async () => {
    const { type, checker } = await getTypeFromFiles(
      {
        "/api/commonfabric.d.ts":
          "export declare const SCOPE_BRAND: unique symbol;",
        "/main.ts": 'import { SCOPE_BRAND } from "./api/commonfabric";\n' +
          'type Subject = { a: string } & { readonly [SCOPE_BRAND]?: "user" };',
      },
      "/main.ts",
      "Subject",
    );

    expect(getScopeBrand(type, checker)?.scope).toBe("user");
  });

  it("returns `undefined` for a type that carries no scope brand", async () => {
    expect(await brandOf(`type Subject = { a: string } & { b: number };`))
      .toBeUndefined();
  });

  it("returns each alternative of a scope wrapper around a union", async () => {
    // The checker distributes the brand over the union's members.

    expect(
      await brandOf(`
type A = { a: string };
type B = { b: number };
type Subject = PerAny<A | B>;
`),
    ).toEqual({ scope: "any", payload: [["A"], ["B"]] });
  });

  it("returns `undefined` for a union with an unbranded member", async () => {
    expect(await brandOf(`type Subject = PerUser<{ a: string }> | number;`))
      .toBeUndefined();
  });

  it("returns `undefined` for a union of members with different scopes", async () => {
    expect(
      await brandOf(
        `type Subject = PerUser<{ a: string }> | PerSession<{ b: number }>;`,
      ),
    ).toBeUndefined();
  });

  it("returns `undefined` for two different scopes intersected", async () => {
    expect(
      await brandOf(`type Subject = PerUser<{ a: string }> & PerSession<{}>;`),
    ).toBeUndefined();
  });

  it("returns `undefined` for a brand keyed by a symbol of the author's own", async () => {
    expect(
      await brandOf(`
declare const OWN_BRAND: unique symbol;
type Subject = { a: string } & { readonly [OWN_BRAND]?: "user" };
`),
    ).toBeUndefined();
  });

  it("returns `undefined` for a brand keyed by an author's own `SCOPE_BRAND`", async () => {
    const { type, checker } = await getTypeFromFiles(
      {
        "/brands.ts": "export declare const SCOPE_BRAND: unique symbol;",
        "/main.ts": 'import { SCOPE_BRAND } from "./brands.ts";\n' +
          'type Subject = { a: string } & { readonly [SCOPE_BRAND]?: "user" };',
      },
      "/main.ts",
      "Subject",
    );

    expect(getScopeBrand(type, checker)).toBeUndefined();
  });

  it("returns `undefined` for a brand whose scope is not a string literal", async () => {
    expect(
      await brandOf(
        `type Subject = { a: string } & { readonly [SCOPE_BRAND]?: string };`,
      ),
    ).toBeUndefined();
  });

  it("returns `undefined` for a brand naming no scope", async () => {
    expect(
      await brandOf(
        `type Subject = { a: string } & { readonly [SCOPE_BRAND]?: "team" };`,
      ),
    ).toBeUndefined();
  });
});
