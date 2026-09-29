import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

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
});
