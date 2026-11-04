import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import ts from "typescript";

import { SchemaGenerator } from "../../src/schema-generator.ts";
import { createTestProgram } from "../utils.ts";

describe("Circular alias error handling", () => {
  it("should throw descriptive error for circular Default aliases", async () => {
    const code = `
      type Default<T, V extends T = T> = T;
      type A<T, V> = B<T, V>;
      type B<T, V> = A<T, V>;
      interface SchemaRoot {
        circularAlias: A<string, "test">;
      }
    `;

    const { checker, sourceFile } = await createTestProgram(code);

    const rootInterface = sourceFile.statements.find((stmt) =>
      ts.isInterfaceDeclaration(stmt) && stmt.name.text === "SchemaRoot"
    );

    if (!rootInterface || !ts.isInterfaceDeclaration(rootInterface)) {
      throw new Error("SchemaRoot interface not found");
    }

    const circularProperty = rootInterface.members[0] as ts.PropertySignature;
    const type = checker.getTypeFromTypeNode(circularProperty.type!);

    const generator = new SchemaGenerator();

    expect(() => {
      generator.generateSchema(type, checker, circularProperty.type);
    }).toThrow("Circular type alias detected: A -> B -> A");
  });

  it("should handle longer circular chains", async () => {
    const code = `
      type Default<T, V extends T = T> = T;
      type A<T, V> = B<T, V>;
      type B<T, V> = C<T, V>;
      type C<T, V> = A<T, V>;
      interface SchemaRoot {
        circularAlias: A<string, "test">;
      }
    `;

    const { checker, sourceFile } = await createTestProgram(code);

    const rootInterface = sourceFile.statements.find((stmt) =>
      ts.isInterfaceDeclaration(stmt) && stmt.name.text === "SchemaRoot"
    );

    if (!rootInterface || !ts.isInterfaceDeclaration(rootInterface)) {
      throw new Error("SchemaRoot interface not found");
    }

    const circularProperty = rootInterface.members[0] as ts.PropertySignature;
    const type = checker.getTypeFromTypeNode(circularProperty.type!);

    const generator = new SchemaGenerator();

    expect(() => {
      generator.generateSchema(type, checker, circularProperty.type);
    }).toThrow("Circular type alias detected: A -> B -> C -> A");
  });
});
