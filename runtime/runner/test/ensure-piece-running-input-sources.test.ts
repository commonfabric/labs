import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { ensurePieceRunningVerdict } from "../src/ensure-piece-running.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import { getMetaLink } from "../src/link-utils.ts";
import { setResultCell } from "../src/result-utils.ts";
import { type ExperimentalOptions, Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase(
  "ensure piece running input sources",
);
const space = signer.did();

// A handler a nested pattern defines, whose input the enclosing pattern
// derives: the event's stream belongs to the nested instance, and `doubled`
// is written only by the enclosing instance's `computed`.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, Default, handler, pattern, Stream, Writable } from 'commonfabric';",
      "",
      "type Seen = Writable<number | Default<0>>;",
      "",
      "const record = handler<unknown, { doubled?: number; seen: Seen }>(",
      "  (_event, { doubled, seen }) => {",
      "    seen.set(doubled ?? -1);",
      "  },",
      ");",
      "",
      "const recorder = pattern<",
      "  { doubled?: number; seen: Seen },",
      "  { record: Stream<unknown> }",
      ">(({ doubled, seen }) => ({ record: record({ doubled, seen }) }));",
      "",
      "export default pattern<",
      "  { value: number; seen?: Seen },",
      "  { doubled: number; record: Stream<unknown> }",
      ">(({ value, seen }) => {",
      "  const doubled = computed(() => value * 2);",
      "  const nested = recorder({ doubled, seen: seen! });",
      "  return { doubled, record: nested.record };",
      "});",
    ].join("\n"),
  }],
};

// `PROGRAM` with the nested instance's inputs inside an object of its
// argument, so its argument links to the enclosing instance below the top
// level only.
const NESTED_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, Default, handler, pattern, Stream, Writable } from 'commonfabric';",
      "",
      "type Seen = Writable<number | Default<0>>;",
      "type Inputs = { doubled?: number; seen: Seen };",
      "",
      "const record = handler<unknown, { inputs: Inputs }>(",
      "  (_event, { inputs }) => {",
      "    inputs.seen.set(inputs.doubled ?? -1);",
      "  },",
      ");",
      "",
      "const recorder = pattern<{ inputs: Inputs }, { record: Stream<unknown> }>(",
      "  ({ inputs }) => ({ record: record({ inputs }) }),",
      ");",
      "",
      "export default pattern<",
      "  { value: number; seen?: Seen },",
      "  { doubled: number; record: Stream<unknown> }",
      ">(({ value, seen }) => {",
      "  const doubled = computed(() => value * 2);",
      "  const nested = recorder({ inputs: { doubled, seen: seen! } });",
      "  return { doubled, record: nested.record };",
      "});",
    ].join("\n"),
  }],
};

const ARGUMENT_CAUSE = "input sources argument";
const RESULT_CAUSE = "input sources result";

