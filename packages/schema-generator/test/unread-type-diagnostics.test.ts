import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { getLogger } from "@commonfabric/utils/logger";
import ts from "typescript";

import type { SchemaGenerationDiagnostic } from "../src/interface.ts";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { createTestProgram, getTypeFromCode } from "./utils.ts";

const f = ts.factory;

/** A reference to `name`, which the module being generated for does not hold. */
const unresolvable = (name: string) =>
  f.createTypeReferenceNode(f.createIdentifier(name));

/**
 * The warnings generating a schema for the synthetic `node` reports, its names
 * resolved in a module holding `source`.
 */
async function warningsFor(
  node: ts.TypeNode,
  source = "type Dummy = unknown;",
): Promise<SchemaGenerationDiagnostic[]> {
  const { checker, sourceFile } = await createTestProgram(source);
  const warnings: SchemaGenerationDiagnostic[] = [];
  new SchemaGenerator().generateSchemaFromSyntheticTypeNode(
    node,
    checker,
    undefined,
    undefined,
    sourceFile,
    { onDiagnostic: (diagnostic) => warnings.push(diagnostic) },
  );
  return warnings;
}

describe("unread-type-diagnostics", () => {
  describe("reportUnreadTypes()", () => {
    it("reports a type the schema could not read, naming it", async () => {
      const warnings = await warningsFor(unresolvable("PrintedElsewhere"));

      expect(warnings.map((warning) => warning.type)).toEqual([
        "schema-type:unread",
      ]);
      expect(warnings[0]!.message).toContain("`PrintedElsewhere`");
    });

    it("reports every unread type of one schema in a single warning, each once", async () => {
      const warnings = await warningsFor(
        f.createTypeLiteralNode([
          f.createPropertySignature(
            undefined,
            "first",
            undefined,
            unresolvable("Alpha"),
          ),
          f.createPropertySignature(
            undefined,
            "second",
            undefined,
            f.createUnionTypeNode([
              unresolvable("Beta"),
              unresolvable("Alpha"),
            ]),
          ),
        ]),
      );

      expect(warnings.length).toBe(1);
      const { message } = warnings[0]!;
      expect(message.match(/`Alpha`/g)?.length).toBe(1);
      expect(message).toContain("`Beta`");
    });

    it("counts the types past the first five instead of naming them", async () => {
      const warnings = await warningsFor(
        f.createUnionTypeNode(
          ["A", "B", "C", "D", "E", "F", "G"].map(unresolvable),
        ),
      );

      expect(warnings[0]!.message).toContain("`E` and 2 more.");
      expect(warnings[0]!.message).not.toContain("`F`");
    });

    it("counts types whose printed text differs only past what the message shows", async () => {
      const long = "Long".repeat(25);
      const warnings = await warningsFor(
        f.createUnionTypeNode(
          ["A", "B", "C", "D", "E", `${long}1`, `${long}2`].map(unresolvable),
        ),
      );

      expect(warnings[0]!.message).toContain("`E` and 2 more.");
    });

    it("logs the warning where the caller supplies no callback", async () => {
      // Captured at the logger, which is where the message is decided, rather
      // than at the console, which also answers to the logger's level.
      const { checker, sourceFile } = await createTestProgram(
        "type Dummy = unknown;",
      );
      const logger = getLogger("schema-generator.unread") as unknown as {
        warn: (key: string, ...messages: unknown[]) => void;
      };
      const original = logger.warn;
      const logged: string[] = [];
      logger.warn = (_key, ...messages) => {
        for (const message of messages) {
          logged.push(
            String(typeof message === "function" ? message() : message),
          );
        }
      };
      try {
        new SchemaGenerator().generateSchemaFromSyntheticTypeNode(
          unresolvable("PrintedElsewhere"),
          checker,
          undefined,
          undefined,
          sourceFile,
        );
      } finally {
        logger.warn = original;
      }

      expect(logged.length).toBe(1);
      expect(logged[0]).toContain("`PrintedElsewhere`");
    });

    it("logs an error when a CFC recursion cannot be read and no callback is supplied", async () => {
      const { type, checker } = await getTypeFromCode(
        `
        type Confidential<T, L> = T & { readonly __ct_cfc__?: { confidentiality: L } };
        type Nest<T> = Confidential<{ value: T; next?: Nest<T[]> }, readonly ["secret"]>;
        interface Holder { value: Nest<string> }
      `,
        "Holder",
      );
      const logger = getLogger("schema-generator.unread");
      const original = logger.error;
      const logged: string[] = [];
      logger.error = (_key, ...messages) => {
        for (const message of messages) {
          logged.push(
            String(typeof message === "function" ? message() : message),
          );
        }
      };
      try {
        new SchemaGenerator().generateSchema(type, checker);
      } finally {
        logger.error = original;
      }
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("recursion limit");
    });

    it("reports nothing for a schema it reads in full", async () => {
      const warnings = await warningsFor(
        f.createTypeLiteralNode([
          f.createPropertySignature(
            undefined,
            "name",
            undefined,
            f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
          ),
        ]),
      );

      expect(warnings).toEqual([]);
    });

    it("reports nothing for an authored `any`", async () => {
      const warnings = await warningsFor(
        f.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
      );

      expect(warnings).toEqual([]);
    });

    it("reports nothing for an alias whose body is its argument", async () => {
      // `Reactive<any>` is `any`, a reading, not a guess.
      const warnings = await warningsFor(
        f.createTypeReferenceNode(f.createIdentifier("Reactive"), [
          f.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
        ]),
        "export {};\ntype Reactive<T> = T;",
      );

      expect(warnings).toEqual([]);
    });

    it("reports nothing for a name declared as `any`", async () => {
      const warnings = await warningsFor(
        unresolvable("Deliberate"),
        "export {};\ntype Deliberate = any;",
      );

      expect(warnings).toEqual([]);
    });

    it("reports a name whose declaration the checker cannot type", async () => {
      const warnings = await warningsFor(
        unresolvable("Broken"),
        "export {};\n// @ts-ignore: the name is missing on purpose\n" +
          "type Broken = Missing;",
      );

      expect(warnings.map((warning) => warning.message)).toEqual([
        expect.stringContaining("`Broken`"),
      ]);
    });

    it("reports a reference to an alias of `Projection`, which it cannot read from arguments", async () => {
      // `Projection` is a conditional type, which this path does not evaluate,
      // so a reference that reaches it is not lowered from its own arguments,
      // and its declared type leaves them unbound. `Projection` written
      // directly is reported the same way.
      const source = `
          type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
          type ProjectionPath<T, From extends string, Path extends readonly unknown[]> = Cfc<T, { projection: { from: From; path: Path } }>;
          type ProjectionOf<Root, PathTuple extends readonly unknown[]> = ProjectionPath<Root, "/", PathTuple>;
          type Ref<Root, Path extends readonly unknown[]> = {
            readonly __ct_ref_root__?: Root;
            readonly __ct_ref_path__?: Path;
          };
          type Projection<SourceRef> = SourceRef extends Ref<
            infer Root,
            infer Path extends readonly unknown[]
          > ? ProjectionOf<Root, Path> : never;
          type MyProjection<R> = Projection<R>;
          interface Item { title: string }
      `;
      const referenceTo = (name: string) =>
        f.createTypeReferenceNode(name, [
          f.createTypeReferenceNode("Ref", [
            f.createTypeReferenceNode("Item"),
            f.createTupleTypeNode([
              f.createLiteralTypeNode(f.createStringLiteral("title")),
            ]),
          ]),
        ]);
      for (const name of ["MyProjection", "Projection"]) {
        const warnings = await warningsFor(referenceTo(name), source);

        expect(warnings.map((warning) => warning.type)).toEqual([
          "schema-type:unread",
        ]);
        expect(warnings[0]!.message).toContain(`\`${name}<`);
      }
    });

    it("reports nothing for an intersection that accepts nothing", async () => {
      // Beside `never`, what the unread constituent accepts is moot.
      const warnings = await warningsFor(
        f.createIntersectionTypeNode([
          unresolvable("Moot"),
          f.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword),
        ]),
      );

      expect(warnings).toEqual([]);
    });

    it("reports an unread constituent of an intersection that accepts values", async () => {
      const warnings = await warningsFor(
        f.createIntersectionTypeNode([
          unresolvable("Kept"),
          f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        ]),
      );

      expect(warnings.map((warning) => warning.message)).toEqual([
        expect.stringContaining("`Kept`"),
      ]);
    });

    it("reports nothing where a wrapper recovers the value from its resolved type", async () => {
      // The synthetic wrapper narrows `Cell<Stored>`, whose own argument
      // supplies the value the unreadable print cannot.
      const { checker, sourceFile } = await createTestProgram(
        "interface Stored { name?: string }\n" +
          "interface X { authored: Cell<Stored>; }",
      );
      const holder = checker.getSymbolsInScope(
        sourceFile,
        ts.SymbolFlags.Interface,
      ).find((candidate) => candidate.name === "X")!;
      const authored = checker.getDeclaredTypeOfSymbol(holder)
        .getProperty("authored")!;
      const warnings: SchemaGenerationDiagnostic[] = [];

      const schema = new SchemaGenerator().generateSchema(
        checker.getTypeOfSymbolAtLocation(authored, sourceFile),
        checker,
        f.createTypeReferenceNode(
          f.createQualifiedName(
            f.createIdentifier("__cfHelpers"),
            f.createIdentifier("ReadonlyCell"),
          ),
          [
            f.createImportTypeNode(
              f.createLiteralTypeNode(f.createStringLiteral("./types.ts")),
              undefined,
              f.createIdentifier("Stored"),
            ),
          ],
        ),
        { onDiagnostic: (diagnostic) => warnings.push(diagnostic) },
      );

      expect(schema).toMatchObject({ $ref: "#/$defs/Stored" });
      expect(warnings).toEqual([]);
    });
  });

  describe("a scope recursion read from a printed type", () => {
    // A print is read as its type, so a recursion it holds is reached by type
    // alone, with no written reference to name it by. Each
    // `Node<Readonly<…>>` is a new type, so the nesting bound ends the
    // reading.

    /**
     * The diagnostics generating a schema for `a` in a module declaring
     * `declarations`, read from a placeholder printed from its type.
     */
    async function diagnosticsForPrinted(
      declarations: string,
      a: string,
    ): Promise<SchemaGenerationDiagnostic[]> {
      const { checker, sourceFile } = await createTestProgram(
        `${declarations}\ninterface X { a: ${a}; }`,
      );
      const holder = checker.getSymbolsInScope(
        sourceFile,
        ts.SymbolFlags.Interface,
      ).find((candidate) => candidate.name === "X")!;
      const type = checker.getTypeOfSymbolAtLocation(
        checker.getDeclaredTypeOfSymbol(holder).getProperty("a")!,
        sourceFile,
      );
      const placeholder = f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
      const diagnostics: SchemaGenerationDiagnostic[] = [];
      new SchemaGenerator().generateSchema(type, checker, placeholder, {
        printedFrom: (node) => node === placeholder ? type : undefined,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      return diagnostics;
    }

    for (
      const [position, holder] of [
        ["an index signature", "interface Holder<U> { [key: string]: U }"],
        ["a tuple", "interface Holder<U> { items: [U, U] }"],
      ] as const
    ) {
      it(`names a scope recursion reached through ${position} by the type it stops at, which holds \`[]\``, async () => {
        const diagnostics = await diagnosticsForPrinted(
          `${holder}
type Wrap<L extends readonly unknown[]> = { x: string; l: L };
type Node<T> = PerUser<Cell<{ value: T; next?: Holder<Node<Readonly<T>>> }>>;`,
          "Node<Wrap<readonly []>>",
        );

        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toMatchObject({
          type: "schema-type:unread",
          severity: "warning",
        });
        expect(diagnostics[0]!.message).toContain("Wrap<readonly []>");
      });
    }
  });
});
