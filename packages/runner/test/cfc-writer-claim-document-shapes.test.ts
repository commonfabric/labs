import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { runtimePresets } from "../src/runtime-presets.ts";
import { setCfcImplementationIdentity } from "../src/cfc/trust-authority.ts";
import type { Cell } from "../src/cell.ts";
import type { JSONSchema } from "../src/builder/types.ts";

// A document stores its policy envelope from the schema that defines it: a
// pattern's argument from the pattern's input schema, a created cell from the
// cell's. A writer policy that schema reached where no syntax names the
// writer would leave the document with no stored write restriction at all,
// writable by any handler and by any other code holding WRITE on the space.
// Each such shape must either keep its writer, so that only the named
// handler writes the field, or fail compilation.

const signer = await Identity.fromPassphrase(
  "cfc-writer-claim-document-shapes",
);
const space = signer.did();

/**
 * A program whose default pattern returns `value`, a field protected by
 * `writerA`'s policy, with `setA` and `setB` writing it through `writerA` and
 * through `writerB`, a handler of the same shape that the policy does not
 * name. `head` declares the pattern and its input; `body` binds `value`;
 * `returned` is what the pattern returns, those three by default.
 */
const program = (
  head: string,
  body: string,
  returned = "{ value, setA: writerA({ value }), setB: writerB({ value }) }",
): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
import { type Cfc, computed, type CurrentPrincipal, handler, pattern, type RepresentsCurrentUser, type Stream, Writable, type WriteAuthorizedBy } from "commonfabric";
type Policy = WriteAuthorizedBy<string, typeof writerA>;
type Owned<T, B> = RepresentsCurrentUser<Cfc<WriteAuthorizedBy<T, B>, { ownerPrincipal: CurrentPrincipal }>>;
export const writerA = handler<{ v: string }, { value: Writable<string> }>(
  ({ v }, { value }) => { value.set(v); },
);
export const writerB = handler<{ v: string }, { value: Writable<string> }>(
  ({ v }, { value }) => { value.set(v); },
);
${head}
  ${body}
  return ${returned};
});
`,
  }],
});

/**
 * What became of the policy: compilation failed on the writer it could not
 * read, only the named writer writes the field, or other writers do too.
 */
type Outcome = "refused" | "enforced" | "open";

describe("a writer policy a document's schema reaches", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime(runtimePresets.patternTest({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: {},
    }));
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const outcomeOf = async (
    source: RuntimeProgram,
    name: string,
  ): Promise<Outcome> => {
    const tx = runtime.edit();
    let pattern;
    try {
      pattern = await runtime.patternManager.compilePattern(source, {
        space,
        tx,
      });
    } catch (error) {
      tx.abort();
      expect(String(error)).toContain("could not be read");
      return "refused";
    }
    const cell = runtime.getCell<{ value: string }>(space, name, undefined, tx);
    const running = runtime.run(tx, pattern, {}, cell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await running.pull();
    await runtime.idle();

    const value = running.key("value") as Cell<string>;
    const send = async (stream: "setA" | "setB", v: string) => {
      (running.key(stream) as unknown as { send: (e: unknown) => void }).send({
        v,
      });
      await runtime.idle();
      await running.pull();
      await runtime.idle();
    };
    // Other code holding WRITE on the space, writing the document the field
    // resolves to by its bare link, through a schema that declares nothing.
    const { schema: _schema, ...bare } = value.resolveAsCell()
      .getAsNormalizedFullLink();
    const member = await runtime.editWithRetry((memberTx) => {
      setCfcImplementationIdentity(memberTx, {
        kind: "verified",
        moduleIdentity: "sha256:member-code",
        symbol: "member",
        bindingPath: ["member"],
      });
      runtime.getCellFromLink(bare, { type: "string" } as JSONSchema, memberTx)
        .set("from member code");
    });
    await send("setB", "from writerB");
    const afterOthers = value.get();
    await send("setA", "from writerA");
    expect(value.get()).toBe("from writerA");

    return member.error === undefined || afterOthers === "from member code" ||
        afterOthers === "from writerB"
      ? "open"
      : "enforced";
  };

  it("enforces a policy written on the input's own field", async () => {
    expect(
      await outcomeOf(
        program(
          "export default pattern<{ value: Policy }>((input) => {",
          "const value = input.value;",
        ),
        "direct-field",
      ),
    ).toBe("enforced");
  });

  it("enforces a policy written as a created cell's type argument", async () => {
    expect(
      await outcomeOf(
        program(
          "export default pattern<{ initial: string }>((input) => {",
          'const value = new Writable<Policy>("seed").for("value");',
        ),
        "explicit-cell",
      ),
    ).toBe("enforced");
  });

  const shapes: Record<string, RuntimeProgram> = {
    "a generic alias": program(
      `type Box<T> = { value: T };
