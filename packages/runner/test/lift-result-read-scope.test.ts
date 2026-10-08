import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { type Cell, createCell } from "../src/cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("lift result read scope");
const space = signer.did();

describe("runner", () => {
  describe("a lift's result whose schema declares no scope", () => {
    // The transformer declares no scope on a lift's result whose type its
    // author did not write. The runtime stores such a result at the narrowest
    // scope its callback reads, however the read reaches the scoped value.

    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let tx: IExtendedStorageTransaction;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      tx = runtime.edit();
    });

    afterEach(async () => {
      await runtime.dispose();
      await storageManager.close();
    });

    /** A cell at `name` in `scope`, holding `value`. */
    const scopedCell = <T>(
      name: string,
      value: T,
      scope: "space" | "user" | "session",
    ): Cell<T> => {
      const base = runtime.getCell<T>(space, name, undefined, tx);
      const cell = scope === "space" ? base : createCell<T>(
        runtime,
        { ...base.getAsNormalizedFullLink(), scope },
        tx,
      );
      cell.set(value);
      return cell;
    };

    /**
     * The scope of the cell that holds `cell`'s value, at the end of the links
     * from it, and the value read through them.
     */
    const storedAt = (cell: Cell<unknown>) => {
      let scope: string | undefined;
      for (let current = cell, hop = 0; hop < 5; hop++) {
        const link = parseLink(current.getRaw(), current);
        if (!link) break;
        scope = link.scope;
        current = runtime.getCellFromLink(link) as Cell<unknown>;
      }
      return { scope, value: cell.get() };
    };

    /** Runs `root` on `input` and settles it. */
    const run = async (root: unknown, input: unknown, name: string) => {
      const resultCell = runtime.getCell(space, name, undefined, tx);
      // deno-lint-ignore no-explicit-any
      const result = runtime.run(tx, root as any, input as any, resultCell);
      await tx.commit().settled;
      await runtime.idle();
      await runtime.storageManager.synced();
      await result.pull();
      // deno-lint-ignore no-explicit-any
      return result as any;
    };

    it("stores the result at the user scope of the input it reads", async () => {
      const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
      const add = lift((x: number) => x + 1, { type: "number" }, {
        type: "number",
      });
      const result = await run(
        pattern<{ s: number }>(({ s }) => ({ a: add(s) })),
        { s: scopedCell("one input", 41, "user") },
        "one lift",
      );

      expect(storedAt(result.key("a"))).toEqual({ scope: "user", value: 42 });
    });

    it("stores at the user scope each of two results read from one user-scoped input", async () => {
      // The second read of the input in the transaction may be served from
      // its read cache, which records no read of its own.
      const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
      const add = lift((x: number) => x + 1, { type: "number" }, {
        type: "number",
      });
      const double = lift((x: number) => x * 2, { type: "number" }, {
        type: "number",
      });
      const result = await run(
        pattern<{ s: number }>(({ s }) => ({ a: add(s), b: double(s) })),
        { s: scopedCell("shared input", 41, "user") },
        "two lifts",
      );

      expect(storedAt(result.key("a"))).toEqual({ scope: "user", value: 42 });
      expect(storedAt(result.key("b"))).toEqual({ scope: "user", value: 82 });
    });

    it("stores the result at the user scope of a value it reaches through a space-scoped object", async () => {
      const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
      const holder = runtime.getCell<{ inner: number }>(
        space,
        "holder",
        undefined,
        tx,
      );
      holder.set({
        inner: scopedCell("held", 41, "user") as unknown as number,
      });
      const read = lift(
        (x: { inner: number }) => x.inner + 1,
        {
          type: "object",
          properties: { inner: { type: "number" } },
          required: ["inner"],
        } as const,
        { type: "number" },
      );
      const result = await run(
        pattern<{ h: { inner: number } }>(({ h }) => ({ a: read(h) })),
        { h: holder },
        "through an object",
      );

      expect(storedAt(result.key("a"))).toEqual({ scope: "user", value: 42 });
    });

    it("stores at the user scope a result read from another lift's user-scoped result", async () => {
      const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
      const add = lift((x: number) => x + 1, { type: "number" }, {
        type: "number",
      });
      const double = lift((x: number) => x * 2, { type: "number" }, {
        type: "number",
      });
      const result = await run(
        pattern<{ s: number }>(({ s }) => ({ a: double(add(s)) })),
        { s: scopedCell("chained input", 41, "user") },
        "chain",
      );

      expect(storedAt(result.key("a"))).toEqual({ scope: "user", value: 84 });
    });

    it("stores at the user scope an object result built from user-scoped data", async () => {
      const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
      const tag = lift((x: number) => ({ v: x, k: 1 }), { type: "number" }, {
        type: "object",
        properties: { v: { type: "number" }, k: { type: "number" } },
      });
      const result = await run(
        pattern<{ s: number }>(({ s }) => ({ a: tag(s) })),
        { s: scopedCell("object input", 41, "user") },
        "object result",
      );

      expect(storedAt(result.key("a"))).toEqual({
        scope: "user",
        value: { v: 41, k: 1 },
      });
    });

    it("stores the result at the session scope of the input it reads", async () => {
      const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
      const add = lift((x: number) => x + 1, { type: "number" }, {
        type: "number",
      });
      const result = await run(
        pattern<{ s: number }>(({ s }) => ({ a: add(s) })),
        { s: scopedCell("session input", 41, "session") },
        "session",
      );

      expect(storedAt(result.key("a"))).toEqual({
        scope: "session",
        value: 42,
      });
    });

    it("stores at the space scope a result read only from space-scoped data", async () => {
      const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
      const add = lift((x: number) => x + 1, { type: "number" }, {
        type: "number",
      });
      const result = await run(
        pattern<{ s: number }>(({ s }) => ({ a: add(s) })),
        { s: scopedCell("space input", 41, "space") },
        "space",
      );

      expect(storedAt(result.key("a"))).toEqual({ scope: "space", value: 42 });
    });

    it("stores at the user scope the result of a compiled generic lift whose parameter two wrappers of one scope type", async () => {
      // The parameter's schema is its payload's in the user scope; the
      // compiled lift reads the input through it.
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { lift, pattern, type PerUser } from 'commonfabric';",
            "const helper = lift(",
            "  <T extends string>(r: PerUser<T> & PerUser<T>) => r,",
            ");",
            "export default pattern<{ r: string }, { out: string }>(",
            "  ({ r }) => ({ out: helper(r) }),",
            ");",
          ].join("\n"),
        }],
      }, { space });
      const result = await run(
        compiled,
        { r: scopedCell("generic input", "hello", "user") },
        "generic lift",
      );

      expect(storedAt(result.key("out"))).toEqual({
        scope: "user",
        value: "hello",
      });
    });
  });
});
