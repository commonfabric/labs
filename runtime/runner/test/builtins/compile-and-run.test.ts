import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { CompilerError } from "@commonfabric/js-compiler/errors";
import type { BuiltInCompileAndRunParams } from "commonfabric";

import type { Pattern } from "../../src/builder/types.ts";
import { compileAndRun } from "../../src/builtins/compile-and-run.ts";
import type { Cell } from "../../src/cell.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("compile-and-run local");
const space = signer.did();

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: "export default 1;" }],
};

const SECOND_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: "export default 2;" }],
};

/** The cells the builtin announces. */
type Outputs = {
  pending: Cell<boolean>;
  result: Cell<unknown>;
  error: Cell<string | undefined>;
  errors: Cell<unknown>;
};

describe("compile-and-run", () => {
  // These cases run the builtin off the server-execution flag, where the
  // compile runs in the process that ran the action. Each replaces the
  // compiler with compilations it settles by hand.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let created: Cell<unknown>[];
  let compilations: Array<PromiseWithResolvers<Pattern>>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    created = [];
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      pieceCreatedCallback: (piece) => created.push(piece),
    });
    compilations = [];
    runtime.patternManager.compileOrGetPattern = () => {
      const compilation = Promise.withResolvers<Pattern>();
      compilations.push(compilation);
      return compilation.promise;
    };
  });

  afterEach(async () => {
    for (const compilation of compilations) {
      compilation.reject(new Error("test teardown"));
    }
    await runtime.dispose();
    await storageManager.close();
  });

  /** Builds a node and returns its action, its outputs, and its stop. */
  function node(name: string) {
    const inputs = runtime.getCell<BuiltInCompileAndRunParams<unknown>>(
      space,
      `${name}-inputs`,
    );
    const parent = runtime.getCell(space, `${name}-parent`);
    let outputs: Outputs | undefined;
    const cancels: Array<() => void> = [];
    const { action } = compileAndRun(
      inputs,
      (_tx, announced: Outputs) => outputs = announced,
      (cancel) => cancels.push(cancel),
      name,
      parent,
      runtime,
    );
    return {
      async run(program: RuntimeProgram) {
        const tx = runtime.edit();
        inputs.withTx(tx).set(program);
        action(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
      },
      stop: () => cancels.forEach((cancel) => cancel()),
      get outputs(): Outputs {
        if (outputs === undefined) throw new Error("nothing was announced");
        return outputs;
      },
    };
  }

  /** Lets every write a settled compilation started land. */
  async function drain() {
    await clock.settle();
    await runtime.idle();
  }

  function childPattern() {
    return createTrustedBuilder(runtime).commonfabric.pattern(() => ({
      answer: 1,
    }));
  }

  describe("a failed compilation", () => {
    it("records a compiler error's diagnostics on `errors`, placing an unlocated one at 1:1", async () => {
      const n = node("compiler-error");
      await n.run(PROGRAM);
      expect(n.outputs.pending.get()).toBe(true);

      compilations[0].reject(
        new CompilerError([
          {
            message: "located",
            type: "ERROR",
            file: "/main.tsx",
            line: 2,
            column: 5,
          },
          { message: "unlocated", type: "ERROR" },
        ]),
      );
      const errors = await waitForCellValue(
        runtime,
        n.outputs.errors,
        (value) => value !== undefined,
      );
      expect(errors).toEqual([
        {
          line: 2,
          column: 5,
          message: "located",
          type: "ERROR",
          file: "/main.tsx",
        },
        { line: 1, column: 1, message: "unlocated", type: "ERROR" },
      ]);
      await waitForCellValue(runtime, n.outputs.pending, (value) => !value);
      expect(n.outputs.error.get()).toBeUndefined();
    });

    it("records any other failure's message and stack on `error`", async () => {
      const n = node("plain-error");
      await n.run(PROGRAM);
      const failure = new Error("the compiler fell over");

      compilations[0].reject(failure);
      const error = await waitForCellValue(
        runtime,
        n.outputs.error,
        (value) => value !== undefined,
      );
      expect(error).toBe(`${failure.message}\n${failure.stack}`);
      await waitForCellValue(runtime, n.outputs.pending, (value) => !value);
      expect(n.outputs.errors.get()).toBeUndefined();
    });

    it("writes nothing for the failure of a compilation a newer program superseded", async () => {
      const n = node("superseded-failure");
      await n.run(PROGRAM);
      await n.run(SECOND_PROGRAM);
      expect(compilations).toHaveLength(2);

      compilations[0].reject(new Error("the superseded compilation failed"));
      await drain();
      expect(n.outputs.error.get()).toBeUndefined();
      expect(n.outputs.errors.get()).toBeUndefined();
      expect(n.outputs.pending.get()).toBe(true);
    });

    it("writes no failure for a compilation stopped before it failed, and clears `pending`", async () => {
      const n = node("stopped-failure");
      await n.run(PROGRAM);
      n.stop();

      compilations[0].reject(new Error("the stopped compilation failed"));
      await drain();
      expect(n.outputs.error.get()).toBeUndefined();
      expect(n.outputs.errors.get()).toBeUndefined();
      expect(n.outputs.pending.get()).toBe(false);
    });
  });

  describe("a finished compilation", () => {
    it("runs no pattern for a compilation a newer program superseded", async () => {
      const n = node("superseded-success");
      await n.run(PROGRAM);
      await n.run(SECOND_PROGRAM);

      compilations[0].resolve(childPattern());
      await drain();
      expect(created).toEqual([]);
      expect(n.outputs.result.get()).toBeUndefined();
    });

    it("runs no pattern for a compilation stopped before it finished", async () => {
      const n = node("stopped-success");
      await n.run(PROGRAM);
      n.stop();

      compilations[0].resolve(childPattern());
      await drain();
      expect(created).toEqual([]);
      expect(n.outputs.result.get()).toBeUndefined();
    });

    it("runs the pattern of the current compilation", async () => {
      const n = node("current-success");
      await n.run(PROGRAM);

      compilations[0].resolve(childPattern());
      await drain();
      expect(created).toHaveLength(1);
      const shown = await waitForCellValue<number>(
        runtime,
        n.outputs.result.key("answer"),
        (value) => value !== undefined,
      );
      expect(shown).toBe(1);
    });
  });

  describe("an incomplete program", () => {
    it("keeps the previous outputs while a program has no files", async () => {
      const n = node("incomplete");
      await n.run({ main: "/missing.tsx", files: PROGRAM.files });
      expect(n.outputs.error.get()).toBe('"/missing.tsx" not found in files');

      await n.run({ main: "/main.tsx", files: [] });
      expect(n.outputs.error.get()).toBe('"/missing.tsx" not found in files');
      expect(compilations).toHaveLength(0);
    });

    it("clears the previous outputs for a program emptied on purpose", async () => {
      const n = node("emptied");
      await n.run({ main: "/missing.tsx", files: PROGRAM.files });
      expect(n.outputs.error.get()).toBe('"/missing.tsx" not found in files');

      await n.run({ main: "", files: [] });
      expect(n.outputs.error.get()).toBeUndefined();
      expect(n.outputs.pending.get()).toBe(false);
    });
  });
});
