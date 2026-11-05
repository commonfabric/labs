import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

describe("Schema: Nested wrappers (Cell, Stream, Default)", () => {
  it("Default<string, 'hello'> inside object", async () => {
    const code = `
      interface Default<T, V> {}
      interface X { field1: Default<string, "hello">; field2: Default<number, 42>; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = new SchemaGenerator();
    const s = asObjectSchema(gen.generateSchema(type, checker));
    const field1 = s.properties?.field1 as any;
    expect(field1?.type).toBe("string");
    expect(field1?.default).toBe("hello");
    const field2 = s.properties?.field2 as any;
    expect(field2?.type).toBe("number");
    expect(field2?.default).toBe(42);
  });

  it("Cell<Default<string,'default'>>", async () => {
    const code = `
      interface Default<T, V> {}
      interface X { value: Cell<Default<string, "default">>; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const s = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );
    const v = s.properties?.value as any;
    expect(v.type).toBe("string");
    expect(v.default).toBe("default");
    expect(v.asCell).toEqual(["cell"]);
  });

  it("Stream<Default<string,'initial'>>", async () => {
    const code = `
      interface Default<T, V> {}
      interface X { events: Stream<Default<string, "initial">>; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const s = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );
    const ev = s.properties?.events as any;
    expect(ev.type).toBe("string");
    expect(ev.default).toBe("initial");
    expect(ev.asStream).toBeUndefined();
    expect(ev.asCell).toEqual(["stream"]);
  });

  it("Stream<Default<string[], ['a']>> yields array schema with default", async () => {
    const code = `
      interface Default<T, V> {}
      interface X { events: Stream<Default<string[], ["a"]>>; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const s = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );
    const ev = s.properties?.events as any;
    expect(ev.type).toBe("array");
    const evItems = ev.items as any;
    expect(evItems?.type).toBe("string");
    expect(ev.default).toEqual(["a"]);
    expect(ev.asCell).toEqual(["stream"]);
    expect(ev.asStream).toBeUndefined();
  });

  it("array of Cell<string>", async () => {
    const code = `
      interface X { items: Array<Cell<string>>; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const s = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );
    const items = s.properties?.items as any;
    expect(items.type).toBe("array");
    const itemsItems = items.items as any;
    expect(itemsItems?.type).toBe("string");
    // Items may carry asCell depending on formatter; assert if present
    if (Object.prototype.hasOwnProperty.call(itemsItems, "asCell")) {
      expect(itemsItems.asCell).toEqual(["cell"]);
    }
  });

  it("Cell<string[]>", async () => {
    const code = `
      interface X { tags: Cell<string[]>; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const s = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );
    const tags = s.properties?.tags as any;
    expect(tags.type).toBe("array");
    const tagsItems = tags.items as any;
    expect(tagsItems?.type).toBe("string");
    expect(tags.asCell).toEqual(["cell"]);
  });

  it("complex nesting: Cell<Default<string,'d'>> and Default<string[], ['a','b']>", async () => {
    const code = `
      interface Default<T, V> {}
      interface X {
        cellOfDefault: Cell<Default<string, "d">>;
        defaultArray: Default<string[], ["a", "b"]>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const s = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );
    const c = s.properties?.cellOfDefault as any;
    expect(c.type).toBe("string");
    expect(c.default).toBe("d");
    expect(c.asCell).toEqual(["cell"]);
    const da = s.properties?.defaultArray as any;
    expect(da.type).toBe("array");
    const daItems = da.items as any;
    expect(daItems?.type).toBe("string");
    expect(da.default).toEqual(["a", "b"]);
  });
});
