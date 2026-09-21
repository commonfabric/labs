import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { isObjectOrArray } from "@commonfabric/utils/types";

import {
  parseGeneratedCellIdentity,
  prepareGeneratedCellIdentity,
} from "../src/builder/pattern-metadata.ts";
import type { Cell } from "../src/cell.ts";
import { parseLink } from "../src/link-utils.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { NodePlan } from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("node plan");
const space = signer.did();

// One node of each kind a pattern graph holds: a lift (a JavaScript action),
// a handler (a JavaScript handler), a `map` (a raw builtin reached through a
// ref), and a nested pattern.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { handler, lift, pattern, type Writable } from 'commonfabric';",
      "const scale = lift((n: number) => n * 10);",
      "const inner = pattern<{ n: number }>(({ n }) => {",
      "  return { scaled: scale(n) };",
      "});",
      "const bump = handler<unknown, { count: Writable<number> }>(",
      "  (_event, { count }) => { count.set(count.get() + 1); },",
      ");",
      "export default pattern<{",
      "  seed: number; items: { n: number }[]; count: number;",
      "}>(({ seed, items, count }) => {",
      "  const child = inner({ n: seed });",
      "  return {",
      "    tenfold: scale(seed),",
      "    value: child.scaled,",
      "    doubled: items.map((item) => ({ value: item.n * 2 })),",
      "    bump: bump({ count }),",
      "  };",
      "});",
    ].join("\n"),
  }],
};

describe("Runner node plans", () => {
  let storageManager: StorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("derives every node kind, and the child a pattern node instantiated", async () => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const resultCell = runtime.getCell(space, "node plan instance");
    const running = await runtime.runSynced(resultCell, compiled, {
      seed: 1,
      items: [{ n: 1 }, { n: 2 }],
      count: 0,
    });
    await running.pull();
    await runtime.idle();
    expect(running.key("tenfold").get()).toBe(10);
    expect(running.key("value").get()).toBe(10);

    const tx = runtime.edit();
    const instance = prepareGeneratedCellIdentity(
      compiled,
      parseGeneratedCellIdentity(
        resultCell.withTx(tx).getMetaRaw("generatedCellIdentity"),
      )!,
    );
    const plans: NodePlan[] = [];
    try {
      for (const node of compiled.nodes) {
        const plan = runtime.runner.accessForTestingOnly.nodePlan(
          tx,
          node,
          resultCell as Cell<any>,
          instance,
        );
        if (plan !== undefined) plans.push(plan);
      }
    } finally {
      tx.abort("node plans: read-only");
    }

    const byKind = (kind: NodePlan["kind"]) =>
      plans.filter((plan) => plan.kind === kind);
    // The lift and the handler.
    expect(byKind("javascript").length).toBe(2);
    expect(byKind("raw").length).toBe(1);
    expect(byKind("pattern").length).toBe(1);

    // A JavaScript node reads through links into the argument document, and
    // each such link carries the schema its binding declared. The lift
    // writes its derived cell; the handler writes nothing statically.
    const isHandler = (plan: NodePlan) =>
      isObjectOrArray(plan.inputs) && "$event" in plan.inputs;
    const lift = byKind("javascript").find((plan) => !isHandler(plan))!;
    const bump = byKind("javascript").find(isHandler)!;
    const liftInput = parseLink(lift.inputs, resultCell);
    const handlerInputs = bump.inputs as {
      $ctx: { count: unknown };
      $event: unknown;
    };
    const countInput = parseLink(handlerInputs.$ctx.count, resultCell);
    const eventInput = parseLink(handlerInputs.$event, resultCell);
    expect(liftInput?.path).toEqual(["seed"]);
    expect(lift.writes.length).toBe(1);
    expect(countInput?.path).toEqual(["count"]);
    expect(eventInput?.path).toEqual([]);
    expect(bump.writes).toEqual([]);
    expect(liftInput?.schema).toBeDefined();
    expect(countInput?.schema).toBeDefined();

    // The raw node is the list coordinator, with the immutable inputs
    // document the builtin reads from and the output spot it is keyed on.
    const [raw] = byKind("raw");
    if (raw.kind !== "raw") throw new Error("unreachable");
    expect(raw.moduleRefName).toBe("map");
    // The inputs document holds the bound bindings: its `list` slot names the
    // same document the binding does.
    const inputsValue = raw.inputsCell.getRaw() as { list: unknown };
    const boundInputs = raw.inputs as { list: unknown };
    expect(parseLink(inputsValue.list, raw.inputsCell)?.id).toBe(
      parseLink(boundInputs.list, resultCell)?.id,
    );
    expect(raw.writes.length).toBeGreaterThan(0);
    expect(
      raw.writes.some((link) => link.id === raw.resolvedOutputSpot?.id),
    ).toBe(true);

    // The pattern node's plan derives the result cell its instantiation
    // minted: the child is registered as a running piece under that id.
    const [nested] = byKind("pattern");
    if (nested.kind !== "pattern") throw new Error("unreachable");
    expect(nested.sendToBindings).toBe(true);
    const childId = nested.childResultCell?.getAsNormalizedFullLink().id;
    expect(childId).toBeDefined();
    const runningIds = [...runtime.runner.cancels.keys()];
    expect(runningIds.some((key) => key.endsWith(`/${childId}`))).toBe(true);
    expect(nested.child.nodes.length).toBe(1);
  });
});