describe("ensure-piece-running", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtimes: Runtime[];

  const newRuntime = (experimental?: ExperimentalOptions): Runtime => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      ...(experimental !== undefined ? { experimental } : {}),
    });
    runtimes.push(runtime);
    return runtime;
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtimes = [];
  });

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    await storageManager?.close();
  });

  /**
   * Runs `program`'s piece with `value` 1, so the store holds `doubled` 2,
   * then stops it and moves `value` to 5 with nothing running to derive
   * `doubled` again. Returns the nested stream and the enclosing instance's
   * result document.
   */
  const stopAfterInputChanges = async (program: RuntimeProgram) => {
    const first = newRuntime();
    const compiled = await first.patternManager.compilePattern(program, {
      space,
    });
    const argument = first.getCell<{ value: number; seen?: number }>(
      space,
      ARGUMENT_CAUSE,
      compiled.argumentSchema,
    );
    const result = first.getCell<{ doubled: number }>(
      space,
      RESULT_CAUSE,
      compiled.resultSchema,
    );
    {
      const tx = first.edit();
      argument.withTx(tx).set({ value: 1 });
      first.run(tx, compiled, argument, result);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    await result.pull();
    expect(result.get().doubled).toBe(2);
    const stream = result.key("record").resolveAsCell()
      .getAsNormalizedFullLink();
    first.runner.stop(result);
    {
      const tx = first.edit();
      argument.withTx(tx).key("value").set(5);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    await first.idle();
    await first.storageManager.synced();
    return { stream, enclosing: result.getAsNormalizedFullLink() };
  };

  /**
   * A second session, running nothing, takes an event on `stream`. Its
   * handler reads `doubled` through the nested instance's input, which only
   * the enclosing instance writes, and records what it read.
   */
  const seenAfterEvent = async (stream: NormalizedFullLink) => {
    const second = newRuntime();
    second.scheduler.queueEvent(stream, {});
    await second.idle();

    const seen = second.getCell<{ seen?: number }>(
      space,
      ARGUMENT_CAUSE,
      { type: "object", properties: { seen: { type: "number" } } },
    );
    await seen.sync();
    return seen.get().seen;
  };

  it("runs an event's nested handler against the input its enclosing piece derives now, not the one it derived last", async () => {
    const { stream } = await stopAfterInputChanges(PROGRAM);

    expect(await seenAfterEvent(stream)).toBe(10);
  });

  it("runs a nested handler against the input its enclosing piece derives now when the argument links to it below the top level", async () => {
    const { stream } = await stopAfterInputChanges(NESTED_PROGRAM);

    expect(await seenAfterEvent(stream)).toBe(10);
  });

  it("starts only the stream's own piece for a client under server execution, whose run of the handler is an echo", async () => {
    const { stream, enclosing } = await stopAfterInputChanges(PROGRAM);

    const client = newRuntime({ serverExecution: true });
    client.scheduler.queueEvent(stream, {});
    await client.idle();

    // The stream's document links back to the nested instance that owns it.
    const owner = getMetaLink(client.getCellFromLink(stream), "result")!;
    expect(client.runner.isRunning(client.getCellFromLink(owner))).toBe(true);
    expect(client.runner.isRunning(client.getCellFromLink(enclosing))).toBe(
      false,
    );
  });

  it("starts no nested piece whose argument's links cannot be read", async () => {
    const { stream, enclosing } = await stopAfterInputChanges(PROGRAM);
    const sync = storageManager.syncCell.bind(storageManager);
    storageManager.syncCell =
      ((cell, options) =>
        cell.getAsNormalizedFullLink().id === enclosing.id
          ? Promise.reject(new Error("the store refused the read"))
          : sync(cell, options)) as typeof storageManager.syncCell;

    const second = newRuntime();
    const verdict = await ensurePieceRunningVerdict(second, stream, {
      startInputSources: true,
    });

    expect(verdict.started).toBe(false);
  });

  it("starts a source behind a document of the owner's own id in another scope", async () => {
    const first = newRuntime();
    const compiled = await first.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const sourceArgument = first.getCell<{ value: number }>(
      space,
      "input sources source argument",
      compiled.argumentSchema,
    );
    const source = first.getCell<{ doubled: number }>(
      space,
      "input sources source result",
      compiled.resultSchema,
    );
    const argument = first.getCell<{ value: number }>(
      space,
      ARGUMENT_CAUSE,
      compiled.argumentSchema,
    );
    const result = first.getCell<{ doubled: number }>(
      space,
      RESULT_CAUSE,
      compiled.resultSchema,
    );
    {
      const tx = first.edit();
      sourceArgument.withTx(tx).set({ value: 1 });
      first.run(tx, compiled, sourceArgument, source);
      argument.withTx(tx).set({ value: 1 });
      first.run(tx, compiled, argument, result);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    await result.pull();
    const stream = result.key("record").resolveAsCell()
      .getAsNormalizedFullLink();
    // The nested instance owns the stream. Its argument gains a link to the
    // user-scoped document of the nested instance's own id, which belongs to
    // the source.
    const { root: owner } = await ensurePieceRunningVerdict(first, stream);
    const ownerArgument = first.getCellFromLink(
      getMetaLink(first.getCellFromLink({ ...owner!, path: [] }), "argument")!,
    );
    const sameId = first.getCellFromLink({
      ...owner!,
      scope: "user",
      path: [],
    });
    {
      const tx = first.edit();
      sameId.withTx(tx).set({});
      setResultCell(sameId.withTx(tx), source);
      ownerArgument.withTx(tx).key("other").set(sameId);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    first.runner.stop(source);
    first.runner.stop(result);
    await first.idle();
    await first.storageManager.synced();

    const second = newRuntime();
    const verdict = await ensurePieceRunningVerdict(second, stream, {
      startInputSources: true,
    });

    expect(verdict.started).toBe(true);
    expect(
      second.runner.isRunning(
        second.getCellFromLink(source.getAsNormalizedFullLink()),
      ),
    ).toBe(true);
  });
});
