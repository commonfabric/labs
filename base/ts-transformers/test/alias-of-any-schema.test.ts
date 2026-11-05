import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { parseModule, patternSchemas } from "./transformed-ast.ts";
import { transformFiles } from "./utils.ts";

/**
 * The input schema of the pattern `/main.tsx` declares, and the diagnostics
 * transforming it reports, `files` type-checked beside it.
 */
const patternInputOf = async (
  main: string,
  files: Record<string, string> = {},
): Promise<{
  input: Record<string, unknown>;
  diagnostics: TransformationDiagnostic[];
}> => {
  const diagnostics: TransformationDiagnostic[] = [];
  const output = await transformFiles({ ...files, "/main.tsx": main }, {
    types: COMMONFABRIC_TYPES,
    typeCheck: true,
    pipelineDiagnostics: diagnostics,
  });
  return {
    input: patternSchemas(parseModule(output["/main.tsx"]!)).input,
    diagnostics,
  };
};

/** The schema `input` gives its property `a`. */
const propertyA = (input: Record<string, unknown>): unknown =>
  (input.properties as Record<string, unknown> | undefined)?.a;

describe("alias-of-any-schema", () => {
  for (
    const [written, declarations, value, expected] of [
      [
        "a CFC alias",
        `type Secret = Confidential<any, ["secret"]>;`,
        "Secret",
        { ifc: { confidentiality: ["secret"] } },
      ],
      [
        "a generic alias taking the label",
        `type Labeled<C extends readonly unknown[]> = Confidential<any, C>;`,
        `Labeled<["secret"]>`,
        { ifc: { confidentiality: ["secret"] } },
      ],
      [
        "a nested CFC alias",
        `type Both = Integrity<Confidential<any, ["secret"]>, ["verified"]>;`,
        "Both",
        { ifc: { confidentiality: ["secret"], integrity: ["verified"] } },
      ],
      [
        "a nested CFC alias written in place",
        "",
        `Integrity<Confidential<any, ["secret"]>, ["verified"]>`,
        { ifc: { confidentiality: ["secret"], integrity: ["verified"] } },
      ],
      [
        "a CFC alias nested in itself written in place",
        "",
        `Confidential<Confidential<any, ["a"]>, ["b"]>`,
        { ifc: { confidentiality: ["a", "b"] } },
      ],
      [
        "a scope wrapper",
        `type Mine = PerUser<any>;`,
        "Mine",
        { scope: "user" },
      ],
      [
        "a record's value",
        `type Secret = Confidential<any, ["secret"]>;`,
        "Record<string, Secret>",
        {
          type: "object",
          properties: {},
          additionalProperties: { ifc: { confidentiality: ["secret"] } },
        },
      ],
      [
        "the operand of `Partial`",
        `type Secret = Confidential<any, ["secret"]>;`,
        "Partial<Secret>",
        {
          type: "object",
          properties: {},
          additionalProperties: true,
          ifc: { confidentiality: ["secret"] },
        },
      ],
      [
        "the operand of `Readonly`",
        `type Secret = Confidential<any, ["secret"]>;`,
        "Readonly<Secret>",
        {
          type: "object",
          properties: {},
          additionalProperties: true,
          ifc: { confidentiality: ["secret"] },
        },
      ],
      [
        "a record's value on a named key union",
        `type Secret = Confidential<any, ["secret"]>; type Keys = "x" | "y";`,
        "Record<Keys, Secret>",
        {
          type: "object",
          properties: {
            x: { ifc: { confidentiality: ["secret"] } },
            y: { ifc: { confidentiality: ["secret"] } },
          },
          required: ["x", "y"],
        },
      ],
      [
        "a tuple's element",
        `type Secret = Confidential<any, ["secret"]>;`,
        "[string, Secret]",
        {
          type: "array",
          items: {
            anyOf: [
              { type: "string" },
              { ifc: { confidentiality: ["secret"] } },
            ],
          },
        },
      ],
    ] as const
  ) {
    it(`keeps what ${written} wraps around \`any\` in a pattern's input`, async () => {
      const { input, diagnostics } = await patternInputOf(`
        import { pattern } from "commonfabric";
        import type { Confidential, Integrity, PerUser } from "commonfabric";
        ${declarations}
        export default pattern<{ a: ${value} }>(() => ({}));
      `);

      expect(propertyA(input)).toEqual(expected);
      expect(diagnostics.filter(({ severity }) => severity === "error"))
        .toEqual([]);
    });
  }

  it("keeps the label on the values of a record an alias declares, in the alias's definition", async () => {
    const { input, diagnostics } = await patternInputOf(`
      import { pattern } from "commonfabric";
      import type { Confidential } from "commonfabric";
      type Secret = Confidential<any, ["secret"]>;
      type Dict = Record<string, Secret>;
      export default pattern<{ a: Dict }>(() => ({}));
    `);

    expect(propertyA(input)).toEqual({ $ref: "#/$defs/Dict" });
    expect((input.$defs as Record<string, unknown>).Dict).toEqual({
      type: "object",
      properties: {},
      additionalProperties: { ifc: { confidentiality: ["secret"] } },
    });
    expect(diagnostics.filter(({ severity }) => severity === "error"))
      .toEqual([]);
  });

  it("keeps the label of a CFC alias over `any` imported from another module", async () => {
    const { input } = await patternInputOf(
      `
        import { pattern } from "commonfabric";
        import type { Secret } from "./schemas.ts";
        export default pattern<{ a: Secret }>(() => ({}));
      `,
      {
        "/schemas.ts": `
          import type { Confidential } from "commonfabric";
          export type Secret = Confidential<any, ["secret"]>;
        `,
      },
    );

    expect(propertyA(input)).toEqual({ ifc: { confidentiality: ["secret"] } });
  });

  it("keeps the label at every level of a generic alias nested in itself finitely", async () => {
    const { input, diagnostics } = await patternInputOf(`
      import { pattern } from "commonfabric";
      import type { Confidential } from "commonfabric";
      type Box<T> = { next: T } | Confidential<any, ["secret"]>;
      export default pattern<{ a: Box<Box<string>> }>(() => ({}));
    `);

    const box = (next: unknown) => ({
      anyOf: [
        { type: "object", properties: { next }, required: ["next"] },
        { ifc: { confidentiality: ["secret"] } },
      ],
    });
    expect(propertyA(input)).toEqual(box(box({ type: "string" })));
    expect(diagnostics.filter(({ severity }) => severity === "error"))
      .toEqual([]);
  });

  it("keeps the label at every level of a generic alias nested in itself finitely through an alias forwarding to it", async () => {
    const { input, diagnostics } = await patternInputOf(`
      import { pattern } from "commonfabric";
      import type { Confidential } from "commonfabric";
      type Box<T> = { next: T } | Confidential<any, ["secret"]>;
      type Wrap<T> = Box<T>;
      export default pattern<{ a: Wrap<Wrap<string>> }>(() => ({}));
    `);

    const box = (next: unknown) => ({
      anyOf: [
        { type: "object", properties: { next }, required: ["next"] },
        { ifc: { confidentiality: ["secret"] } },
      ],
    });
    expect(propertyA(input)).toEqual(box(box({ type: "string" })));
    expect(diagnostics.filter(({ severity }) => severity === "error"))
      .toEqual([]);
  });

  it("keeps the label at every level of a forwarded nesting whose alias also recurs through a named definition", async () => {
    const { input, diagnostics } = await patternInputOf(`
      import { pattern } from "commonfabric";
      import type { Confidential } from "commonfabric";
      type Secret = Confidential<any, ["secret"]>;
      type Box<T> = { next: T } | Secret | Node;
      type Node = { box: Box<string> };
      type Wrap<T> = Box<T>;
      export default pattern<{ a: Wrap<Wrap<string>> }>(() => ({}));
    `);

    const box = (next: unknown) => ({
      anyOf: [
        { type: "object", properties: { next }, required: ["next"] },
        { ifc: { confidentiality: ["secret"] } },
        { $ref: "#/$defs/Node" },
      ],
    });
    expect(propertyA(input)).toEqual(box(box({ type: "string" })));
    expect(diagnostics.filter(({ severity }) => severity === "error"))
      .toEqual([]);
  });

  for (
    const [alias, keys] of [
      ["Omit", `"parent"`],
      ["Pick", `"value"`],
    ] as const
  ) {
    it(`reports nothing for a recursion through a member \`${alias}\` drops`, async () => {
      const { input, diagnostics } = await patternInputOf(`
        import { pattern } from "commonfabric";
        import type { Confidential } from "commonfabric";
        type Secret = Confidential<any, ["secret"]>;
        type Data<T> =
          | ${alias}<{ parent: Data<T>; value: T }, ${keys}>
          | Secret;
        export default pattern<{ a: Data<string> }>(() => ({}));
      `);

      expect(propertyA(input)).toEqual({
        anyOf: [
          {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
          { ifc: { confidentiality: ["secret"] } },
        ],
      });
      expect(diagnostics.filter(({ severity }) => severity === "error"))
        .toEqual([]);
    });
  }

  it("reports `cfc-schema:recursive-alias-of-any` for a recursive alias wrapping a label around `any`", async () => {
    const { diagnostics } = await patternInputOf(`
      import { pattern } from "commonfabric";
      import type { Confidential } from "commonfabric";
      type Tree = { next: Tree } | Confidential<any, ["secret"]>;
      export default pattern<{ a: Tree }>(() => ({}));
    `);

    expect(diagnostics.map(({ type, severity }) => ({ type, severity })))
      .toEqual([
        { type: "cfc-schema:recursive-alias-of-any", severity: "error" },
      ]);
  });
});
