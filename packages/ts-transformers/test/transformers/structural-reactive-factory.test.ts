import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { StaticCache } from "@commonfabric/static";

import { validateSource } from "../utils.ts";

const commonfabricTypes = await StaticCache.fromFileSystem().getText(
  "types/commonfabric.d.ts",
);
const identity =
  `function identity(v: WishState<string>): WishState<string> { return v; }`;
const factory =
  `function make(): WishState<string> { return wish<string>({ query: "#inner" }); }`;

describe("structural-reactive-factory", () => {
  for (
    const [name, helper, call] of [
      ["identity getter", identity, "identity(request)"],
      [
        "constant arrow getter",
        "const identity = (v: WishState<string>): WishState<string> => v;",
        "identity(request)",
      ],
      [
        "callable getter alias",
        `${identity} const alias = identity;`,
        "alias(request)",
      ],
      [
        "delegated getter",
        `${identity} function get(v: WishState<string>): WishState<string> { return identity(v); }`,
        "get(request)",
      ],
    ]
  ) {
    it(`allows a stored Wish read via ${name}`, async () => {
      const { diagnostics } = await validateSource(
        `
        import { pattern, computed, wish, type WishState } from "commonfabric";
        ${helper}
        export default pattern(() => {
          const request = wish<string>({ query: "#outer" });
          return { value: computed(() => ${call}.result) };
        });
      `,
        { types: { "commonfabric.d.ts": commonfabricTypes } },
      );
      expect(
        diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      )
        .toEqual([]);
    });
  }

  for (
    const [name, helper, call] of [
      ["direct factory wrapper", factory, "make()"],
      ["callable factory alias", `${factory} const alias = make;`, "alias()"],
      [
        "conditional factory return",
        `function make(v: WishState<string>): WishState<string> { return true ? wish<string>({ query: "#inner" }) : v; }`,
        "make(request)",
      ],
      [
        "opaque external helper",
        `import { lookup } from "opaque-helper";`,
        "lookup()",
      ],
      [
        "opaque external alias",
        `import { lookup } from "opaque-helper"; const alias = lookup;`,
        "alias()",
      ],
      [
        "factory evaluated as a getter argument",
        `${identity} function make(): WishState<string> { return identity(wish<string>({ query: "#inner" })); }`,
        "make()",
      ],
      [
        "uninspectable multi-statement helper",
        `function get(v: WishState<string>): WishState<string> { const copy = v; return copy; }`,
        "get(request)",
      ],
      [
        "factory in a default parameter",
        `function make(v: WishState<string> = wish<string>({ query: "#inner" })): WishState<string> { return v; }`,
        "make()",
      ],
      [
        "property getter with unproven accessor provenance",
        `function get(v: { request: WishState<string> }): WishState<string> { return v.request; }`,
        "get({ request })",
      ],
      [
        "factory hidden in an argument accessor",
        `function get(v: { request: WishState<string> }): WishState<string> { return v.request; }
        const box = { get request() { return wish<string>({ query: "#inner" }); } };`,
        "get(box)",
      ],
      [
        "factory in a destructured default",
        `function get({ v = wish<string>({ query: "#inner" }) }: { v?: WishState<string> }): WishState<string> { return v; }`,
        "get({})",
      ],
      [
        "accessor evaluated by parameter destructuring",
        `function get({ request }: { request: WishState<string> }): WishState<string> { return request; }
        const box = { get request() { return wish<string>({ query: "#inner" }); } };`,
        "get(box)",
      ],
      [
        "reassigned callable alias",
        `${identity} ${factory} let alias = identity; alias = make;`,
        "alias(request)",
      ],
      [
        "reassigned function declaration",
        `${identity} ${factory} identity = make;`,
        "identity(request)",
      ],
      [
        "object spread evaluated in an unused argument",
        `function get(v: WishState<string>, extra: unknown): WishState<string> { return v; }
        const box = { get request() { return wish<string>({ query: "#inner" }); } };`,
        "get(request, { ...box })",
      ],
      [
        "array spread evaluated in an unused argument",
        `function get(v: WishState<string>, extra: unknown): WishState<string> { return v; }
        const source = { *[Symbol.iterator]() { yield wish<string>({ query: "#inner" }); } };`,
        "get(request, [...source])",
      ],
      [
        "cyclic delegation",
        `function first(v: WishState<string>): WishState<string> { return second(v); }
        function second(v: WishState<string>): WishState<string> { return first(v); }`,
        "first(request)",
      ],
    ]
  ) {
    it(`reports factory placement for ${name} inside a compute`, async () => {
      const { diagnostics } = await validateSource(
        `
        import { pattern, computed, wish, type WishState } from "commonfabric";
        ${helper}
        export default pattern(() => {
          const request = wish<string>({ query: "#outer" });
          return { value: computed(() => ${call}.result) };
        });
      `,
        {
          types: {
            "commonfabric.d.ts": commonfabricTypes,
            "opaque-helper.d.ts": `declare module "opaque-helper" {
            import type { WishState } from "commonfabric";
            export function lookup(): WishState<string>;
          }`,
          },
        },
      );
      expect(
        diagnostics.filter((diagnostic) => diagnostic.severity === "error")
          .map((diagnostic) => diagnostic.type),
      )
        .toEqual(["compute-context:local-reactive-use"]);
    });
  }
});
