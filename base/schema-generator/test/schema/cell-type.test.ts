import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

describe("Schema: Cell types", () => {
  for (const primitive of ["string", "number"] as const) {
    it(`preserves Cell metadata beside a matching ${primitive} union member`, async () => {
      const { type, checker } = await getTypeFromCode(
        `interface X { value: ${primitive} | Cell<${primitive}>; }`,
        "X",
      );
      const result = asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker),
      );
      const value = asObjectSchema(result.properties!.value!);
      expect(value.anyOf).toHaveLength(2);
      expect(value.anyOf).toEqual(expect.arrayContaining([
        { type: primitive },
        { type: primitive, asCell: ["cell"] },
      ]));
    });
  }

  it("handles Cell<string>", async () => {
    const code = `
      interface X { name: Cell<string>; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = new SchemaGenerator();
    const result = asObjectSchema(gen.generateSchema(type, checker));
    const name = result.properties?.name as Record<string, unknown>;
    expect(name).toBeDefined();
    expect(name.type).toBe("string");
    expect(name.asCell).toEqual(["cell"]);
    expect(result.required).toContain("name");
  });

  it("handles Cell<Array<{id:string}>>", async () => {
    const code = `
      interface X { users: Cell<Array<{ id: string }>>; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = new SchemaGenerator();
    const result = asObjectSchema(gen.generateSchema(type, checker));
    const users = result.properties?.users as Record<string, any>;
    expect(users).toBeDefined();
    expect(users.type).toBe("array");
    const usersItems = users.items as any;
    expect(usersItems?.type).toBe("object");
    const usersItemsProps = usersItems?.properties as any;
    expect(usersItemsProps?.id?.type).toBe("string");
    expect(users.asCell).toEqual(["cell"]);
  });

  it('handles SqliteDb (kind "sqlite")', async () => {
    const code = `
      interface X { db: SqliteDb; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = new SchemaGenerator();
    const result = asObjectSchema(gen.generateSchema(type, checker));
    const db = result.properties?.db as Record<string, unknown>;
    expect(db).toBeDefined();
    expect(db.asCell).toEqual(["sqlite"]);
    expect(result.required).toContain("db");
  });

  it("describes a SqliteDb's readable value as the handle descriptor", async () => {
    const code = `
      interface X { db: SqliteDb; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = new SchemaGenerator();
    const result = asObjectSchema(gen.generateSchema(type, checker));
    const db = result.properties?.db as Record<string, unknown>;
    expect(db.$ref).toBe("#/$defs/SqliteDatabase");
    const handle = (result.$defs?.SqliteDatabase ?? {}) as Record<
      string,
      unknown
    >;
    expect(handle.type).toBe("object");
    const properties = handle.properties as Record<string, unknown>;
    expect(properties.id).toEqual({ type: "string" });
    expect(properties.rev).toEqual({ type: "number" });
    expect(properties.tables).toEqual({
      type: "object",
      additionalProperties: true,
    });
    // The handle also carries `scope` and `owner`, which a read through this
    // schema must not drop.
    expect(handle.additionalProperties).toBe(true);
  });

  it("leaves a type carrying some other brand structural", async () => {
    const code = `
      declare const OTHER_BRAND: unique symbol;
      interface NotADatabase {
        readonly [OTHER_BRAND]: true;
        notAHandle: string;
      }
      interface X { db: NotADatabase; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = new SchemaGenerator();
    const result = asObjectSchema(gen.generateSchema(type, checker));
    const other = (result.$defs?.NotADatabase ?? {}) as Record<string, unknown>;
    expect(other.properties).toEqual({ notAHandle: { type: "string" } });
  });

  it("handles Stream<Cell<number>>", async () => {
    const code = `
      interface X { value: Stream<Cell<number>>; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = new SchemaGenerator();
    const result = asObjectSchema(gen.generateSchema(type, checker));
    const prop = result.properties?.value as Record<string, unknown>;
    expect(prop).toBeDefined();
    expect(prop.type).toBe("number");
    expect(prop.asStream).toBeUndefined();
    expect(prop.asCell).toEqual(["stream", "cell"]);
  });

  it("disallows Cell<Stream<T>> and suggests boxing", async () => {
    const code = `
      interface X { invalid: Cell<Stream<number>>; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = new SchemaGenerator();
    expect(() => gen.generateSchema(type, checker)).toThrow(
      "Cell<Stream<T>> is unsupported. Wrap the stream: Cell<{ stream: Stream<T> }>",
    );
  });
});
