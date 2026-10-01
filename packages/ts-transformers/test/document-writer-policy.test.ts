import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  callSchemas,
  literalToValue,
  parseModule,
  patternSchemas,
} from "./transformed-ast.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { transformSource } from "./utils.ts";

const PRELUDE = `/// <cts-enable />
import { Cfc, CurrentPrincipal, Default, RepresentsCurrentUser, UI, Writable, WriteAuthorizedBy, cell, computed, handler, pattern, wish } from "commonfabric";
const setName = handler<{ name: string }, { name: Writable<string> }>((event, { name }) => { name.set(event.name); });
type Owned<T, B> = RepresentsCurrentUser<Cfc<WriteAuthorizedBy<T, B>, { ownerPrincipal: CurrentPrincipal }>>;
`;

/** The policy the cases protect fields with, written in place. */
const POLICY = "WriteAuthorizedBy<string, typeof setName>";

/**
 * What became of a writer policy a document's schema reaches: its claim is in
 * the schema, its compilation fails as `cfc-write-authorized-by:unread`, or
 * neither, which leaves the document writable by anyone.
 */
type Outcome = "kept" | "refused" | "dropped";

const isUnreadWriter = (diagnostic: TransformationDiagnostic) =>
  diagnostic.type === "cfc-write-authorized-by:unread" &&
  diagnostic.severity === "error";

const holdsClaim = (schema: unknown) =>
  JSON.stringify(schema ?? null).includes('"writeAuthorizedBy"');

async function transform(
  source: string,
): Promise<{ root: ts.SourceFile; diagnostics: TransformationDiagnostic[] }> {
  const diagnostics: TransformationDiagnostic[] = [];
  const root = parseModule(
    await transformSource(`${PRELUDE}${source}`, {
      types: COMMONFABRIC_TYPES,
      typeCheck: true,
      pipelineDiagnostics: diagnostics,
    }),
  );
  return { root, diagnostics };
}