export default pattern<Box<WriteAuthorizedBy<string, typeof writerA>>>((input) => {`,
      "const value = input.value;",
    ),
    "an interface's generic base": program(
      `interface Base<T> { value: T }
interface In extends Base<WriteAuthorizedBy<string, typeof writerA>> {}
export default pattern<In>((input) => {`,
      "const value = input.value;",
    ),
    "`Record`": program(
      "export default pattern<{ byId: Record<string, WriteAuthorizedBy<string, typeof writerA>> }>((input) => {",
      'const value = input.byId["k"];',
    ),
    "an index signature": program(
      "export default pattern<{ byId: { [key: string]: WriteAuthorizedBy<string, typeof writerA> } }>((input) => {",
      'const value = input.byId["k"];',
    ),
    "a tuple": program(
      "export default pattern<{ pair: [WriteAuthorizedBy<string, typeof writerA>] }>((input) => {",
      "const value = input.pair[0];",
    ),
    "an owner policy in a generic alias": program(
      `type Box<T> = { value: T };
export default pattern<Box<Owned<string, typeof writerA>>>((input) => {`,
      "const value = input.value;",
    ),
    "a created cell's value": program(
      "export default pattern<{ initial: string }>((input) => {",
      `const seed = "seed" as WriteAuthorizedBy<string, typeof writerA>;
  const value = new Writable(seed).for("value");`,
    ),
  };

  for (const [reach, source] of Object.entries(shapes)) {
    it(`enforces or refuses a policy reached through ${reach}`, async () => {
      expect(await outcomeOf(source, reach)).not.toBe("open");
    });
  }

  it("refuses fresh data an inferred result holds under a writer policy read from its type", async () => {
    // The result document holds that data itself, so it would store no write
    // restriction for it.
    const tx = runtime.edit();
    await expect(
      runtime.patternManager.compilePattern(
        program(
          "export default pattern<{ initial: string }>((input) => {",
          'const value = "seed" as WriteAuthorizedBy<string, typeof writerA>;',
          "{ value }",
        ),
        { space, tx },
      ),
    ).rejects.toThrow("could not be read");
    tx.abort();
  });

  describe("fresh data an inferred result returns under an owner policy", () => {
    // The result document holds that data itself, whatever shape the object
    // returning it takes, so it stores the whole policy or compilation fails.

    for (
      const [shape, body, returned] of [
        [
          "a spread object",
          "",
          '{ ...{ value: "seed" as Owned<string, typeof writerA> } }',
        ],
        [
          "a spread constant",
          'const fresh = { value: "seed" as Owned<string, typeof writerA> };',
          "{ ...fresh }",
        ],
        [
          "a static computed key",
          "",
          '{ box: { ["value"]: "seed" as Owned<string, typeof writerA> } }',
        ],
        [
          "an array spread",
          "",
          '{ list: [...["seed" as Owned<string, typeof writerA>]] }',
        ],
      ] as const
    ) {
      it(`refuses it through ${shape}`, async () => {
        const tx = runtime.edit();
        await expect(
          runtime.patternManager.compilePattern(
            program(
              "export default pattern<{ initial: string }>((input) => {",
              body,
              returned,
            ),
            { space, tx },
          ),
        ).rejects.toThrow("could not be read");
        tx.abort();
      });
    }
  });

  it("refuses a writer an input schema passed through a constant cannot read", async () => {
    // The constant's `toSchema` call defines the argument document, as it
    // would written in place.
    const source: RuntimeProgram = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `/// <cts-enable />
import { handler, pattern, toSchema, Writable, type WriteAuthorizedBy } from "commonfabric";
export const writerA = handler<{ v: string }, { value: Writable<string> }>(
  ({ v }, { value }) => { value.set(v); },
);
type Box<W> = { value: [W][0] };
type In = Box<WriteAuthorizedBy<string, typeof writerA>>;
const schema = toSchema<In>();
export default pattern((input: In) => ({ value: input.value }), schema);
`,
      }],
    };
    const tx = runtime.edit();
    await expect(
      runtime.patternManager.compilePattern(source, { space, tx }),
    ).rejects.toThrow("could not be read");
    tx.abort();
  });

  describe("fresh data a callback's return annotation types", () => {
    // No document the result links to stores the policy: the result document
    // holds the data itself, and stores the policy the annotation declares.

    const annotated = (resultType: string, returned: string) =>
      program(
        `type Box<T> = { value: T };
export default pattern<{ initial: string }>((input): ${resultType} => {`,
        "",
        returned,
      );

    it("stores the whole policy declared through a generic alias, which refuses the pattern's own write", async () => {
      const tx = runtime.edit();
      const pattern = await runtime.patternManager.compilePattern(
        annotated("Box<Owned<string, typeof writerA>>", '{ value: "seed" }'),
        { space, tx },
      );
      const cell = runtime.getCell<{ value: string }>(
        space,
        "annotated-generic-alias",
        undefined,
        tx,
      );
      runtime.run(tx, pattern, {}, cell);
      runtime.prepareTxForCommit(tx);

      expect((await tx.commit()).error?.message).toContain(
        "writeAuthorizedBy requires a trusted verified binding identity at /value",
      );
    });

    it("refuses a policy declared through an index signature", async () => {
      const tx = runtime.edit();
      await expect(
        runtime.patternManager.compilePattern(
          annotated(
            "{ byId: { [key: string]: Owned<string, typeof writerA> } }",
            '{ byId: { k: "seed" } }',
          ),
          { space, tx },
        ),
      ).rejects.toThrow("could not be read");
      tx.abort();
    });
  });

  describe("read in part by a view", () => {
    // A result inferred from the pattern's callback, and a computed's result,
    // read an owner policy from its type, where its writer cannot be read.
    // They leave its owner and its claim naming the current principal out
    // with the writer, since either alone refuses every write against it.

    it("sets up an inferred result returning an owner-protected input, and enforces the policy through it", async () => {
      expect(
        await outcomeOf(
          program(
            "export default pattern<{ value: Owned<string, typeof writerA> }>((input) => {",
            "const value = input.value;",
          ),
          "owner-inferred-result",
        ),
      ).toBe("enforced");
    });

    it("writes the result of a computed that copies an owner-protected value", async () => {
      const tx = runtime.edit();
      const pattern = await runtime.patternManager.compilePattern(
        program(
          "export default pattern<{ value: Owned<string, typeof writerA> }, { copy: string; setA: Stream<{ v: string }> }>((input) => {",
          "const value = input.value;",
          "{ copy: computed(() => value), setA: writerA({ value }) }",
        ),
        { space, tx },
      );
      const cell = runtime.getCell<{ copy: string }>(
        space,
        "owner-computed-copy",
        undefined,
        tx,
      );
      const running = runtime.run(tx, pattern, {}, cell);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await running.pull();
      await runtime.idle();

      (running.key("setA") as unknown as { send: (e: unknown) => void }).send({
        v: "from writerA",
      });
      await runtime.idle();
      await running.pull();
      await runtime.idle();
      expect(running.key("copy").get()).toBe("from writerA");
    });
  });
});
