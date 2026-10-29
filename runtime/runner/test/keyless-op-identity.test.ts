import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  Engine,
  Runtime,
  signer,
  StorageManager,
} from "./engine-test-support.ts";
import type { RuntimeProgram } from "./engine-test-support.ts";

/**
 * A KEYLESS op (no content-addressed entry ref — here, evaluated through the
 * bare, non-registering `Engine.compileAndEvaluateModules`) whose mapped
 * sub-pattern nests a GRANDCHILD exposing a derived-internal computed output.
 *
 * `Runner.#substituteOpPatternRefs` mints the op's `keyless:` content-hash
 * session identity (the same pointer a keyless ROOT pattern gets via
 * `entryRefForPattern`), so the op rides a `$patternRef` to its pristine
 * artifact. Without the mint, such an op would fall back to its embedded
 * pattern graph, whose nested output-alias `defer` levels the immutable-cell
 * JSON round-trip decrements one step too far — the grandchild
 * derived-internal output would then resolve one instantiation level too
 * early (a throw under strict binding, a mis-wire under lenient).
 *
 * The program is a mapped sub-pattern with a derived output, with the
 * traversal result exposed as a readable `rendered` output and the Wrapper
 * exported so the mint itself is observable.
 */

const PROGRAM_SOURCE = `
import {
  computed,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

const isRecord = (v: unknown): v is Record<PropertyKey, unknown> =>
  typeof v === "object" && v !== null;

const read = (v: unknown): unknown =>
  isRecord(v) && typeof v.get === "function" ? (v.get as () => unknown)() : v;

const asArray = (v: unknown): unknown[] => {
  const value = read(v);
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || typeof value === "boolean"
    ? []
    : [value];
};

const childNodes = (node: unknown): unknown[] => {
  const value = read(node);
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  const ui = value[UI];
  return [
    ...(ui === undefined || ui === value ? [] : [ui]),
    ...asArray(value.children),
  ];
};

// Collect leaf string/number values in the rendered tree. Walking the tree is
// what forces the map to materialize each element (instantiate Wrapper + Child).
const leafValues = (root: unknown, depth = 0): string[] => {
  if (depth > 40) return [];
  const value = read(root);
  const kids = childNodes(value);
  if (kids.length === 0) {
    return typeof value === "string" || typeof value === "number"
      ? [String(value)]
      : [];
  }
  const out: string[] = [];
  for (const k of kids) out.push(...leafValues(k, depth + 1));
  return out;
};

interface ChildIn {
  n: number;
}
interface ChildOut {
  [NAME]: string;
  [UI]: VNode;
  doubled: number;
}

// The grandchild: exposes a derived-internal computed OUTPUT ('doubled').
const Child = pattern<ChildIn, ChildOut>(({ n }) => {
  const doubled = computed(() => n * 2);
  return {
    [NAME]: "child",
    [UI]: <div>{doubled}</div>,
    doubled,
  };
});

interface WrapperIn {
  n: number;
}
interface WrapperOut {
  [NAME]: string;
  [UI]: VNode;
}

// The child pattern node nests Child, so Child is a GRANDCHILD of the map op.
const Wrapper = pattern<WrapperIn, WrapperOut>(({ n }) => ({
  [NAME]: "wrapper",
  [UI]: (
    <div>
      <Child n={n} />
    </div>
  ),
}));

export const wrapperOp = Wrapper;

export default pattern(() => {
  const items = new Writable<number[]>([1, 2, 3]);
  const ui = <div>{items.map((n) => <Wrapper n={n} />)}</div>;
  const rendered = computed(() => {
    const values = leafValues(ui);
    return values.includes("2") && values.includes("4") &&
      values.includes("6");
  });
  return {
    [NAME]: "ct-1812-keyless-op",
    [UI]: ui,
    rendered,
  };
});
`;

const program: RuntimeProgram = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: PROGRAM_SOURCE }],
};

describe("keyless op identity", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("runs a ref-less mapped op with a grandchild derived-internal output, minting its keyless identity", async () => {
    // Evaluate WITHOUT registering — the op gets no module-scope entry ref.
    const engine = runtime.harness as Engine;
    const evalResult = await engine.compileAndEvaluateModules(program);
    const main = evalResult.main!;
    const factory = main.default as Parameters<Runtime["run"]>[1];
    const wrapperOp = main.wrapperOp as object;

    // Bare evaluation indexed nothing: the op is keyless going in.
    expect(runtime.patternManager.getArtifactEntryRef(wrapperOp))
      .toBeUndefined();

    const space = signer.did();
    const tx = runtime.edit();
    const resultCell = runtime.getCell<{ rendered: boolean }>(
      space,
      { ct1812: "keyless-op-identity" },
      (factory as { resultSchema?: never }).resultSchema,
      tx,
    );
    const result = runtime.run(tx, factory, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    const commit = await tx.commit().settled;
    expect(commit.error).toBeUndefined();
    const cancel = result.sink(() => {});
    await runtime.idle();

    // The shape works ref-lessly: every grandchild derived-internal output
    // materialized (2, 4, 6 all present), where the embedded-graph fallback
    // would throw "Unknown derived internal cell with partial cause" (strict)
    // or mis-wire (lenient).
    expect(result.key("rendered").get()).toBe(true);

    // And it worked BY IDENTITY: instantiation minted the keyless pointer for
    // the op, so it resolved to the pristine artifact instead of the
    // defer-corrupted embedded graph.
    const minted = runtime.patternManager.getArtifactEntryRef(wrapperOp);
    expect(minted?.identity).toMatch(/^keyless:/);

    cancel();
    await runtime.idle();
  });
});
