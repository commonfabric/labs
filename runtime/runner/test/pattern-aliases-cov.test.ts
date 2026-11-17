import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { lift } from "../src/builder/module.ts";
import { connectInputAndOutputs } from "../src/builder/node-utils.ts";
import {
  getTopFrame,
  pattern,
  popFrame,
  pushFrame,
} from "../src/builder/pattern.ts";
import { reactive } from "../src/builder/reactive.ts";
import type { Frame, NodeRef, Pattern } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("pattern aliases");
const space = signer.did();

describe("pattern()", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let frame: Frame;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    frame = pushFrame({
      space,
      generatedIdCounter: 0,
      reactives: new Set(),
      runtime,
    });
  });

  afterEach(async () => {
    popFrame(frame);
    await runtime.dispose();
  });

  describe("a result holding part of an internal cell", () => {
    // `Writable.of()` makes a cell the pattern collects only where the graph
    // reaches it, so a result naming only a part of it leaves its root with
    // no position to be named by.

    it("throws when the cell's root is bound nowhere", () => {
      const { Writable } = createTrustedBuilder(runtime).commonfabric;

      expect(() =>
        pattern(() => {
          const draft = Writable.of({ title: "untitled" });
          return { title: draft.key("title") };
        })
      ).toThrow("Cell not found in pattern aliases");
    });

    it("aliases the part through its root when the root is bound too", () => {
      const { Writable } = createTrustedBuilder(runtime).commonfabric;

      const built = pattern(() => {
        const draft = Writable.of({ title: "untitled" });
        return { title: draft.key("title"), draft };
      });

      expect(built.result).toMatchObject({
        title: { $alias: { partialCause: "draft", path: ["title"] } },
        draft: { $alias: { partialCause: "draft", path: [] } },
      });
    });
  });

  describe("a node whose module is not a module object", () => {
    // Every builder makes a node's module a `Module`, but a node may hold a
    // pattern or a reactive in its place. Nothing can say what such a module
    // writes, so its outputs never take the computed kind and nothing bound
    // into its inputs does either.

    const double = lift((x: number) => x * 2);

    /** Builds a node computing `out` from `{ v }` by `module`. */
    const nodeOf = (module: NodeRef["module"], v: unknown) => {
      const out = reactive<number>();
      const node: NodeRef = {
        module,
        inputs: { v },
        outputs: out,
        frame: getTopFrame(),
      };
      connectInputAndOutputs(node);
      return out;
    };

    const kindOf = (built: Pattern, partialCause: string) =>
      built.derivedInternalCells?.find((descriptor) =>
        descriptor.partialCause === partialCause
      )?.kind;

    it("leaves the node's outputs and its input roots without the computed kind", () => {
      const Inner = pattern<{ v: number }>(({ v }) => ({ v }));

      const built = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, out: nodeOf(Inner, doubled) };
      });

      expect(kindOf(built, "doubled")).toBeUndefined();
      expect(kindOf(built, "out")).toBeUndefined();
    });

    it("gives the computed kind to a lift's outputs and input roots in the same position", () => {
      const built = pattern<{ x: number }>(({ x }) => {
        const doubled = double(x);
        return { doubled, out: nodeOf(lift(({ v }) => v), doubled) };
      });

      expect(kindOf(built, "doubled")).toBe("computed");
      expect(kindOf(built, "out")).toBe("computed");
    });
  });
});
