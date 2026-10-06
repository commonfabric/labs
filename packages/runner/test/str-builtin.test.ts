import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { getVerifiedProvenance } from "../src/harness/verified-provenance.ts";
import type { Module, Pattern } from "../src/builder/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("str builtin");
const space = signer.did();

const programFor = (body: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
import { NAME, pattern, str, Writable, Default } from "commonfabric";
export default pattern<{ who?: Writable<string | Default<"world">> }>(({ who }) => {
  ${body}
});
`,
  }],
});

const programOf = (
  props: string,
  destructure: string,
  body: string,
): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
import { NAME, pattern, str, Writable, Default } from "commonfabric";
export default pattern<${props}>((${destructure}) => {
  ${body}
});
`,
  }],
});

const GREETING = "return { who, greeting: str`Hello, ${who}!` };";

describe("str builtin", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  const newRuntime = () =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    await storageManager?.close();
  });

  const runSource = async (
    runtime: Runtime,
    program: RuntimeProgram,
    label: string,
  ) => {
    const compiled = await runtime.patternManager.compilePattern(program);
    const tx = runtime.edit();
    const resultCell = runtime.getCell<Record<string, unknown>>(
      space,
      label,
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const result = runtime.run(tx, compiled, {}, resultCell) as any;
    await tx.commit().settled;
    await result.pull();
    return { compiled, result };
  };

  const runProgram = (runtime: Runtime, body: string, label: string) =>
    runSource(runtime, programFor(body), label);

  it("interpolates a reactive substitution", async () => {
    const runtime = newRuntime();
    try {
      const { result } = await runProgram(runtime, GREETING, "interpolates");
      expect(result.key("greeting").get()).toBe("Hello, world!");
    } finally {
      await runtime.dispose();
    }
  });

  it("recomputes when a substituted cell changes", async () => {
    const runtime = newRuntime();
    try {
      const { result } = await runProgram(runtime, GREETING, "recomputes");
      expect(result.key("greeting").get()).toBe("Hello, world!");

      const writeTx = runtime.edit();
      result.withTx(writeTx).key("who").set("fabric");
      await writeTx.commit().settled;
      await runtime.idle();
      await result.pull();
      expect(result.key("greeting").get()).toBe("Hello, fabric!");
    } finally {
      await runtime.dispose();
    }
  });

  it("interpolates several substitutions in order", async () => {
    const runtime = newRuntime();
    try {
      const { result } = await runProgram(
        runtime,
        "return { who, greeting: str`a${who}b${who}c` };",
        "several",
      );
      expect(result.key("greeting").get()).toBe("aworldbworldc");
    } finally {
      await runtime.dispose();
    }
  });

  it("returns the template unchanged when it has no substitutions", async () => {
    const runtime = newRuntime();
    try {
      const { result } = await runProgram(
        runtime,
        "return { who, greeting: str`no substitutions` };",
        "no-subs",
      );
      expect(result.key("greeting").get()).toBe("no substitutions");
    } finally {
      await runtime.dispose();
    }
  });

  it("renders a substitution exactly as a native template literal does", async () => {
    const runtime = newRuntime();
    try {
      const { result } = await runProgram(
        runtime,
        "return { who, greeting: str`v=${undefined} ${null} ${{ a: 1 }}` };",
        "native-parity",
      );
      // Authors reach for `str` in place of a template literal, so the
      // rendering rules must not shift underneath them.
      expect(result.key("greeting").get()).toBe(
        `v=${undefined} ${null} ${{ a: 1 }}`,
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("reads a substituted array as its value, not as a link", async () => {
    const runtime = newRuntime();
    try {
      const { result } = await runSource(
        runtime,
        programOf(
          `{
  list?: Writable<string[] | Default<["a", "b"]>>;
  n?: Writable<number | Default<0>>;
  flag?: Writable<boolean | Default<false>>;
}`,
          "{ list, n, flag }",
          "return { list, n, flag, greeting: str`${list} ${n} ${flag}` };",
        ),
        "value-read",
      );
      // An array renders through its own `toString` ("a,b") only if the
      // substitution arrived as a VALUE. `STR_ARGUMENT_SCHEMA` leaves `values`
      // without an `items` schema precisely so its elements resolve; were that
      // to stop, the element would arrive as an unresolved link sigil and
      // render "[object Object]" instead. Numbers and booleans pin the two
      // falsy substitutions the interpolation must not treat as absent.
      expect(result.key("greeting").get()).toBe(`${["a", "b"]} ${0} ${false}`);
    } finally {
      await runtime.dispose();
    }
  });

  it("interpolates per element inside a map", async () => {
    const runtime = newRuntime();
    try {
      const { result } = await runSource(
        runtime,
        programOf(
          `{ items?: Writable<string[] | Default<["a", "b"]>> }`,
          "{ items }",
          "return { items, labels: items.map((item) => str`<${item}>`) };",
        ),
        "map-op",
      );
      // The shape shipped patterns actually use: one `str` node per element,
      // minted inside the map's op sub-pattern rather than at pattern scope.
      expect(result.key("labels").get()).toEqual(["<a>", "<b>"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("compiles to a ref node naming the builtin, leaving no unverified module", async () => {
    const runtime = newRuntime();
    try {
      const { compiled } = await runProgram(runtime, GREETING, "node-shape");
      const nodes = (compiled as Pattern).nodes;

      const strNode = nodes.find((node) => {
        const module = node.module as Module;
        return module.type === "ref" && module.implementation === "str";
      });
      expect(strNode).toBeDefined();

      // Every javascript module the program does carry is registered, so none
      // of them serializes body-only for a reader to re-evaluate as source.
      for (const node of nodes) {
        const module = node.module as Module;
        if (module.type !== "javascript") continue;
        expect(getVerifiedProvenance(module.implementation)).toBeDefined();
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("interpolates after resuming the piece in a cold runtime", async () => {
    const cause = "cold-resume";
    const rt1 = newRuntime();
    const rt2 = newRuntime();
    try {
      const tx1 = rt1.edit();
      const compiled = await rt1.patternManager.compilePattern(
        programFor(GREETING),
        { space, tx: tx1 },
      );
      const resultCell1 = rt1.getCell<Record<string, unknown>>(
        space,
        cause,
        undefined,
        tx1,
      );
      // deno-lint-ignore no-explicit-any
      const r1 = rt1.run(tx1, compiled, {}, resultCell1) as any;
      await tx1.commit().settled;
      await r1.pull();
      expect(r1.key("greeting").get()).toBe("Hello, world!");

      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();

      // A fresh runtime resumes the piece from the PERSISTED graph, where the
      // node carries the builtin's name rather than a live function.
      const tx2 = rt2.edit();
      const resultCell2 = rt2.getCell<Record<string, unknown>>(
        space,
        cause,
        undefined,
        tx2,
      );
      await tx2.commit().settled;
      await resultCell2.sync();
      expect(await rt2.start(resultCell2)).toBe(true);
      await resultCell2.pull();
      expect(
        (resultCell2.getAsQueryResult() as { greeting: string }).greeting,
      ).toBe("Hello, world!");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});
