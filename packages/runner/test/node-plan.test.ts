import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { Node, Pattern } from "../src/builder/types.ts";
import { type Cell, cellTx } from "../src/cell.ts";
import { parseLink } from "../src/link-utils.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { NodePlan } from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { getTransactionReadActivities } from "../src/storage/transaction-inspection.ts";

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
    const plans: NodePlan[] = [];
    try {
      for (const node of compiled.nodes) {
        const plan = runtime.runner.accessForTestingOnly.nodePlan(
          tx,
          node,
          resultCell as Cell<any>,
          compiled,
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

  describe("of a node planned before", () => {
    // The runner keeps what binding a node produces and resolves what the
    // bound outputs redirect to on every plan. Each case plans the lift of a
    // running instance twice, in two transactions, the way a pre-sync and
    // then an instantiation plan it.

    let compiled: Pattern;
    let resultCell: Cell<any>;
    let lift: Node;

    /** Plans `node` in `tx`, on the result cell bound to it. */
    function planIn(
      tx: IExtendedStorageTransaction,
      node: Node = lift,
    ): NodePlan {
      return runtime.runner.accessForTestingOnly.nodePlan(
        tx,
        node,
        resultCell.withTx(tx),
        compiled,
      )!;
    }

    /** The addresses `tx` has read, in the order it read them. */
    function readsOf(tx: IExtendedStorageTransaction): string[] {
      return [...getTransactionReadActivities(tx)].map((read) =>
        `${read.space} ${read.scope} ${read.id} ${read.type} ` +
        JSON.stringify(read.path)
      );
    }

    beforeEach(async () => {
      compiled = await runtime.patternManager.compilePattern(PROGRAM, {
        space,
      });
      resultCell = runtime.getCell(space, "node plan planned before");
      const running = await runtime.runSynced(resultCell, compiled, {
        seed: 1,
        items: [{ n: 1 }],
        count: 0,
      });
      await running.pull();
      await runtime.idle();
      // The lift on the root: the JavaScript node with no `$event` slot.
      lift = compiled.nodes.find((node) => {
        const tx = runtime.edit();
        try {
          const plan = planIn(tx, node);
          return plan.kind === "javascript" &&
            !(isObjectOrArray(plan.inputs) && "$event" in plan.inputs);
        } finally {
          tx.abort("node plans: read-only");
        }
      })!;
    });

    it("returns the bindings of the earlier plan, with its inputs cell on its own transaction", () => {
      const firstTx = runtime.edit();
      const secondTx = runtime.edit();
      try {
        const first = planIn(firstTx);
        const second = planIn(secondTx);
        if (first.kind !== "javascript" || second.kind !== "javascript") {
          throw new Error("unreachable");
        }

        expect(second.inputs).toBe(first.inputs);
        expect(second.outputs).toBe(first.outputs);
        expect(second.inputsCell.getAsNormalizedFullLink().id).toBe(
          first.inputsCell.getAsNormalizedFullLink().id,
        );
        expect(cellTx(first.inputsCell)).toBe(firstTx);
        expect(cellTx(second.inputsCell)).toBe(secondTx);
      } finally {
        firstTx.abort("node plans: read-only");
        secondTx.abort("node plans: read-only");
      }
    });

    it("reads through its transaction what a first plan of the node reads", () => {
      // A fresh runtime's first plan of a node computes its bindings; this
      // runtime's later plans do not. Both resolve the outputs through the
      // transaction they are made in, so both transactions record the same
      // reads.

      const laterTx = runtime.edit();
      let later: string[];
      try {
        planIn(laterTx);
        later = readsOf(laterTx);
      } finally {
        laterTx.abort("node plans: read-only");
      }
      runtime.runner.accessForTestingOnly.forgetNodeBindings();
      const firstTx = runtime.edit();
      let first: string[];
      try {
        planIn(firstTx);
        first = readsOf(firstTx);
      } finally {
        firstTx.abort("node plans: read-only");
      }

      expect(later.length).toBeGreaterThan(0);
      expect(later).toEqual(first);
    });

    it("follows a redirect its transaction holds at an output the earlier plan found none at", () => {
      const firstTx = runtime.edit();
      let output: NodePlan["writes"][number];
      try {
        const first = planIn(firstTx);
        expect(first.writes.length).toBe(1);
        [output] = first.writes;
      } finally {
        firstTx.abort("node plans: read-only");
      }

      const secondTx = runtime.edit();
      try {
        const elsewhere = runtime.getCell(
          space,
          "node plan redirect target",
          undefined,
          secondTx,
        );
        runtime.getCellFromLink(output, undefined, secondTx).setRaw(
          elsewhere.getAsWriteRedirectLink(),
        );
        const second = planIn(secondTx);

        expect(second.writes.map((link) => link.id)).toEqual([
          output.id,
          elsewhere.getAsNormalizedFullLink().id,
        ]);
      } finally {
        secondTx.abort("node plans: read-only");
      }
    });
  });
});
