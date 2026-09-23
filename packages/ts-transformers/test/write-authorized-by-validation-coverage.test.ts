import { assert, assertEquals } from "@std/assert";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { validateFiles, validateSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

/**
 * Exercises the branches of the WriteAuthorizedBy validation transformer that
 * the existing cfc-authoring tests do not reach: property-access `toSchema`
 * call sites, non-identifier `typeof` bindings, recursion guards while walking
 * local type declarations, index-signature traversal, the generic type-argument
 * substitution over array/union/intersection/operator/parenthesized shapes, and
 * the initializer-unwrapping loop that sees through parentheses and assertions.
 */

async function cfcDiagnostics(
  source: string,
): Promise<readonly TransformationDiagnostic[]> {
  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  return diagnostics.filter((diagnostic) =>
    diagnostic.type === "cfc-write-authorized-by"
  );
}

Deno.test(
  "property-access toSchema call site is validated for WriteAuthorizedBy",
  async () => {
    const source = `/// <cts-enable />
      import { WriteAuthorizedBy } from "commonfabric";

      declare const ns: { toSchema<T>(): unknown };
      const arbitrary = 123;

      const schema = ns.toSchema<
        WriteAuthorizedBy<{ title: string }, typeof arbitrary>
      >();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
    assert(
      diagnostics[0]!.message.includes(
        "handler(), module(), requireEventIntegrity()",
      ),
    );
  },
);

Deno.test(
  "typeof of a qualified name reports the simple-identifier requirement",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      const container = { saver() {} };

      const schema = toSchema<
        WriteAuthorizedBy<{ title: string }, typeof container.saver>
      >();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
    assert(diagnostics[0]!.message.includes("simple identifier binding"));
  },
);

Deno.test(
  "index-signature members of a referenced interface are traversed for bindings",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      const arbitrary = 123;

      interface Bag {
        [key: string]: WriteAuthorizedBy<{ title: string }, typeof arbitrary>;
      }

      const schema = toSchema<Bag>();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
    assert(
      diagnostics[0]!.message.includes(
        "handler(), module(), requireEventIntegrity()",
      ),
    );
  },
);

Deno.test(
  "self-referential type alias terminates and still reports the binding error",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      const arbitrary = 123;

      type Recursive = {
        self?: Recursive;
        write: WriteAuthorizedBy<{ title: string }, typeof arbitrary>;
      };

      const schema = toSchema<Recursive>();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
  },
);

//
// The substitution walker's branches
//
// These cases place the generic alias parameter *inside* the schema type
// argument of WriteAuthorizedBy, wrapped in a distinct type shape. When the
// validator substitutes the actual type into the alias parameter, it must
// descend through that shape to rebuild the WriteAuthorizedBy reference. The
// cases pin the walker's branches — array, union with parenthesization,
// intersection, type operator, index signature, and a type literal with
// non-property members — and each asserts the binding is still validated
// afterward.
//

Deno.test(
  "generic alias substitutes schema through array element types",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      const arbitrary = 123;

      type Wrap<T> = {
        write: WriteAuthorizedBy<T[], typeof arbitrary>;
      };

      const schema = toSchema<Wrap<{ title: string }>>();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
  },
);

Deno.test(
  "generic alias substitutes schema through union and parenthesized types",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      const arbitrary = 123;

      type Wrap<T> = {
        write: WriteAuthorizedBy<(T | undefined), typeof arbitrary>;
      };

      const schema = toSchema<Wrap<{ title: string }>>();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
  },
);

Deno.test(
  "generic alias substitutes schema through intersection types",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      const arbitrary = 123;

      type Wrap<T> = {
        write: WriteAuthorizedBy<T & { tag: string }, typeof arbitrary>;
      };

      const schema = toSchema<Wrap<{ title: string }>>();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
  },
);

Deno.test(
  "generic alias substitutes schema through readonly type-operator types",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      const arbitrary = 123;

      type Wrap<T> = {
        write: WriteAuthorizedBy<readonly T[], typeof arbitrary>;
      };

      const schema = toSchema<Wrap<{ title: string }>>();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
  },
);

Deno.test(
  "generic alias substitutes schema through index-signature member types",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      const arbitrary = 123;

      type Wrap<T> = {
        write: WriteAuthorizedBy<{ [key: string]: T }, typeof arbitrary>;
      };

      const schema = toSchema<Wrap<{ title: string }>>();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
  },
);

Deno.test(
  "generic alias substitutes schema literals with non-property members",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      const arbitrary = 123;

      type Wrap<T> = {
        write: WriteAuthorizedBy<{ payload: T; describe(): string }, typeof arbitrary>;
      };

      const schema = toSchema<Wrap<{ title: string }>>();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
  },
);

//
// A binding the walker never has to enter
//
// The parentheses and assertions here wrap the binding VALUE, not a type, so
// no substitution happens and the walker is not reached at all.
//

Deno.test(
  "supported binding wrapped in parentheses and assertions is accepted",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      declare function handler<E, S>(fn: (event: E, state: S) => void): () => void;

      const saver = (handler<void, {}>((_e, _s) => {}) as unknown)!;

      const schema = toSchema<
        WriteAuthorizedBy<{ title: string }, typeof saver>
      >();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 0);
  },
);

Deno.test(
  "a foreign constructor's type arguments are not writer claims",
  async () => {
    // `Map` generates no cell schema; its unresolved `Binding` is not a defect.
    const source = `/// <cts-enable />
      import { WriteAuthorizedBy } from "commonfabric";

      export function empty<T, Binding>() {
        return new Map<string, WriteAuthorizedBy<T, Binding>>();
      }
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 0);
  },
);

