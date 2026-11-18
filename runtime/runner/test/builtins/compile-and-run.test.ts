import { assert } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema } from "@commonfabric/api";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { Identity } from "@commonfabric/identity";
import {
  isPending,
  unavailableError,
} from "@commonfabric/data-model/availability";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { CompilerError } from "@commonfabric/js-compiler/errors";
import type { BuiltInCompileAndRunParams } from "commonfabric";

import type { Pattern } from "../../src/builder/types.ts";
import { compileAndRun } from "../../src/builtins/compile-and-run.ts";
import { enrollRuntimeOwnedStore } from "../../src/builtins/runtime-owned-store.ts";
import type { Cell } from "../../src/cell.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";
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
  function node(name: string, inputSchema?: JSONSchema) {
    const inputs = runtime.getCell<BuiltInCompileAndRunParams<unknown>>(
      space,
      `${name}-inputs`,
      inputSchema === undefined
        ? undefined
        : { type: "object", properties: { input: inputSchema } },
    );
    const parent = runtime.getCell(space, `${name}-parent`);
    const binding = runtime.getCell<unknown>(space, `${name}-binding`);
    // These stand in for the node input and output documents that piece setup
    // normally enrolls. This fixture invokes the builtin without that setup.
    const enrollment = runtime.edit();
    enrollRuntimeOwnedStore(enrollment, parent, inputs);
    enrollRuntimeOwnedStore(enrollment, parent, binding);
    enrollment.abort("Fixture stores enrolled");
    let outputs: Outputs | undefined;
    const cancels: Array<() => void> = [];
    const { action } = compileAndRun(
      inputs,
      (tx, announced: Outputs) => {
        outputs = announced;
        binding.withTx(tx).set(announced);
      },
      (cancel) => cancels.push(cancel),
      name,
      parent,
      runtime,
    );
    function stage(
      program: BuiltInCompileAndRunParams<unknown>,
      input = program.input,
    ) {
      const tx = runtime.edit();
      inputs.withTx(tx).set({ ...program, input });
      action(tx);
      return tx;
    }
    return {
      binding,
      stage,
      async run(program: BuiltInCompileAndRunParams<unknown>, input?: unknown) {
        const tx = stage(program, input);
        runtime.prepareTxForCommit(tx);
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
    it("republishes the child binding after its first transaction aborts", async () => {
      const n = node("aborted-binding");
      n.stage(PROGRAM).abort("the first binding was not committed");
      expect(n.binding.getRaw()).toBeUndefined();

      await n.run(PROGRAM);
      compilations[0].resolve(childPattern());
      await drain();

      expect(created).toHaveLength(1);
      expect(n.binding.key("result").key("answer").get()).toBe(1);
    });

    it("runs with a live input without copying its lazy view", async () => {
      const n = node("live-input");
      const source = runtime.getCell<{ value: number }>(space, "live-source");
      await runtime.editWithRetry((tx) => source.withTx(tx).set({ value: 7 }));
      await n.run(PROGRAM, source);
      const pattern = createTrustedBuilder(runtime).commonfabric.pattern<{
        value: number;
      }>(({ value }) => ({ answer: value }));
      compilations[0].resolve(pattern);
      await drain();

      expect(n.outputs.result.key("answer").get()).toBe(7);
      await runtime.editWithRetry((tx) =>
        source.withTx(tx).key("value").set(9)
      );
      await drain();
      expect(n.outputs.result.key("answer").get()).toBe(9);
      expect(compilations).toHaveLength(1);
    });

    it("retains source confidentiality on a compiled child's derived value", async () => {
      await runtime.dispose({ closeStorage: false });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        cfcFlowLabels: "persist",
        pieceCreatedCallback: (piece) => created.push(piece),
      });
      runtime.patternManager.compileOrGetPattern = () => {
        const compilation = Promise.withResolvers<Pattern>();
        compilations.push(compilation);
        return compilation.promise;
      };
      const child = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `
            import { computed, pattern } from "commonfabric";
            export default pattern<{ secret: string }>(({ secret }) => ({
              out: computed(() => secret + "!"),
            }));
          `,
        }],
      }, { space });
      for (const atoms of [[], ["compiled-child-secret"]]) {
        const name = atoms.length ? "classified-child" : "public-child";
        const source = runtime.getCell<{ secret: string }>(
          space,
          `${name}-source`,
        );
        const tx = runtime.edit();
        writeSeedEnvelopeDoc(tx, space);
        seedStoredEnvelope(tx, {
          ...source.getAsNormalizedFullLink(),
          path: [],
        }, {
          value: { secret: "payload" },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{
                path: ["secret"],
                label: { confidentiality: atoms },
                origin: "derived",
              }],
            },
          },
        });
        expect((await tx.commit().settled).error).toBeUndefined();

        const n = node(name);
        await n.run(PROGRAM, source);
        compilations.at(-1)!.resolve(child);
        await drain();
        await n.outputs.result.key("out").pull();
        await drain();
        const output = n.outputs.result.key("out").resolveAsCell();
        expect(output.get()).toBe("payload!");
        const inspection = runtime.edit();
        try {
          const metadata = readStoredCfcMetadata(
            inspection,
            output.getAsNormalizedFullLink(),
          );
          const confidentiality = (metadata?.labelMap.entries ?? []).flatMap(
            (entry) => entry.label.confidentiality ?? [],
          );
          if (atoms.length) {
            expect(confidentiality).toContain("compiled-child-secret");
          } else {
            expect(confidentiality).toEqual([]);
          }
        } finally {
          inspection.abort("Child label inspection complete");
        }
      }
    });

    it("passes nested object and array inputs to the compiled pattern", async () => {
      const n = node("structured-input", {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
            },
          },
        },
        required: ["items"],
      });
      const input = { items: [{ value: 10 }, { value: 20 }] };
      await n.run({ ...PROGRAM, input });

      const { pattern } = createTrustedBuilder(runtime).commonfabric;
      compilations[0].resolve(
        pattern<{ items: { value: number }[] }>(({ items }) => ({ items })),
      );
      await drain();
      const shown = await waitForCellValue(
        runtime,
        n.outputs.result.key("items"),
        (value) => value !== undefined,
      );
      expect(shown).toEqual(input.items);
      expect(created).toHaveLength(1);

      await n.run({ ...PROGRAM, input: { items: [{ value: 30 }] } });
      const updated = await waitForCellValue(
        runtime,
        n.outputs.result.key("items"),
        (value) => Array.isArray(value) && value.length === 1,
      );
      expect(updated).toEqual([{ value: 30 }]);
      expect(compilations).toHaveLength(1);
    });

    it("preserves a special value in a schema-bearing input", async () => {
      const n = node("special-input", {
        type: "object",
        properties: { failure: true },
        required: ["failure"],
      });
      await n.run({
        ...PROGRAM,
        input: { failure: new TypeError("child input") },
      });

      const { pattern } = createTrustedBuilder(runtime).commonfabric;
      compilations[0].resolve(
        pattern<{ failure: unknown }>(({ failure }) => ({ failure })),
      );
      await drain();
      const failure = n.outputs.result.key("failure");
      await waitForCellValue(runtime, failure, (value) => value !== undefined);
      const stored = failure.getRaw({ lastNode: "value" });
      assert(stored instanceof FabricError);
      expect(stored.message).toBe("child input");
      expect(stored.name).toBe("TypeError");
    });

    it("runs no pattern for a compilation a newer program superseded", async () => {
      const n = node("superseded-success");
      await n.run(PROGRAM);
      await n.run(SECOND_PROGRAM);

      compilations[0].resolve(childPattern());
      await drain();
      expect(created).toEqual([]);
      await n.outputs.result.sync();
      expect(isPending(n.outputs.result.get())).toBe(true);
    });

    it("runs no pattern for a compilation stopped before it finished", async () => {
      const n = node("stopped-success");
      await n.run(PROGRAM);
      n.stop();

      compilations[0].resolve(childPattern());
      await drain();
      expect(created).toEqual([]);
      await n.outputs.result.sync();
      expect(isPending(n.outputs.result.get())).toBe(true);
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
    it("reports invalid input instead of a previous compilation failure when a program has no files", async () => {
      const n = node("incomplete");
      await n.run({ main: "/missing.tsx", files: PROGRAM.files });
      expect(n.outputs.error.get()).toBe('"/missing.tsx" not found in files');

      await n.run({ main: "/main.tsx", files: [] });
      expect(n.outputs.error.get()).toBeUndefined();
      expect(n.outputs.result.get()).toEqual(unavailableError(
        "Compilation requires a main entrypoint and files",
        "invalidInput",
      ));
      expect(n.outputs.pending.get()).toBe(false);
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
