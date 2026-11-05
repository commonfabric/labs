import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

describe("Schema: type-to-schema parity", () => {
  it("generates schemas for inputs/outputs structures", async () => {
    const code = `
      interface UpdaterInput { newValues: string[]; }
      interface PatternInput { values: Cell<string[]>; }
      interface PatternOutput { values: string[]; updater: Stream<UpdaterInput>; }
    `;
    const { type: uType, checker: uChecker, typeNode: uNode } =
      await getTypeFromCode(code, "UpdaterInput");
    const { type: iType, checker: iChecker, typeNode: iNode } =
      await getTypeFromCode(code, "PatternInput");
    const { type: oType, checker: oChecker, typeNode: oNode } =
      await getTypeFromCode(code, "PatternOutput");
    const gen = new SchemaGenerator();
    const u = asObjectSchema(gen.generateSchema(uType, uChecker, uNode));
    const i = asObjectSchema(gen.generateSchema(iType, iChecker, iNode));
    const o = asObjectSchema(gen.generateSchema(oType, oChecker, oNode));
    // UpdaterInput
    expect(u.type).toBe("object");
    const uNewValues = u.properties?.newValues as any;
    expect(uNewValues?.type).toBe("array");
    expect(uNewValues?.items?.type).toBe("string");
    // PatternInput
    const iValues = i.properties?.values as any;
    expect(iValues?.asCell).toEqual(["cell"]);
    expect(iValues?.type).toBe("array");
    expect(iValues?.items?.type).toBe("string");
    // PatternOutput
    const oValues = o.properties?.values as any;
    expect(oValues?.type).toBe("array");
    expect(oValues?.items?.type).toBe("string");
    const upd = o.properties?.updater as any;
    expect(upd.asCell).toEqual(["stream"]);
    expect(upd.asStream).toBeUndefined();
    expect(upd.$ref).toBe("#/$defs/UpdaterInput");
    const defU = (o as any).$defs?.UpdaterInput as any;
    expect(defU.type).toBe("object");
    expect(defU.properties?.newValues?.type).toBe("array");
    expect(defU.properties?.newValues?.items?.type).toBe("string");
  });

  it("handles nested objects with string and number unions", async () => {
    const code = `
      interface UserInfo {
        profile: {
          name: string;
          email?: string;
        };
        status: "active" | "inactive" | "pending";
        level: 1 | 2 | 3;
      }
    `;

    const { type, checker } = await getTypeFromCode(code, "UserInfo");
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    expect(schema.type).toBe("object");
    const profile = schema.properties?.profile as Record<string, any>;
    expect(profile?.type).toBe("object");
    const profileProps = profile?.properties as Record<string, any>;
    expect(profileProps?.name?.type).toBe("string");
    expect(profile.required).toContain("name");
    expect(profile.required).not.toContain("email");

    const status = schema.properties?.status as Record<string, unknown>;
    expect(status?.enum).toEqual(["active", "inactive", "pending"]);

    const level = schema.properties?.level as Record<string, unknown>;
    expect(level?.enum).toEqual([1, 2, 3]);
  });
});
