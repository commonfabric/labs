import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callSchemas, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

const IMPORTS =
  `import { computed, handler, pattern, type Confidential, type WriteAuthorizedBy, Writable } from "commonfabric";
interface Secret { a: string; b: string; }
`;

/** An emitted schema, read as a plain record. */
type Schema = Record<string, unknown>;

/** The properties of the schema of the first `computed()` capture in `source`. */
async function captureOf(source: string): Promise<Schema> {
  const output = await transformSource(IMPORTS + source, {
    types: COMMONFABRIC_TYPES,
    typeCheck: true,
  });
  const [capture] = callSchemas(parseModule(output), "lift");
  return capture!.properties as Schema;
}

/** A pattern over `input` whose `computed()` returns `read`. */
function reading(input: string, read: string): string {
  return `export default pattern<{ ${input} }>((input) => ({
  out: computed(() => ${read}),
}));`;
}

/** The schema of `Secret` with only `a` read, labeled with `ifc`. */
const A_ONLY = (ifc?: Schema) => ({
  type: "object",
  properties: { a: { type: "string" } },
  required: ["a"],
  ...(ifc && { ifc }),
});

describe("narrowed capture labels", () => {
  it("keeps a label on a value read by a property chain", async () => {
    const capture = await captureOf(`
export default pattern<{ secret: Confidential<Secret, ["top"]> }>(
  ({ secret }) => ({ out: computed(() => secret.a) }),
);`);

    expect(capture.secret).toEqual(A_ONLY({ confidentiality: ["top"] }));
  });

  it("keeps a label on a value read by an optional chain", async () => {
    const capture = await captureOf(`
export default pattern<{ maybe: Confidential<Secret, ["top"]> | undefined }>(
  ({ maybe }) => ({ out: computed(() => maybe?.a ?? "") }),
);`);

    expect(capture.maybe).toEqual(A_ONLY({ confidentiality: ["top"] }));
  });

  it("keeps the label of an alias over a CFC alias", async () => {
    const capture = await captureOf(`
type Sealed<T> = Confidential<T, ["sealed"]>;
export default pattern<{ sealed: Sealed<Secret> }>(
  ({ sealed }) => ({ out: computed(() => sealed.a) }),
);`);

    expect(capture.sealed).toEqual(A_ONLY({ confidentiality: ["sealed"] }));
  });

  it("keeps a label at the level of the value that carries it", async () => {
    const capture = await captureOf(
      reading(
        `nested: { inner: Confidential<Secret, ["deep"]> }`,
        "input.nested.inner.a",
      ),
    );

    expect(capture.input).toEqual({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { inner: A_ONLY({ confidentiality: ["deep"] }) },
          required: ["inner"],
        },
      },
      required: ["nested"],
    });
  });

  it("keeps a label on a list read for its length", async () => {
    const capture = await captureOf(`
export default pattern<{ list: Confidential<Secret[], ["listed"]> }>(
  ({ list }) => ({ out: computed(() => list.length) }),
);`);

    expect(capture.list).toEqual({
      type: "object",
      properties: { length: { type: "number" } },
      required: ["length"],
      ifc: { confidentiality: ["listed"] },
    });
  });

  it("keeps a label on a value whose cell it reads", async () => {
    const capture = await captureOf(`
interface Box { count: Writable<number>; a: string; b: string; }
export default pattern<{ box: Confidential<Box, ["boxed"]> }>(
  ({ box }) => ({ out: computed(() => box.count.get() + box.a) }),
);`);

    expect(capture.box).toEqual({
      type: "object",
      properties: {
        count: { type: "number", asCell: ["readonly"] },
        a: { type: "string" },
      },
      required: ["count", "a"],
      ifc: { confidentiality: ["boxed"] },
    });
  });

  it("keeps each element's label on an element read by index", async () => {
    const capture = await captureOf(`
type Sealed<T> = Confidential<T, ["sealed"]>;
export default pattern<{ rows: Sealed<Secret>[] }>(
  ({ rows }) => ({ out: computed(() => rows?.[1]?.a ?? "") }),
);`);

    expect(capture.rows).toEqual({
      type: "array",
      items: A_ONLY({ confidentiality: ["sealed"] }),
    });
  });

  it("reads a label its declaration names by `typeof`", async () => {
    const capture = await captureOf(`
const setSecret = handler<{ value: Secret }, { secret: Writable<Secret> }>(
  ({ value }, { secret }) => secret.set(value),
);
export default pattern<{ secret: WriteAuthorizedBy<Secret, typeof setSecret> }>(
  ({ secret }) => ({ out: computed(() => secret.a) }),
);`);

    expect(capture.secret).toMatchObject({
      ifc: {
        writeAuthorizedBy: { __ctWriterIdentityOf: { path: ["setSecret"] } },
      },
    });
  });

  it("joins the confidentiality of each member a union may be", async () => {
    const capture = await captureOf(`
interface Other { a: string; c: number; }
type Either = Confidential<Secret, ["x"]> | Confidential<Other, ["y"]>;
export default pattern<{ either: Either }>(
  ({ either }) => ({ out: computed(() => either.a) }),
);`);

    expect(capture.either).toEqual(A_ONLY({ confidentiality: ["x", "y"] }));
  });

  it("adds no label to a value that carries none", async () => {
    const capture = await captureOf(`
export default pattern<{ plain: Secret }>(
  ({ plain }) => ({ out: computed(() => plain.a) }),
);`);

    expect(capture.plain).toEqual(A_ONLY());
  });
});
