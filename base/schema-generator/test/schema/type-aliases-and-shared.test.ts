import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

describe("Schema: Type aliases and shared types", () => {
  it("handles basic Cell/Stream/Default aliases", async () => {
    const code = `
      interface Default<T, V> {}
      type MyCell<T> = Cell<T>;
      type StringCell = Cell<string>;
      type MyStream<T> = Stream<T>;
      type WithDefault<T, V> = Default<T, V>;
      type CellArray<T> = Cell<T[]>;
      type StreamOfCells<T> = Stream<Cell<T>>;

      interface TypeAliasTest {
        genericCell: MyCell<string>;
        specificCell: StringCell;
        genericStream: MyStream<number>;
        withDefault: WithDefault<string, "hello">;
        cellOfArray: CellArray<number>;
        streamOfCells: StreamOfCells<string>;
        nestedAlias: MyCell<MyCell<string>[]>[];
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "TypeAliasTest");
    const s = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );
    const genericCell = s.properties?.genericCell as any;
    expect(genericCell?.type).toBe("string");
    expect(genericCell?.asCell).toEqual(["cell"]);
    const specificCell = s.properties?.specificCell as any;
    expect(specificCell?.type).toBe("string");
    expect(specificCell?.asCell).toEqual(["cell"]);
    const genericStream = s.properties?.genericStream as any;
    expect(genericStream?.type).toBe("number");
    expect(genericStream?.asStream).toBeUndefined();
    expect(genericStream?.asCell).toEqual(["stream"]);
    const withDefault = s.properties?.withDefault as any;
    expect(withDefault?.type).toBe("string");
    expect(withDefault?.default).toBe("hello");
    const coa = s.properties?.cellOfArray as any;
    expect(coa.type).toBe("array");
    expect(coa.items?.type).toBe("number");
    expect(coa.asCell).toEqual(["cell"]);
    const soc = s.properties?.streamOfCells as any;
    expect(soc.type).toBe("string");
    expect(soc.asStream).toBeUndefined();
    expect(soc.asCell).toEqual(["stream", "cell"]);
    const na = s.properties?.nestedAlias as any;
    expect(na.type).toBe("array");
    expect(na.items?.type).toBe("array");
    expect(na.items?.items?.type).toBe("string");
  });

  it("hoists shared object type to definitions and references via $ref", async () => {
    const code = `
      interface B { value: string; }
      interface A { b1: B; b2: B; }
    `;
    const { type, checker } = await getTypeFromCode(code, "A");
    const s = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );
    const b1 = s.properties?.b1 as any;
    const b2 = s.properties?.b2 as any;
    expect(b1.$ref).toBe("#/$defs/B");
    expect(b2.$ref).toBe("#/$defs/B");
    const defB = (s as any).$defs?.B as any;
    expect(defB.type).toBe("object");
    expect(defB.properties?.value?.type).toBe("string");
    expect(defB.required).toContain("value");
  });
});
