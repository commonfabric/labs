import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { parseModule, patternSchemas } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

/** Fields inspected in the generated recursive object schema. */
interface Schema {
  /** Reference to a definition in the root schema. */
  $ref?: string;

  /** Definitions used by recursive references. */
  $defs?: Record<string, Schema>;

  /** Schemas of the object's fields. */
  properties?: Record<string, Schema>;

  /** Policy claims attached to the value. */
  ifc?: { writeAuthorizedBy?: unknown };
}

describe("recursive writer schema", () => {
  it("warns without rejecting a generic recursion through a scope around a cell", async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    await transformSource(
      `import { Cell, PerUser, pattern } from "commonfabric";
type Node<T> = PerUser<Cell<{ label: T; next?: Node<T> }>>;
export default pattern<{ head: Node<string> }>(() => ({}));`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );

    expect(diagnostics.filter(({ severity }) => severity === "error")).toEqual(
      [],
    );
    expect(diagnostics.filter(({ type }) => type === "schema-type:unread"))
      .toHaveLength(1);
  });

  for (const position of ["argument", "result"]) {
    for (const storedSource of [false, true]) {
      it(`rejects an indirect writer in a recursive ${position} from ${storedSource ? "stored" : "authored"} source`, async () => {
        const diagnostics: TransformationDiagnostic[] = [];
        await transformSource(
          `import { Confidential, WriteAuthorizedBy, handler, pattern } from "commonfabric";
const f = handler<void, {}>(() => {});
type Indirect = typeof f;
type Pair<A, B> = Confidential<{
  left: WriteAuthorizedBy<string, A>;
  right: WriteAuthorizedBy<string, B>;
}, readonly ["pair"]>;
type Sec<W> = Confidential<{ value: W; next?: Sec<W> }, readonly ["a"]>;
interface Holder {
  x: Sec<Pair<typeof f, Indirect>>;
  y: Sec<Pair<Indirect, typeof f>>;
}
export default ${
            position === "argument"
              ? "pattern<Holder>(() => ({}))"
              : "pattern<{}, Holder>(() => ({} as Holder))"
          };`,
          {
            types: COMMONFABRIC_TYPES,
            typeCheck: true,
            pipelineDiagnostics: diagnostics,
            storedSource,
          },
        );

        const unread = diagnostics.filter(({ type }) =>
          type === "cfc-write-authorized-by:unread"
        );
        expect(unread.length).toBeGreaterThan(0);
        for (const diagnostic of unread) {
          expect(diagnostic.severity).toBe("error");
          expect(diagnostic.fileName).toBe("/test.tsx");
        }
      });
    }
  }

  it("emits each handler's write policy throughout its recursive input", async () => {
    const transformed = await transformSource(
      `import { Confidential, WriteAuthorizedBy, handler, pattern } from "commonfabric";
const f = handler<void, {}>(() => {});
const g: typeof f = handler<void, {}>(() => {});
type Identity<X> = X;
type Sec<W> = Confidential<{
  value: W;
  next?: Sec<Identity<W>>;
}, readonly ["a"]>;
export default pattern<{
  a: Sec<WriteAuthorizedBy<string, typeof f>>;
  b: Sec<WriteAuthorizedBy<string, typeof g>>;
}>(() => ({}));`,
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );
    const { input } = patternSchemas(parseModule(transformed)) as {
      input: Schema;
    };

    for (const [field, writer] of [["a", "f"], ["b", "g"]]) {
      let node = input.properties![field!]!;
      const visited = new Set<string>();
      for (;;) {
        expect(node.properties!.value!.ifc?.writeAuthorizedBy).toEqual({
          __ctWriterIdentityOf: { file: "/test.tsx", path: [writer] },
        });
        const next = node.properties!.next!;
        if (next.$ref) {
          if (visited.has(next.$ref)) break;
          visited.add(next.$ref);
          node = input.$defs![next.$ref.split("/").pop()!]!;
        } else {
          node = next;
        }
      }
      expect(visited.size).toBeGreaterThan(0);
    }
  });

  for (const operator of ["|", "&"]) {
    it(`emits a recursive reference when an alias repeats a writer with \`${operator}\``, async () => {
      const transformed = await transformSource(
        `import { Confidential, WriteAuthorizedBy, pattern } from "commonfabric";
declare const f: () => void;
type Repeat<W> = W ${operator} typeof f;
type Sec<W> = Confidential<{
  value: WriteAuthorizedBy<string, typeof f>;
  next?: Sec<Repeat<W>>;
}, readonly ["a"]>;
export default pattern<{ root: Sec<typeof f> }>(() => ({}));`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      const { input } = patternSchemas(parseModule(transformed)) as {
        input: Schema;
      };
      expect(Object.keys(input.$defs ?? {}).length).toBeGreaterThan(0);
      for (const definition of Object.values(input.$defs!)) {
        expect(definition.properties!.value!.ifc?.writeAuthorizedBy).toEqual({
          __ctWriterIdentityOf: { file: "/test.tsx", path: ["f"] },
        });
        expect(definition.properties!.next!.$ref).toMatch(/^#\/\$defs\//);
      }
    });
  }

  for (
    const expression of [
      "If<true, W, WriteAuthorizedBy<string, typeof g>>",
      "First<[W, WriteAuthorizedBy<string, typeof g>]>",
      "Unbox<Box<W>>",
      "NonNullable<W>",
    ]
  ) {
    it(`reports an error when a recursive policy cannot settle through ${expression}`, async () => {
      const diagnostics: TransformationDiagnostic[] = [];
      await transformSource(
        `import { Confidential, WriteAuthorizedBy, handler, pattern } from "commonfabric";
const f = handler<void, {}>(() => {});
const g: typeof f = handler<void, {}>(() => {});
type If<C, A, B> = C extends true ? A : B;
type First<T extends readonly unknown[]> = T[0];
type Box<T> = { boxed: T };
type Unbox<T> = T extends Box<infer U> ? U : T;
type Sec<W> = Confidential<{
  value: W;
  next?: Sec<${expression}>;
}, readonly ["a"]>;
export default pattern<{ a: Sec<WriteAuthorizedBy<string, typeof f>> }>(({ a }) => ({ a }));`,
        {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
          pipelineDiagnostics: diagnostics,
        },
      );
      const recursionLimits = diagnostics.filter(({ type }) =>
        type === "cfc-schema:recursion-limit"
      );
      expect(recursionLimits.length).toBeGreaterThan(0);
      for (const diagnostic of recursionLimits) {
        expect(diagnostic.severity).toBe("error");
        expect(diagnostic.fileName).toBe("/test.tsx");
      }
    });
  }
});