/** The schema each cell constructor or factory call in `root` creates its cell with. */
function creationSchemas(root: ts.SourceFile): unknown[] {
  const schemas: unknown[] = [];
  const visit = (node: ts.Node) => {
    const callee = ts.isNewExpression(node) || ts.isCallExpression(node)
      ? node.expression.getText(root)
      : undefined;
    if (
      callee && /^(Writable|Writable\.of|cell)$/.test(callee) &&
      (node as ts.CallExpression | ts.NewExpression).arguments?.[1]
    ) {
      schemas.push(
        literalToValue(
          (node as ts.CallExpression | ts.NewExpression).arguments![1]!,
        ),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return schemas;
}

/** The input schema of the pattern `root` exports by default. */
function inputSchema(root: ts.SourceFile): unknown {
  const call = root.statements.filter(ts.isExportAssignment).map((statement) =>
    statement.expression
  ).find(ts.isCallExpression);
  return call?.arguments[1] && literalToValue(call.arguments[1]);
}

function outcome(
  { diagnostics }: { diagnostics: TransformationDiagnostic[] },
  schemas: unknown[],
): Outcome {
  if (diagnostics.some(isUnreadWriter)) return "refused";
  return schemas.some(holdsClaim) ? "kept" : "dropped";
}

describe("document writer policy", () => {
  describe("an authored pattern's input", () => {
    // The input schema is what the pattern's argument document stores its
    // policy envelope from, so a writer it reaches is either in it or fails
    // compilation; it never goes missing.

    const shapes: readonly (readonly [string, string, string])[] = [
      ["a generic alias", "type Box<T> = { value: T };", `Box<${POLICY}>`],
      [
        "a generic interface",
        "interface Box<T> { value: T }",
        `Box<${POLICY}>`,
      ],
      [
        "a generic class",
        "class Box<T> { value!: T }",
        `{ box: Box<${POLICY}> }`,
      ],
      [
        "an interface's generic base",
        `interface Base<T> { value: T }\ninterface In extends Base<${POLICY}> {}`,
        "In",
      ],
      ["`Record`", "", `{ byId: Record<string, ${POLICY}> }`],
      [
        "a generic alias of `Record`",
        "type Dict<T> = Record<string, T>;",
        `{ byId: Dict<${POLICY}> }`,
      ],
      ["an index signature", "", `{ byId: { [key: string]: ${POLICY} } }`],
      ["a tuple", "", `{ pair: [${POLICY}] }`],
      [
        "a generic alias of a tuple",
        "type Tup<T> = [T];",
        `{ pair: Tup<${POLICY}> }`,
      ],
      [
        "a generic alias of `Array`",
        "type List<T> = Array<T>;",
        `{ items: List<${POLICY}> }`,
      ],
      [
        "a generic alias of `ReadonlyArray`",
        "type List<T> = ReadonlyArray<T>;",
        `{ items: List<${POLICY}> }`,
      ],
      [
        "a generic nullable alias",
        "type Maybe<T> = T | null;",
        `{ name: Maybe<${POLICY}> }`,
      ],
      [
        "a `Default` around a generic alias",
        "type Box<T> = { value: T };",
        `{ box?: Default<Box<${POLICY}>, { value: "" }> }`,
      ],
      [
        "an alias of the whole input",
        `type Box<T> = { value: T };\ntype In = Box<${POLICY}>;`,
        "In",
      ],
      [
        "an owner policy in a generic alias",
        "type Box<T> = { value: T };",
        "Box<Owned<string, typeof setName>>",
      ],
      ["`NonNullable`", "", `{ name: NonNullable<${POLICY} | undefined> }`],
      [
        "a default-library alias over the policy",
        "",
        "{ box: Readonly<WriteAuthorizedBy<{ a: string }, typeof setName>> }",
      ],
      [
        "a default-library alias over a named policy alias",
        "type Protected = WriteAuthorizedBy<{ a: string }, typeof setName>;",
        "{ box: Readonly<Protected> }",
      ],
    ];

    for (const [reach, declarations, input] of shapes) {
      it(`keeps or refuses a writer reached through ${reach}`, async () => {
        const result = await transform(`${declarations}
export default pattern<${input}>((input) => ({ input }));`);

        expect(outcome(result, [inputSchema(result.root)])).not.toBe(
          "dropped",
        );
      });
    }
  });

  describe("an authored pattern's result", () => {
    // A result type the author wrote is what the result document stores its
    // envelope from. An inferred one views the documents its fields link to.

    it("keeps or refuses a writer an authored result type reaches through a generic alias", async () => {
      const result = await transform(`type Box<T> = { value: T };
export default pattern<{ value: ${POLICY} }, { box: Box<${POLICY}> }>(
  ({ value }) => ({ box: { value } }),
);`);
      const output = (() => {
        const call = result.root.statements.filter(ts.isExportAssignment)
          .map((statement) => statement.expression).find(ts.isCallExpression);
        return call?.arguments[2] && literalToValue(call.arguments[2]);
      })();

      expect(outcome(result, [
        (output as { properties?: { box?: unknown } })
          ?.properties?.box,
      ])).not.toBe("dropped");
    });

    it("reports nothing for an inferred result that returns a protected value through a generic alias", async () => {
      const result = await transform(`type Box<T> = { value: T };
export default pattern<{ value: ${POLICY} }>(({ value }) => ({ box: { value } as Box<${POLICY}> }));`);

      expect(result.diagnostics.filter(isUnreadWriter)).toEqual([]);
    });
  });

  describe("a created cell", () => {
    // A cell's schema is what its document stores its policy envelope from.

    for (
      const [what, creation] of [
        ["a constructor", "new Writable(seed)"],
        ["`Writable.of`", "Writable.of(seed)"],
      ] as const
    ) {
      it(`refuses a writer ${what} reads only from its value's type`, async () => {
        // No syntax at the creation names the writer: the cell's type is the
        // value's, inferred.
        const result = await transform(`
export default pattern<{ initial: string }>(({ initial }) => {
  const seed = initial as ${POLICY};
  const x = ${creation}.for("x");
  return { x };
});`);

        expect(outcome(result, creationSchemas(result.root))).toBe("refused");
      });
    }

    it("refuses a writer read from an annotated value's type", async () => {
      const result = await transform(`
export default pattern<{ initial: string }>(({ initial }) => {
  const seed: ${POLICY} = initial as never;
  const x = new Writable(seed).for("x");
  return { x };
});`);

      expect(outcome(result, creationSchemas(result.root))).toBe("refused");
    });

    it("keeps or refuses a writer a generic type argument reaches", async () => {
      const result = await transform(`type Box<T> = { value: T };
export default pattern<{ initial: string }>(({ initial }) => {
  const x = new Writable<Box<${POLICY}>>({ value: "" }).for("x");
  return { x };
});`);

      expect(outcome(result, creationSchemas(result.root))).not.toBe(
        "dropped",
      );
    });

    it("keeps a policy written as the type argument, whose claim the transformer mints", async () => {
      const result = await transform(`
export default pattern<{ initial: string }>(({ initial }) => {
  const a = new Writable<${POLICY}>("").for("a");
  const b = Writable.of<${POLICY}>("").for("b");
  const c = cell<${POLICY}>("");
  return { a, b, c };
});`);

      expect(result.diagnostics.filter(isUnreadWriter)).toEqual([]);
      const schemas = creationSchemas(result.root);
      expect(schemas).toHaveLength(3);
      for (const schema of schemas) {
        expect(schema).toMatchObject({
          ifc: {
            writeAuthorizedBy: { __ctWriterIdentityOf: { path: ["setName"] } },
          },
        });
      }
    });
  });

  describe("a policy written as a cell's type argument, whose claim the transformer mints", () => {
    // The generator is handed the payload's node, and reports the root
    // writer it cannot read there; the claim answers it.

    it("keeps a policy over a nullable payload, whose alias the checker drops", async () => {
      // `null & carrier` is `never`, so the checker reduces the policy's type
      // to `string & carrier`, which carries no alias name to read it by.
      const result = await transform(`
export default pattern<{ initial: string }>(({ initial }) => {
  const a = new Writable<WriteAuthorizedBy<string | null, typeof setName>>(null as never).for("a");
  const b = Writable.of<WriteAuthorizedBy<{ text: string } | undefined, typeof setName>>(undefined as never).for("b");
  return { a, b };
});`);

      expect(result.diagnostics.filter(isUnreadWriter)).toEqual([]);
      const schemas = creationSchemas(result.root);
      expect(schemas).toHaveLength(2);
      for (const schema of schemas) {
        expect(schema).toMatchObject({
          ifc: {
            writeAuthorizedBy: { __ctWriterIdentityOf: { path: ["setName"] } },
          },
        });
      }
    });

    it("refuses a writer its payload reaches where no syntax names it", async () => {
      // Only the root policy's writer is the transformer's to supply.
      const result = await transform(`
export default pattern<{ initial: string }>(({ initial }) => {
  const a = new Writable<WriteAuthorizedBy<{ inner: { [key: string]: ${POLICY} } }, typeof setName>>({ inner: {} }).for("a");
  return { a };
});`);

      expect(outcome(result, [])).toBe("refused");
    });
  });

  describe("an owner policy a view reads in part", () => {
    // Without its writer, an owner, or a claim naming the current principal,
    // refuses every write against it, its own writer's included. A view
    // leaves them out with the writer, as the document it reads stores the
    // whole policy.

    const holdsPrincipalClaims = (schema: unknown) =>
      /ownerPrincipal|__ctCurrentPrincipal/.test(
        JSON.stringify(schema ?? null),
      );

    it("leaves them out of a computed's result, read from its type, and keeps the whole policy its input reads", async () => {
      const result = await transform(
        `type ProfileOut = { bio: Owned<string, typeof setName> };
export default pattern<{}>(() => {
  const profileWish = wish<ProfileOut>({ query: "#profile" });
  const bio = computed(() => profileWish.result!.bio);
  return { bio };
});`,
      );

      expect(result.diagnostics.filter(isUnreadWriter)).toEqual([]);
      const [input, output] = callSchemas(result.root, "lift");
      expect(holdsPrincipalClaims(output)).toBe(false);
      // The input reaches `ProfileOut`'s declaration, which names the writer.
      expect(input).toMatchObject({
        $defs: {
          ProfileOut: {
            properties: {
              bio: {
                ifc: {
                  ownerPrincipal: { __ctCurrentPrincipal: true },
                  writeAuthorizedBy: {
                    __ctWriterIdentityOf: { path: ["setName"] },
                  },
                },
              },
            },
          },
        },
      });
      expect(holdsClaim(callSchemas(result.root, "wish"))).toBe(true);
    });

    it("leaves them out of an inferred result, and keeps the whole policy in the input", async () => {
      const result = await transform(`
export default pattern<{ value: Owned<string, typeof setName> }>(({ value }) => ({ value }));`);
      const { input, output } = patternSchemas(result.root);

      expect(result.diagnostics.filter(isUnreadWriter)).toEqual([]);
      expect(holdsPrincipalClaims(output)).toBe(false);
      expect(input).toMatchObject({
        properties: {
          value: {
            ifc: {
              ownerPrincipal: { __ctCurrentPrincipal: true },
              writeAuthorizedBy: {
                __ctWriterIdentityOf: { path: ["setName"] },
              },
            },
          },
        },
      });
    });
  });

  describe("a schema that views a document", () => {
    // The document a view reads stores its own envelope, so a writer the
    // view's schema reads from a type alone leaves only the view without it.

    it("reports nothing for a wished value, a computed's capture of it, or a list it maps", async () => {
      const result = await transform(`type Box<T> = { value: T };
interface Found { box: Box<${POLICY}>; list: Box<${POLICY}>[] }
export default pattern<{}>(() => {
  const found = wish<Found>({ query: "#found" });
  const value = computed(() => found.result?.box.value);
  return {
    value,
    [UI]: <div>{found.result?.list.map((item) => <span>{item.value}</span>)}</div>,
  };
});`);

      expect(result.diagnostics.filter(isUnreadWriter)).toEqual([]);
    });

    it("reports nothing for a handler's state", async () => {
      const result = await transform(`type Box<T> = { value: T };
export const bump = handler<void, { box: Writable<Box<${POLICY}>> }>(
  (_, { box }) => { box.set({ value: "x" }); },
);
export default pattern<{}>(() => ({}));`);

      expect(result.diagnostics.filter(isUnreadWriter)).toEqual([]);
    });
  });
});
