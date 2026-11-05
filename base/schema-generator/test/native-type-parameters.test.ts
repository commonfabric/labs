import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "./utils.ts";

describe("Native type parameters", () => {
  it("unwraps Uint8Array with defaulted typed buffer", async () => {
    const code = `
interface Wrapper {
  value: Uint8Array;
  pointer: Uint8Array<ArrayBufferLike & { foo?: number }>;
}
`;
    const { type, checker } = await getTypeFromCode(code, "Wrapper");
    const generator = new SchemaGenerator();
    const schema = asObjectSchema(generator.generateSchema(type, checker));
    const props = schema.properties as Record<string, unknown> | undefined;
    expect(props?.value).toEqual({ type: "object" });
    expect(props?.pointer).toEqual({ type: "object" });
    expect((schema as Record<string, unknown>).$defs).toBeUndefined();
  });

  it("treats ArrayBufferView as native type", async () => {
    const code = `
interface DataContainer {
  buffer: ArrayBufferView;
  metadata: string;
  optional?: ArrayBufferView;
}
`;
    const { type, checker } = await getTypeFromCode(code, "DataContainer");
    const generator = new SchemaGenerator();
    const schema = asObjectSchema(generator.generateSchema(type, checker));
    const props = schema.properties as Record<string, unknown> | undefined;

    // ArrayBufferView should resolve to true (opaque native type)
    expect(props?.buffer).toBe(true);
    expect(props?.optional).toBe(true);

    // Regular types should still work normally
    expect(props?.metadata).toEqual({ type: "string" });

    // Native types should not generate $defs
    expect((schema as Record<string, unknown>).$defs).toBeUndefined();
  });

  it("treats JSONSchemaObj and JSONSchema as native types", async () => {
    const code = `
interface PatternConfig {
  argumentSchema: JSONSchema;
  testSchema: JSONSchemaObj;
}
`;
    const { type, checker } = await getTypeFromCode(code, "PatternConfig");
    const generator = new SchemaGenerator();
    const schema = asObjectSchema(generator.generateSchema(type, checker));
    const props = schema.properties as Record<string, unknown> | undefined;

    // These should just be replaced by true
    expect(props?.argumentSchema).toBe(true);
    expect(props?.testSchema).toBe(true);

    // Native types should not generate $defs
    expect((schema as Record<string, unknown>).$defs).toBeUndefined();
  });

  it("generates VNode type as an absolute schema ref", async () => {
    // Use a fake VNode type for test
    const code = `
export type VNode = {
  type: "vnode";
  name: string;
  props: Record<string, object>;
  children: VNode[];
};
interface ClientView {
  view: VNode;
}
`;
    const { type, checker } = await getTypeFromCode(code, "ClientView");
    const generator = new SchemaGenerator();
    const schema = asObjectSchema(generator.generateSchema(type, checker));
    const props = schema.properties as Record<string, unknown> | undefined;

    console.log("Schema:", schema);

    expect(props?.view).toEqual({
      $ref: "https://commonfabric.org/schemas/vnode.json",
    });

    // Native types should not generate $defs
    expect(schema.$defs).toBeUndefined();
    // Native types should not generate $defs
    expect((schema as Record<string, unknown>).$defs).toBeUndefined();
  });

  it("treats JSONSchema as a native type when nested in Array", async () => {
    const code = `
interface PatternConfig {
  argumentSchemas: Array<JSONSchema>;
  testSchemas: JSONSchema[];
}
`;
    const { type, checker } = await getTypeFromCode(code, "PatternConfig");
    const generator = new SchemaGenerator();
    const schema = asObjectSchema(generator.generateSchema(type, checker));
    const props = schema.properties as Record<string, unknown> | undefined;

    console.log(schema);
    // These should just be replaced by true
    expect(props?.argumentSchemas).toEqual({ type: "array", items: true });
    expect(props?.testSchemas).toEqual({ type: "array", items: true });

    // Native types should not generate $defs
    expect((schema as Record<string, unknown>).$defs).toBeUndefined();
  });
});
