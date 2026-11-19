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
  type HostFact<T extends string, K extends string> = T & HostFactCarrier<K>;
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

  it("marks a fact that may be `undefined` or `null`", async () => {
    const schema = await schemaOf(
      `interface Input {
        absent: HostFact<string, "loom.id"> | undefined;
        empty: HostFact<string, "loom.id"> | null;
      }`,
      "Input",
    );

    expect(JSON.stringify(schema.properties?.absent)).toContain(
      '"hostFact":"loom.id"',
    );
    expect(JSON.stringify(schema.properties?.empty)).toContain(
      '"hostFact":"loom.id"',
    );
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

  it("throws for a fact written around a union of strings", async () => {
    const code = `interface Input {
      side: HostFact<"left" | "right", "loom.side">;
    }`;

    await expect(schemaOf(code, "Input")).rejects.toThrow(
      "written around a union",
    );
  });

  it("throws for a fact written around a `Default`", async () => {
    const code = `interface Input {
      loomId: HostFact<Default<string, "">, "loom.id">;
    }`;

    await expect(schemaOf(code, "Input")).rejects.toThrow(
      "written around a union",
    );
  });

  it("formats a value derived from a fact and another value", async () => {
    // As a pattern's result derives `loomId ?? "unplaced"`: the carrier comes
    // along, and no fact is read there.
    const schema = await schemaOf(
      `interface Output { label: HostFact<string, "loom.id"> | "unplaced" }`,
      "Output",
    );

    expect(JSON.stringify(schema.properties?.label)).toContain('"unplaced"');
  });

  it("throws for a fact named by anything but one string literal", async () => {
    const code = `interface Input {
      loomId: HostFact<string, "loom.id" | "loom.slot">;
    }`;

    await expect(schemaOf(code, "Input")).rejects.toThrow("not as one string");
  });

  it("leaves a property with no `HostFact` unmarked", async () => {
    const schema = await schemaOf(
      `interface Input {
        loomId: string;
        lookalike: { readonly __ct_host_fact__?: "loom.id" };
      }`,
      "Input",
    );

    expect(schema.properties?.loomId).toEqual({ type: "string" });
    expect(JSON.stringify(schema)).not.toContain("hostFact");
  });
});
