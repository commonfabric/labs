/** Pins empty-record defaults in schemas emitted for pattern arguments. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type TransformationDiagnostic,
  transformCfDirective,
} from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { parseModule, patternSchemas } from "./transformed-ast.ts";
import { transformFiles, transformSource } from "./utils.ts";

describe("default-empty-record-schema", () => {
  for (const form of ["union member", "two arguments"]) {
    it(`emits empty object defaults for the ${form} form`, async () => {
      const defaults = {
        literal: "{}",
        stringKeys: "Record<string, never>",
        propertyKeys: "Record<PropertyKey, never>",
        indexSignature: "{ [key: string]: never }",
        alias: "EmptyRecord",
        literalAlias: "EmptyObject",
      };
      const properties = Object.entries(defaults).map(([name, value]) => {
        const type = form === "union member"
          ? `Record<string, unknown> | Default<${value}>`
          : `Default<Record<string, unknown>, ${value}>`;
        return `${name}: Writable<${type}>;`;
      }).join("\n");
      const diagnostics: TransformationDiagnostic[] = [];
      const output = await transformSource(
        `/// <cts-enable />
        import { Default, pattern, Writable } from "commonfabric";
        type EmptyRecord = Record<string, never>;
        type Empty = {};
        type EmptyObject = Empty;
        interface Input { ${properties} }
        export default pattern<Input>((state) => ({
          literal: state.literal,
          stringKeys: state.stringKeys,
          propertyKeys: state.propertyKeys,
          indexSignature: state.indexSignature,
          alias: state.alias,
          literalAlias: state.literalAlias,
        }));
        `,
        {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
          pipelineDiagnostics: diagnostics,
        },
      );
      const { input } = patternSchemas(parseModule(output));
      const schemas = input.properties as Record<
        string,
        Record<string, unknown>
      >;

      for (const name of Object.keys(defaults)) {
        expect(schemas[name]).toMatchObject({
          type: "object",
          asCell: ["cell"],
        });
      }
      expect(Object.fromEntries(
        Object.keys(defaults).map((name) => [name, schemas[name]?.default]),
      )).toEqual(Object.fromEntries(
        Object.keys(defaults).map((name) => [name, {}]),
      ));
      expect(diagnostics).toEqual([]);
    });
  }

  it("omits the default for never-valued types that are not empty records", async () => {
    // Named properties disqualify arrays and finite-key records from
    // representing empty-object defaults, even when their value type is `never`.
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `/// <cts-enable />
      import { Default, pattern, Writable } from "commonfabric";
      interface Input {
        namedNever: Writable<Default<Record<string, unknown>, Record<"required", never>>>;
        neverArray: Writable<Default<object, Array<never>>>;
        unionNamedNever: Writable<Record<string, unknown> | Default<Record<"required", never>>>;
      }
      export default pattern<Input>((state) => ({
        namedNever: state.namedNever,
        neverArray: state.neverArray,
        unionNamedNever: state.unionNamedNever,
      }));
      `,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );
    const { input } = patternSchemas(parseModule(output));
    const schemas = input.properties as Record<string, Record<string, unknown>>;

    for (const name of ["namedNever", "neverArray", "unionNamedNever"]) {
      expect(schemas[name]).toMatchObject({ type: "object", asCell: ["cell"] });
      expect(schemas[name]).not.toHaveProperty("default");
    }
    const warnings = diagnostics.filter((diagnostic) =>
      diagnostic.type === "schema-default:unresolved"
    );
    expect(warnings).toHaveLength(3);
    expect(warnings.map((warning) => warning.line)).toEqual([5, 6, 7]);
    expect(warnings.every((warning) => warning.severity === "warning")).toBe(
      true,
    );
  });

  it("locates imported unresolved defaults at the schema use", async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const source = `/// <cts-enable />
        import { pattern } from "commonfabric";
        import type { Input } from "./types.ts";
        export default pattern<Input>((state) => ({ value: state.value }));
      `;
    await transformFiles({
      "/types.ts": `
        import type { Default, Writable } from "commonfabric";
        export interface Input { value: Writable<Default<string>>; }
      `,
      "/test.tsx": source,
    }, {
      types: COMMONFABRIC_TYPES,
      typeCheck: true,
      pipelineDiagnostics: diagnostics,
    });

    const warnings = diagnostics.filter((diagnostic) =>
      diagnostic.type === "schema-default:unresolved"
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      fileName: "/test.tsx",
      severity: "warning",
    });
    const warning = warnings[0]!;
    expect(
      transformCfDirective(source).slice(
        warning.start,
        warning.start + warning.length,
      ),
    ).toContain("pattern<Input>");
  });

  it("warns instead of emitting partial object and tuple defaults", async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `/// <cts-enable />
      import { Default, pattern, Writable } from "commonfabric";
      interface Input {
        object: Writable<Default<Record<string, unknown>, { known: 1; missing: string }>>;
        tuple: Writable<Default<unknown[], [1, string]>>;
        unionObject: Writable<Record<string, unknown> | Default<{ nested: { missing: string } }>>;
        unionTuple: Writable<unknown[] | Default<[{ nested: [0, string] }]>>;
      }
      export default pattern<Input>((state) => ({
        object: state.object,
        tuple: state.tuple,
        unionObject: state.unionObject,
        unionTuple: state.unionTuple,
      }));
      `,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );
    const { input } = patternSchemas(parseModule(output));
    const schemas = input.properties as Record<string, Record<string, unknown>>;

    for (const name of ["object", "tuple", "unionObject", "unionTuple"]) {
      expect(schemas[name]).not.toHaveProperty("default");
    }
    const warnings = diagnostics.filter((diagnostic) =>
      diagnostic.type === "schema-default:unresolved"
    );
    expect(warnings).toHaveLength(4);
    expect(warnings.map((warning) => warning.line)).toEqual([5, 6, 7, 8]);
  });

  it("warns for unresolved DeepDefault values and preserves complete ones", async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `/// <cts-enable />
      import { DeepDefault, pattern, Writable } from "commonfabric";
      interface Config { nested: { label: string; values: unknown[] }; }
      interface Input {
        object: Writable<Config | DeepDefault<{ nested: { label: string } }>>;
        tuple: Writable<Config | DeepDefault<{ nested: { values: [0, string] } }>>;
        complete: Writable<Config | DeepDefault<{ nested: { values: [null, false, 0, ""] } }>>;
      }
      export default pattern<Input>((state) => ({
        object: state.object,
        tuple: state.tuple,
        complete: state.complete,
      }));
      `,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );
    const { input } = patternSchemas(parseModule(output));
    const schemas = input.properties as Record<string, Record<string, unknown>>;

    for (const name of ["object", "tuple"]) {
      expect(schemas[name]).not.toHaveProperty("default");
    }
    expect(schemas.complete).toHaveProperty("default", {
      nested: { values: [null, false, 0, ""] },
    });
    const warnings = diagnostics.filter((diagnostic) =>
      diagnostic.type === "schema-default:unresolved"
    );
    expect(warnings).toHaveLength(2);
    expect(warnings.map((warning) => warning.line)).toEqual([6, 7]);
    expect(
      warnings.every((warning) =>
        warning.severity === "warning" &&
        warning.message.includes("DeepDefault<>")
      ),
    ).toBe(true);
  });
});