Deno.test(
  "a cell constructor's type arguments are writer claims",
  async () => {
    const source = `/// <cts-enable />
      import { Writable, WriteAuthorizedBy } from "commonfabric";

      const arbitrary = 123;
      export const cell = new Writable<
        WriteAuthorizedBy<string, typeof arbitrary>
      >("");
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
    assert(diagnostics[0]!.message.includes("only supports handler()"));
  },
);

Deno.test(
  "a writer declared in a declaration file is refused",
  async () => {
    const { diagnostics } = await validateFiles({
      "/main.tsx": `/// <cts-enable />
        import { toSchema, WriteAuthorizedBy } from "commonfabric";
        import { ambient } from "./ambient.d.ts";

        const schema = toSchema<
          WriteAuthorizedBy<{ title: string }, typeof ambient>
        >();

        export { schema };
      `,
      "/ambient.d.ts": "export declare function ambient(): void;",
    }, { types: COMMONFABRIC_TYPES });
    const cfc = diagnostics.filter((diagnostic) =>
      diagnostic.type === "cfc-write-authorized-by"
    );
    assertEquals(cfc.length, 1);
    assert(cfc[0]!.message.includes("authored module"));
  },
);

Deno.test(
  "a policy carried by a declaration file's alias is validated",
  async () => {
    // The generator resolves the alias and would emit its claim; the writer
    // it names has no provenance, so the claim is refused here instead.
    const { diagnostics } = await validateFiles({
      "/main.tsx": `/// <cts-enable />
        import { toSchema } from "commonfabric";
        import type { Guarded } from "./guarded.d.ts";

        const schema = toSchema<Guarded>();

        export { schema };
      `,
      "/guarded.d.ts": `import type { WriteAuthorizedBy } from "commonfabric";
        export declare function ambient(): void;
        export type Guarded = WriteAuthorizedBy<{ title: string }, typeof ambient>;`,
    }, { types: COMMONFABRIC_TYPES });
    const cfc = diagnostics.filter((diagnostic) =>
      diagnostic.type === "cfc-write-authorized-by"
    );
    assertEquals(cfc.length, 1);
    assert(cfc[0]!.message.includes("authored module"));
  },
);

Deno.test(
  "a module-level writer is found when a local of the same name shadows it",
  async () => {
    // A name scan of the file would have found the module-level handler and
    // accepted the claim; the claim names the local.
    const source = `/// <cts-enable />
      import { handler, toSchema, WriteAuthorizedBy } from "commonfabric";

      const saver = handler<void, {}>((_e, _s) => {});

      export function schemaFor() {
        const saver = 123;
        return toSchema<WriteAuthorizedBy<{ title: string }, typeof saver>>();
      }
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
    assert(diagnostics[0]!.message.includes("only supports handler()"));
  },
);
