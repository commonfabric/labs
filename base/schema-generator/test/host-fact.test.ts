import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { SchemaGenerator } from "../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "./utils.ts";

/**
 * Local replicas of `HostFact` and `Default` (`base/api/index.ts`): the
 * generator recognizes the host fact carrier by its member's name, as it
 * recognizes the default brand.
 */
const PRELUDE = `
  declare const DEFAULT_MARKER: unique symbol;
  type DefaultMarker<T> = { readonly [DEFAULT_MARKER]: T };
  type Default<T, V extends T = T> = (T & DefaultMarker<V>) | T;
  type HostFactCarrier<K extends string> = {
    readonly __ct_host_fact__?: K;
  };
  type HostFact<T extends {}, K extends string> = T & HostFactCarrier<K>;
`;

/** The schema of `typeName`, declared in `code` after the prelude. */
const schemaOf = async (code: string, typeName: string) => {
  const { type, checker } = await getTypeFromCode(
    `${PRELUDE}${code}`,
    typeName,
  );
  return asObjectSchema(new SchemaGenerator().generateSchema(type, checker));
};

describe("host fact schemas", () => {
  it("marks a property with the fact its `HostFact` names", async () => {
    const schema = await schemaOf(
      `interface Input {
        loomId: HostFact<string, "loom.id">;
        title: string;
      }`,
      "Input",
    );

    expect(schema.properties?.loomId).toEqual({
      type: "string",
      hostFact: "loom.id",
    });
    expect(schema.properties?.title).toEqual({ type: "string" });
    expect(schema.required).toEqual(["loomId", "title"]);
  });

  it("keeps an optional fact out of `required`", async () => {
    const schema = await schemaOf(
      `interface Input { loomId?: HostFact<string, "loom.id"> }`,
      "Input",
    );

    expect(schema.properties?.loomId).toEqual({
      type: "string",
      hostFact: "loom.id",
    });
    expect(schema.required ?? []).toEqual([]);
  });

  it("marks a fact of a type other than `string`", async () => {
    const schema = await schemaOf(
      `interface Input { slot: HostFact<number, "loom.slot"> }`,
      "Input",
    );

    expect(schema.properties?.slot).toEqual({
      type: "number",
      hostFact: "loom.slot",
    });
  });

  it("keeps a `Default` written around the fact", async () => {
    const schema = await schemaOf(
      `interface Input {
        loomId: Default<HostFact<string, "loom.id">, "">;
      }`,
      "Input",
    );

    expect(schema.properties?.loomId).toEqual({
      type: "string",
      hostFact: "loom.id",
      default: "",
    });
  });

  it("reads the fact's key through a generic instantiation", async () => {
    const schema = await schemaOf(
      `interface Placed<K extends string> { where: HostFact<string, K> }
      interface Input { placed: Placed<"loom.id"> }`,
      "Input",
    );
    const placed = asObjectSchema(schema.properties?.placed);

    expect(placed.properties?.where).toEqual({
      type: "string",
      hostFact: "loom.id",
    });
  });

  it("throws for a value marked as two different facts", async () => {
    const code = `interface Input {
      both: HostFact<HostFact<string, "loom.id">, "loom.slot">;
    }`;

    await expect(schemaOf(code, "Input")).rejects.toThrow(
      "marked as the host fact",
    );
  });

  it("leaves a property with no `HostFact` unmarked", async () => {
    const schema = await schemaOf(
      `interface Input { loomId: string; meta: { __ct_host_fact: string } }`,
      "Input",
    );

    expect(schema.properties?.loomId).toEqual({ type: "string" });
    expect(JSON.stringify(schema)).not.toContain("hostFact");
  });
});
