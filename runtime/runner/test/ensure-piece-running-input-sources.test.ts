import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Cell } from "../src/cell.ts";

import {
  ensurePieceRunningVerdict,
  type OwningRootAddress,
  startWithInputSources,
  type StartWithInputSourcesOptions,
} from "../src/ensure-piece-running.ts";
import { PatternsRoute } from "../src/harness/patterns-route.deno.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import { getMetaLink, parseLink } from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { systemPatternSource } from "../src/pattern-source-scheme.ts";
import {
  getPatternIdentityRef,
  type RunnerStartOptions,
  setPatternSource,
} from "../src/runner.ts";
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

// `PROGRAM` with an instance between the enclosing one and the recorder: the
// recorder's input is what the middle instance derives from what the
// enclosing one derives, so a run with `value` 5 records 11.
const THREE_LEVEL: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, Default, handler, pattern, Stream, Writable } from 'commonfabric';",
      "",
      "type Seen = Writable<number | Default<0>>;",
      "",
      "const record = handler<unknown, { bumped?: number; seen: Seen }>(",
      "  (_event, { bumped, seen }) => {",
      "    seen.set(bumped ?? -1);",
      "  },",
      ");",
      "",
      "const recorder = pattern<",
      "  { bumped?: number; seen: Seen },",
      "  { record: Stream<unknown> }",
      ">(({ bumped, seen }) => ({ record: record({ bumped, seen }) }));",
      "",
      "const middle = pattern<",
      "  { doubled?: number; seen: Seen },",
      "  { record: Stream<unknown> }",
      ">(({ doubled, seen }) => {",
      "  const bumped = computed(() => (doubled ?? 0) + 1);",
      "  const inner = recorder({ bumped, seen });",
      "  return { record: inner.record };",
      "});",
      "",
      "export default pattern<",
      "  { value: number; seen?: Seen },",
      "  { doubled: number; record: Stream<unknown> }",
      ">(({ value, seen }) => {",
      "  const doubled = computed(() => value * 2);",
      "  const between = middle({ doubled, seen: seen! });",
      "  return { doubled, record: between.record };",
      "});",
    ].join("\n"),
  }],
};

// A creator that sets `Child` up as a nested node of its own graph, and makes
// another `Child` from a handler, each from the creator's `label`.
const CREATOR_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, handler, pattern, Writable } from 'commonfabric';",
      "",
      "const Child = pattern<{ label: string }, { shown: string }>(",
      "  ({ label }) => ({ shown: computed(() => label + '!') }),",
      ");",
      "",
      "const spawn = handler<",
      "  unknown,",
      "  { label: string; spawned: Writable<unknown[]> }",
      ">((_event, { label, spawned }) => {",
      "  spawned.push(Child({ label }));",
      "});",
      "",
      "export default pattern<{ name: string }>(({ name }) => {",
      "  const label = computed(() => name + ' label');",
      "  const spawned = new Writable<unknown[]>([]).for('spawned');",
      "  const nested = Child({ label });",
      "  return { nested, spawned, spawn: spawn({ label, spawned }) };",
      "});",
    ].join("\n"),
  }],
};

// A recorder whose only input is a sibling nested instance's output, keeping
// what it records in a writable of its own, so its argument links into the
// instance enclosing them both only through the record of the sibling's
// output.
const SIBLING_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, handler, pattern, Stream, Writable } from 'commonfabric';",
      "",
      "const producer = pattern<{ value: number }, { doubled: number }>(",
      "  ({ value }) => ({ doubled: computed(() => value * 2) }),",
      ");",
      "",
      "const record = handler<",
      "  unknown,",
      "  { doubled?: number; seen: Writable<number> }",
      ">((_event, { doubled, seen }) => {",
      "  seen.set(doubled ?? -1);",
      "});",
      "",
      "const recorder = pattern<",
      "  { doubled?: number },",
      "  { record: Stream<unknown>; seen: number }",
      ">(({ doubled }) => {",
      "  const seen = new Writable<number>(0);",
      "  return { record: record({ doubled, seen }), seen };",
      "});",
      "",
      "export default pattern<",
      "  { value: number },",
      "  { doubled: number; record: Stream<unknown>; seen: number }",
      ">(({ value }) => {",
      "  const sibling = producer({ value });",
      "  const nested = recorder({ doubled: sibling.doubled });",
      "  return { doubled: sibling.doubled, record: nested.record, seen: nested.seen };",
      "});",
    ].join("\n"),
  }],
};

// The same recorder as each row `map` builds from what the enclosing
// instance derives.
const MAP_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, handler, pattern, Stream, Writable } from 'commonfabric';",
      "",
      "const record = handler<",
      "  unknown,",
      "  { doubled?: number; seen: Writable<number> }",
      ">((_event, { doubled, seen }) => {",
      "  seen.set(doubled ?? -1);",
      "});",
      "",
      "const recorder = pattern<",
      "  { doubled?: number },",
      "  { record: Stream<unknown>; seen: number }",
      ">(({ doubled }) => {",
      "  const seen = new Writable<number>(0);",
      "  return { record: record({ doubled, seen }), seen };",
      "});",
      "",
      "export default pattern<",
      "  { value: number },",
      "  { rows: { record: Stream<unknown>; seen: number }[] }",
      ">(({ value }) => {",
      "  const doubled = computed(() => [value * 2]);",
      "  const rows = doubled.map((each) => recorder({ doubled: each }));",
      "  return { rows };",
      "});",
    ].join("\n"),
  }],
};

// `MAP_PROGRAM` with each row in a list of its own, which `flatMap` flattens.
const FLAT_MAP_PROGRAM: RuntimeProgram = {
  ...MAP_PROGRAM,
  files: [{
    ...MAP_PROGRAM.files[0],
    contents: MAP_PROGRAM.files[0].contents.replace(
      "doubled.map((each) => recorder({ doubled: each }))",
      "doubled.flatMap((each) => [recorder({ doubled: each })])",
    ),
  }],
};

// The rows of `MAP_PROGRAM`, built from a list the piece's argument links to.
const LINKED_MAP_PROGRAM: RuntimeProgram = {
  ...MAP_PROGRAM,
  files: [{
    ...MAP_PROGRAM.files[0],
    contents: MAP_PROGRAM.files[0].contents.replace(
      /export default pattern<[\s\S]*$/,
      [
        "export default pattern<",
        "  { list: number[] },",
        "  { rows: { record: Stream<unknown>; seen: number }[] }",
        ">(({ list }) => ({",
        "  rows: list.map((each) => recorder({ doubled: each })),",
        "}));",
      ].join("\n"),
    ),
  }],
};

// A `filter` over what the enclosing instance derives, whose predicate
// instances take each element as their input.
const FILTER_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "",
      "export default pattern<{ value: number }, { rows: number[] }>(",
      "  ({ value }) => {",
      "    const doubled = computed(() => [value * 2]);",
      "    return { rows: doubled.filter((each) => each > 0) };",
      "  },",
      ");",
    ].join("\n"),
  }],
};

// The recorder of `MAP_PROGRAM`, as the branch `ifElse` selects.
const IF_ELSE_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, handler, ifElse, pattern, Stream, Writable } from 'commonfabric';",
      "",
      "const record = handler<",
      "  unknown,",
      "  { doubled?: number; seen: Writable<number> }",
      ">((_event, { doubled, seen }) => {",
      "  seen.set(doubled ?? -1);",
      "});",
      "",
      "const recorder = pattern<",
      "  { doubled?: number },",
      "  { record: Stream<unknown>; seen: number }",
      ">(({ doubled }) => {",
      "  const seen = new Writable<number>(0);",
      "  return { record: record({ doubled, seen }), seen };",
      "});",
      "",
      "export default pattern<{ value: number }>(({ value }) => {",
      "  const doubled = computed(() => value * 2);",
      "  const positive = computed(() => value > 0);",
      "  const chosen = ifElse(",
      "    positive,",
      "    recorder({ doubled }),",
      "    recorder({ doubled: 0 }),",
      "  );",
      "  return { chosen };",
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
   * `doubled` again. With `recordsOrigin`, the enclosing instance records a
   * source origin, as a piece a client installed from a release does.
   * Returns the nested stream and the enclosing instance's result document.
   */
  const stopAfterInputChanges = async (
    program: RuntimeProgram,
    { recordsOrigin = false } = {},
  ) => {
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
      if (recordsOrigin) {
        result.withTx(tx).setMetaRaw(
          "patternSource",
          "system:system/probe/probe.tsx",
          rawMetaWriteAuthorization,
        );
      }
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

  it("declines the start as origin-pending until the origin of the piece its inputs come from is followed", async () => {
    const { stream, enclosing } = await stopAfterInputChanges(PROGRAM, {
      recordsOrigin: true,
    });

    const second = newRuntime();
    const asked: string[] = [];
    let followed = false;
    const originFollowed = (root: OwningRootAddress) => {
      asked.push(root.id);
      return followed;
    };
    const declined = await ensurePieceRunningVerdict(second, stream, {
      startInputSources: true,
      originFollowed,
      propagateErrors: true,
    });

    // The stream's own piece records no origin; the enclosing piece's is the
    // one still owed, and nothing starts until it has been followed.
    expect(declined.started).toBe(false);
    expect(declined.reason).toBe("origin-pending");
    expect(asked).toEqual([enclosing.id]);
    const owner = getMetaLink(second.getCellFromLink(stream), "result")!;
    expect(second.runner.isRunning(second.getCellFromLink(owner))).toBe(false);
    expect(second.runner.isRunning(second.getCellFromLink(enclosing))).toBe(
      false,
    );

    followed = true;
    const started = await ensurePieceRunningVerdict(second, stream, {
      startInputSources: true,
      originFollowed,
      propagateErrors: true,
    });

    expect(started.started).toBe(true);
    expect(second.runner.isRunning(second.getCellFromLink(enclosing))).toBe(
      true,
    );
    expect(second.runner.isRunning(second.getCellFromLink(owner))).toBe(true);
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

  describe("startWithInputSources()", () => {
    /** The synced nested instance behind `stream`, as `runtime` holds it. */
    const nestedOwner = async (
      runtime: Runtime,
      stream: NormalizedFullLink,
    ) => {
      const owner = runtime.getCellFromLink({
        ...getMetaLink(runtime.getCellFromLink(stream), "result")!,
        path: [],
      });
      await owner.sync();
      return owner;
    };

    /** What the nested handler last recorded, as `runtime` reads it. */
    const seenIn = async (runtime: Runtime) => {
      const seen = runtime.getCell<{ seen?: number }>(
        space,
        ARGUMENT_CAUSE,
        { type: "object", properties: { seen: { type: "number" } } },
      );
      await seen.sync();
      return seen.get().seen;
    };

    /**
     * Opens the nested instance that owns `stream` in `opener` through
     * `startWithInputSources()` with `options`, then takes an event on
     * `stream` there, and returns what the open returned, the nested
     * instance, and what the handler recorded.
     */
    const openThenEvent = async (
      opener: Runtime,
      stream: NormalizedFullLink,
      options?: StartWithInputSourcesOptions,
    ) => {
      const owner = await nestedOwner(opener, stream);
      const started = await startWithInputSources(opener, owner, options);
      opener.scheduler.queueEvent(stream, {});
      await opener.idle();
      return { owner, started, seen: await seenIn(opener) };
    };

    /** A runtime whose patterns route serves the sources under `root`. */
    const routedRuntime = (root: string): Runtime => {
      const route = new PatternsRoute(root);
      const runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
        fetch: async (input, init) =>
          await route.serve(
            new Request(
              input instanceof Request ? input.url : input.toString(),
              init,
            ),
          ) ?? new Response("not found", { status: 404 }),
      });
      runtimes.push(runtime);
      return runtime;
    };

    /** How many input-source warnings an open has logged so far. */
    const openWarnings = () =>
      getLogger("ensure-piece-running.open").countsByKey["input-sources"]
        ?.warn ?? 0;

    it("starts the enclosing piece before a nested piece opened on its own, so a later event's handler reads what the enclosing piece derives now", async () => {
      const { stream, enclosing } = await stopAfterInputChanges(PROGRAM);
      const opener = newRuntime();

      const { started, seen } = await openThenEvent(opener, stream);

      expect(seen).toBe(10);
      expect(started).toBe(true);
      expect(opener.runner.isRunning(opener.getCellFromLink(enclosing))).toBe(
        true,
      );
    });

    it("calls the opened piece's start before the enclosing piece runs, with work to wait for that settles once it runs", async () => {
      const { stream, enclosing } = await stopAfterInputChanges(PROGRAM);
      const opener = newRuntime();
      const owner = await nestedOwner(opener, stream);
      const enclosingCell = opener.getCellFromLink(enclosing);
      const start = opener.start.bind(opener);
      let enclosingRanAtStart: boolean | undefined;
      let enclosingRanAtRelease: boolean | undefined;
      opener.start = ((cell, options) => {
        enclosingRanAtStart = opener.runner.isRunning(enclosingCell);
        return start(cell, {
          ...options,
          instantiateAfter: options?.instantiateAfter?.then(() => {
            enclosingRanAtRelease = opener.runner.isRunning(enclosingCell);
          }),
        });
      }) as typeof start;

      const started = await startWithInputSources(opener, owner);

      expect(started).toBe(true);
      expect(enclosingRanAtStart).toBe(false);
      expect(enclosingRanAtRelease).toBe(true);
      expect(opener.runner.isRunning(owner)).toBe(true);
    });

    it("leaves the opened nested piece running when its enclosing piece stops", async () => {
      const { stream, enclosing } = await stopAfterInputChanges(PROGRAM);
      const opener = newRuntime();
      const { owner } = await openThenEvent(opener, stream);

      opener.runner.stop(opener.getCellFromLink(enclosing));
      await opener.idle();

      expect(opener.runner.isRunning(opener.getCellFromLink(enclosing))).toBe(
        false,
      );
      expect(opener.runner.isRunning(owner)).toBe(true);
    });

    it("starts only the opened piece for a client under server execution, whose run of a handler is an echo", async () => {
      const { stream, enclosing } = await stopAfterInputChanges(PROGRAM);
      const opener = newRuntime({ serverExecution: true });

      const { owner, started } = await openThenEvent(opener, stream);

      expect(started).toBe(true);
      expect(opener.runner.isRunning(owner)).toBe(true);
      expect(opener.runner.isRunning(opener.getCellFromLink(enclosing))).toBe(
        false,
      );
    });

    it("starts the opened piece on its own, and warns, where its argument's links cannot be read", async () => {
      const { stream, enclosing } = await stopAfterInputChanges(PROGRAM);
      const sync = storageManager.syncCell.bind(storageManager);
      storageManager.syncCell =
        ((cell, options) =>
          cell.getAsNormalizedFullLink().id === enclosing.id
            ? Promise.reject(new Error("the store refused the read"))
            : sync(cell, options)) as typeof storageManager.syncCell;
      const opener = newRuntime();
      const owner = await nestedOwner(opener, stream);
      const warned = openWarnings();

      const started = await startWithInputSources(opener, owner);

      expect(started).toBe(true);
      expect(opener.runner.isRunning(owner)).toBe(true);
      expect(opener.runner.isRunning(opener.getCellFromLink(enclosing))).toBe(
        false,
      );
      expect(openWarnings()).toBe(warned + 1);
    });

    it("warns where a piece enclosing it two levels up cannot start", async () => {
      const { stream, enclosing } = await stopAfterInputChanges(THREE_LEVEL);
      const opener = newRuntime();
      const owner = await nestedOwner(opener, stream);
      const load = opener.patternManager.loadPatternByIdentity.bind(
        opener.patternManager,
      );
      const enclosingRef = getPatternIdentityRef(
        opener.getCellFromLink(enclosing),
      );
      opener.patternManager.loadPatternByIdentity =
        ((identity, symbol, ...rest) =>
          symbol === enclosingRef?.symbol
            ? Promise.resolve(undefined)
            : load(identity, symbol, ...rest)) as typeof load;
      const warned = openWarnings();

      await startWithInputSources(opener, owner);

      expect(opener.runner.isRunning(opener.getCellFromLink(enclosing))).toBe(
        false,
      );
      expect(openWarnings()).toBe(warned + 1);
    });

    it("warns where a piece that encloses it cannot start", async () => {
      const { stream, enclosing } = await stopAfterInputChanges(PROGRAM);
      const opener = newRuntime();
      const owner = await nestedOwner(opener, stream);
      const load = opener.patternManager.loadPatternByIdentity.bind(
        opener.patternManager,
      );
      const enclosingRef = getPatternIdentityRef(
        opener.getCellFromLink(enclosing),
      );
      opener.patternManager.loadPatternByIdentity =
        ((identity, symbol, ...rest) =>
          symbol === enclosingRef?.symbol
            ? Promise.resolve(undefined)
            : load(identity, symbol, ...rest)) as typeof load;
      const warned = openWarnings();

      const started = await startWithInputSources(opener, owner);

      expect(started).toBe(true);
      expect(opener.runner.isRunning(opener.getCellFromLink(enclosing))).toBe(
        false,
      );
      expect(openWarnings()).toBe(warned + 1);
    });

    it("calls only `start` for a piece that runs already", async () => {
      const { stream } = await stopAfterInputChanges(PROGRAM);
      const opener = newRuntime();
      const owner = await nestedOwner(opener, stream);
      await opener.start(owner);
      const walked: string[] = [];
      const sync = storageManager.syncCell.bind(storageManager);
      storageManager.syncCell = ((cell, options) => {
        walked.push(cell.getAsNormalizedFullLink().id);
        return sync(cell, options);
      }) as typeof storageManager.syncCell;

      const calls: (RunnerStartOptions | undefined)[] = [];
      opener.start = ((_cell, options) => {
        calls.push(options);
        return Promise.resolve(true);
      }) as typeof opener.start;

      const started = await startWithInputSources(opener, owner);

      expect(started).toBe(true);
      expect(calls).toEqual([undefined]);
      expect(walked).toEqual([]);
    });

    it("starts the enclosing piece once for two opens of a nested piece at the same time", async () => {
      const { stream, enclosing } = await stopAfterInputChanges(PROGRAM);
      const opener = newRuntime();
      const owner = await nestedOwner(opener, stream);

      const opened = await Promise.all(
        [0, 1].map(() => startWithInputSources(opener, owner)),
      );
      opener.scheduler.queueEvent(stream, {});
      await opener.idle();

      expect(opened).toEqual([true, true]);
      expect(await seenIn(opener)).toBe(10);
      expect(
        [...opener.runner.cancels.keys()].filter((key) =>
          key.endsWith(`/${enclosing.id}`)
        ),
      ).toHaveLength(1);
    });

    /**
     * Runs a piece of `PROGRAM` for each of `names`, with `value` 1, and
     * returns the runtime and their results.
     */
    const stoppedProducers = async (names: string[]) => {
      const first = newRuntime();
      const compiled = await first.patternManager.compilePattern(PROGRAM, {
        space,
      });
      const producers = names.map((name) =>
        first.getCell<{ doubled: number }>(
          space,
          `input sources ${name} result`,
          compiled.resultSchema,
        )
      );
      {
        const tx = first.edit();
        for (const producer of producers) {
          first.run(tx, compiled, { value: 1 }, producer);
        }
        expect((await tx.commit().settled).error).toBeUndefined();
      }
      return { first, producers };
    };

    /**
     * Runs a piece of `CREATOR_PROGRAM`, has its handler make a child, and
     * stops it, and returns the creator, the child its graph sets up, and the
     * child its handler made.
     */
    const stoppedCreator = async () => {
      const first = newRuntime();
      const compiled = await first.patternManager.compilePattern(
        CREATOR_PROGRAM,
        { space },
      );
      const creator = first.getCell<Record<string, unknown>>(
        space,
        "input sources creator",
        undefined,
      );
      {
        const tx = first.edit();
        first.run(tx, compiled, { name: "n" }, creator);
        expect((await tx.commit().settled).error).toBeUndefined();
      }
      await creator.pull();
      await first.idle();
      {
        const tx = first.edit();
        creator.withTx(tx).key("spawn").send({});
        expect((await tx.commit().settled).error).toBeUndefined();
      }
      await first.idle();
      await creator.pull();
      const nestedLink = creator.key("nested").resolveAsCell()
        .getAsNormalizedFullLink();
      const [spawned] = creator.key("spawned").asSchema({
        type: "array",
        items: { type: "unknown", asCell: ["cell"] },
      }).get() as Cell<unknown>[];
      const spawnedLink = spawned.resolveAsCell().getAsNormalizedFullLink();
      // Both children's stored arguments link the creator's `label`.
      expect(spawnedLink.id).not.toBe(nestedLink.id);
      first.runner.stop(creator);
      await first.idle();
      await first.storageManager.synced();
      return { creator, nestedLink, spawnedLink };
    };

    /**
     * The most loads of the documents `ids` names that were under way at
     * once while `run` ran.
     */
    const mostLoadsAtOnce = async (
      ids: readonly string[],
      run: () => Promise<unknown>,
    ) => {
      let loading = 0;
      let most = 0;
      const sync = storageManager.syncCell.bind(storageManager);
      storageManager.syncCell = ((cell, options) => {
        if (!ids.includes(cell.getAsNormalizedFullLink().id)) {
          return sync(cell, options);
        }
        most = Math.max(most, ++loading);
        return sync(cell, options).finally(() => loading--);
      }) as typeof storageManager.syncCell;
      await run();
      return most;
    };

    it("starts the creator of a nested child opened on its own, and not the creator of a child a handler made", async () => {
      const { creator, nestedLink, spawnedLink } = await stoppedCreator();

      for (
        const [child, startsCreator] of [[spawnedLink, false], [
          nestedLink,
          true,
        ]] as const
      ) {
        const opener = newRuntime();
        const opened = opener.getCellFromLink({ ...child, path: [] });
        await opened.sync();

        await startWithInputSources(opener, opened);

        expect(opener.runner.isRunning(opened)).toBe(true);
        expect(
          opener.runner.isRunning(
            opener.getCellFromLink(creator.getAsNormalizedFullLink()),
          ),
        ).toBe(startsCreator);
      }
    });

    it("loads every internal document of a piece the opened piece's inputs come from at once, finding it encloses nothing", async () => {
      // A piece's internal documents hold whatever its graph derives, so a
      // walk that loaded them one after another would wait for each in turn
      // before finding that none of them records the opened piece.
      const { creator, spawnedLink } = await stoppedCreator();
      const manifest = creator.getMetaRaw("internal");
      const internal = (Array.isArray(manifest) ? manifest : []).flatMap(
        (entry) => {
          const link = parseLink(
            (entry as { link?: unknown }).link,
            creator,
          );
          return link === undefined ? [] : [link.id];
        },
      );
      expect(internal.length).toBeGreaterThan(1);
      const opener = newRuntime();
      const opened = opener.getCellFromLink({ ...spawnedLink, path: [] });
      await opened.sync();

      opener.start = () => Promise.resolve(true);

      const most = await mostLoadsAtOnce(
        internal,
        () => startWithInputSources(opener, opened),
      );

      expect(most).toBe(internal.length);
      expect(
        opener.runner.isRunning(
          opener.getCellFromLink(creator.getAsNormalizedFullLink()),
        ),
      ).toBe(false);
    });

    /**
     * The instances a list builtin builds in `runtime` from here on, each
     * with the root of the piece whose graph holds the builtin, which the
     * builtin passes the instance's run as `parentPieceRootId`, in the order
     * they are built.
     */
    const elementsBuiltIn = (runtime: Runtime) => {
      const built: { element: NormalizedFullLink; builder: string }[] = [];
      const runInTransaction = runtime.runner.runInTransaction.bind(
        runtime.runner,
      );
      runtime.runner.runInTransaction = (tx, pattern, input, cell, options) => {
        if (options?.parentPieceRootId !== undefined) {
          built.push({
            element: cell.getAsNormalizedFullLink(),
            builder: options.parentPieceRootId,
          });
        }
        return runInTransaction(tx, pattern, input, cell, options);
      };
      return built;
    };

    /**
     * Runs `program` with `value` 1, then stops it and moves `value` to 5
     * with nothing running, and returns the stream `streamPath` names in its
     * result, the enclosing instance's result, and the result of each
     * instance a list builtin built for an element, in the order they were
     * built.
     */
    const stopProgramAfterInputChanges = async (
      program: RuntimeProgram,
      streamPath: (string | number)[],
    ) => {
      const first = newRuntime();
      const built = elementsBuiltIn(first);
      const compiled = await first.patternManager.compilePattern(program, {
        space,
      });
      const argument = first.getCell<{ value: number }>(
        space,
        ARGUMENT_CAUSE,
        compiled.argumentSchema,
      );
      const result = first.getCell<Record<string, unknown>>(
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
      let streamCell: Cell<unknown> = result;
      for (const segment of streamPath) {
        streamCell = streamCell.key(segment as never);
      }
      const stream = streamCell.resolveAsCell().getAsNormalizedFullLink();
      first.runner.stop(result);
      {
        const tx = first.edit();
        argument.withTx(tx).key("value").set(5);
        expect((await tx.commit().settled).error).toBeUndefined();
      }
      await first.idle();
      await first.storageManager.synced();
      return {
        stream,
        enclosing: result.getAsNormalizedFullLink(),
        elements: built.map(({ element }) => element),
      };
    };

    for (
      const [shape, program, streamPath] of [
        [
          "whose argument links only a sibling's output",
          SIBLING_PROGRAM,
          ["record"],
        ],
        ["that `map` builds as a row", MAP_PROGRAM, ["rows", 0, "record"]],
        [
          "that `flatMap` builds into its output",
          FLAT_MAP_PROGRAM,
          ["rows", 0, "record"],
        ],
        ["that `ifElse` selects", IF_ELSE_PROGRAM, ["chosen", "record"]],
      ] as const
    ) {
      it(`starts the piece enclosing a nested piece ${shape}`, async () => {
        const { stream, enclosing } = await stopProgramAfterInputChanges(
          program,
          [...streamPath],
        );
        const opener = newRuntime();
        const owner = await nestedOwner(opener, stream);

        await startWithInputSources(opener, owner);
        opener.scheduler.queueEvent(stream, {});
        await opener.idle();

        expect(await owner.key("seen" as never).pull()).toBe(10);
        expect(opener.runner.isRunning(opener.getCellFromLink(enclosing)))
          .toBe(true);
      });
    }

    for (
      const [builtin, program, instance] of [
        ["map", MAP_PROGRAM, "row"],
        ["flatMap", FLAT_MAP_PROGRAM, "row"],
        ["filter", FILTER_PROGRAM, "predicate instance"],
      ] as const
    ) {
      it(`starts the piece that built a ${instance} with \`${builtin}\` when the ${instance} itself is opened`, async () => {
        const { enclosing, elements } = await stopProgramAfterInputChanges(
          program,
          [],
        );
        expect(elements.length).toBe(1);
        const opener = newRuntime();
        const element = opener.getCellFromLink({ ...elements[0], path: [] });
        await element.sync();

        await startWithInputSources(opener, element);
        await opener.idle();

        // The instance's input is the element the enclosing piece derives.
        const argument = opener.getCellFromLink(
          getMetaLink(element, "argument")!,
        );
        expect(await argument.key("element" as never).pull()).toBe(10);
        expect(opener.runner.isRunning(element)).toBe(true);
        expect(opener.runner.isRunning(opener.getCellFromLink(enclosing)))
          .toBe(true);
      });
    }

    describe("with the suggestion surface a free-form wish builds", () => {
      // The surface the patterns route serves for the wish: its handler
      // records the `doubled` the wish's context links to.
      const SUGGESTION_SOURCE = [
        "import { handler, pattern, Stream, Writable } from 'commonfabric';",
        "",
        "const record = handler<",
        "  unknown,",
        "  { doubled?: number; seen: Writable<number> }",
        ">((_event, { doubled, seen }) => {",
        "  seen.set(doubled ?? -1);",
        "});",
        "",
        "export default pattern<",
        "  { situation: string; context: { doubled?: number } },",
        "  { record: Stream<unknown>; seen: number }",
        ">(({ context }) => {",
        "  const seen = new Writable<number>(0);",
        "  return { record: record({ doubled: context.doubled, seen }), seen };",
        "});",
      ].join("\n");

      // A piece whose free-form wish passes what it derives as context.
      const WISHER_PROGRAM: RuntimeProgram = {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { computed, pattern, Stream, wish } from 'commonfabric';",
            "",
            "export default pattern<{ value: number }>(({ value }) => {",
            "  const doubled = computed(() => value * 2);",
            "  const found = wish<{ record: Stream<unknown>; seen: number }>({",
            "    query: 'something to find',",
            "    context: { doubled },",
            "  });",
            "  return { found };",
            "});",
          ].join("\n"),
        }],
      };

      let root: string;

      beforeEach(async () => {
        root = await Deno.makeTempDir({ prefix: "input-sources-wish-" });
        await Deno.mkdir(`${root}/system/suggestion`, { recursive: true });
        await Deno.writeTextFile(
          `${root}/system/suggestion/suggestion.tsx`,
          SUGGESTION_SOURCE,
        );
      });

      afterEach(async () => {
        for (const runtime of runtimes) {
          await runtime.sourceReconciler.idle();
          await runtime.patternManager.flushCompileCacheWrites();
        }
        await Deno.remove(root, { recursive: true });
      });

      it("starts the wishing piece before the surface opened on its own, so a later event's handler reads what the wishing piece derives now", async () => {
        const first = routedRuntime(root);
        const compiled = await first.patternManager.compilePattern(
          WISHER_PROGRAM,
          { space },
        );
        const argument = first.getCell<{ value: number }>(
          space,
          ARGUMENT_CAUSE,
          compiled.argumentSchema,
        );
        const result = first.getCell<{ found: unknown }>(
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
        await first.idle();
        // The wish node's output document links the surface's root.
        const slot = first.getCellFromLink(
          parseLink(result.key("found").getRaw(), result)!,
        );
        await slot.pull();
        const surfaceLink = parseLink(slot.getRaw(), slot)!;
        const stream = first.getCellFromLink(surfaceLink).key("record" as never)
          .resolveAsCell().getAsNormalizedFullLink();
        first.runner.stop(result);
        {
          const tx = first.edit();
          argument.withTx(tx).key("value").set(5);
          expect((await tx.commit().settled).error).toBeUndefined();
        }
        await first.idle();
        await first.storageManager.synced();
        const opener = routedRuntime(root);
        const surface = opener.getCellFromLink({ ...surfaceLink, path: [] });
        await surface.sync();

        await startWithInputSources(opener, surface);
        opener.scheduler.queueEvent(stream, {});
        await opener.idle();

        expect(await surface.key("seen" as never).pull()).toBe(10);
        expect(
          opener.runner.isRunning(
            opener.getCellFromLink(result.getAsNormalizedFullLink()),
          ),
        ).toBe(true);
      });
    });

    it("starts the piece that built a row, and neither the piece its list comes from nor a piece linking the row", async () => {
      const first = newRuntime();
      const built = elementsBuiltIn(first);
      const [producerPattern, builderPattern, linkerPattern] = await Promise
        .all(
          [FILTER_PROGRAM, LINKED_MAP_PROGRAM, PROGRAM].map((program) =>
            first.patternManager.compilePattern(program, { space })
          ),
        );
      const [producer, builder, linker] = ["producer", "builder", "linker"]
        .map((name) =>
          first.getCell<Record<string, unknown>>(
            space,
            `input sources ${name} result`,
            undefined,
          )
        );
      {
        const tx = first.edit();
        first.run(tx, producerPattern, { value: 1 }, producer);
        first.run(tx, builderPattern, { list: producer.key("rows") }, builder);
        expect((await tx.commit().settled).error).toBeUndefined();
      }
      await builder.pull();
      const rows = built.filter(({ builder: id }) =>
        id === builder.getAsNormalizedFullLink().id
      );
      expect(rows.length).toBe(1);
      const row = first.getCellFromLink({ ...rows[0].element, path: [] });
      {
        const tx = first.edit();
        first.run(tx, linkerPattern, { value: 1 }, linker);
        expect((await tx.commit().settled).error).toBeUndefined();
      }
      {
        const tx = first.edit();
        first.getCellFromLink(getMetaLink(linker, "argument")!).withTx(tx)
          .key("others").set([row]);
        expect((await tx.commit().settled).error).toBeUndefined();
      }
      for (const piece of [producer, builder, linker]) first.runner.stop(piece);
      await first.idle();
      await first.storageManager.synced();
      const opener = newRuntime();
      const opened = opener.getCellFromLink(row.getAsNormalizedFullLink());
      await opened.sync();

      await startWithInputSources(opener, opened);

      expect(
        [opened, builder, producer, linker].map((piece) =>
          opener.runner.isRunning(
            opener.getCellFromLink(piece.getAsNormalizedFullLink()),
          )
        ),
      ).toEqual([true, true, false, false]);
    });

    /**
     * Runs a hub piece and `count` more of `PROGRAM`, links the others from
     * the hub's argument, and stops them all, and returns the hub, the
     * others, and all of them.
     */
    const stoppedHub = async (count: number) => {
      const others = Array.from({ length: count }, (_, n) => `p${n}`);
      const { first, producers } = await stoppedProducers(["hub", ...others]);
      const [hub, ...linked] = producers;
      {
        const tx = first.edit();
        first.getCellFromLink(getMetaLink(hub, "argument")!).withTx(tx)
          .key("others").set(linked);
        expect((await tx.commit().settled).error).toBeUndefined();
      }
      for (const producer of producers) first.runner.stop(producer);
      await first.idle();
      await first.storageManager.synced();
      return { hub, linked, producers };
    };

    it("starts none of the pieces whose results a hub's argument links to", async () => {
      const { producers } = await stoppedHub(8);

      const opener = newRuntime();
      const [openedHub, ...openedLinked] = producers.map((producer) =>
        opener.getCellFromLink(producer.getAsNormalizedFullLink())
      );
      await openedHub.sync();
      await startWithInputSources(opener, openedHub);

      expect(opener.runner.isRunning(openedHub)).toBe(true);
      expect(openedLinked.map((piece) => opener.runner.isRunning(piece)))
        .toEqual(openedLinked.map(() => false));
    });

    it("loads every document a hub's argument links to at once", async () => {
      // Each linked document is a load, so a walk that loaded them one after
      // another would wait for each in turn.
      const { hub, linked } = await stoppedHub(4);
      const opener = newRuntime();
      const openedHub = opener.getCellFromLink(hub.getAsNormalizedFullLink());
      await openedHub.sync();

      opener.start = () => Promise.resolve(true);

      const most = await mostLoadsAtOnce(
        linked.map((producer) => producer.getAsNormalizedFullLink().id),
        () => startWithInputSources(opener, openedHub),
      );

      expect(most).toBe(linked.length);
    });

    it("reports the failed load of the document a hub's argument names first, even when a later one fails sooner", async () => {
      // The first document's refusal lands a few steps after the second's,
      // so a search that reported whichever failed first would name the
      // second.

      const { hub, linked } = await stoppedHub(2);
      const [first, second] = linked.map((producer) =>
        producer.getAsNormalizedFullLink().id
      );
      const sync = storageManager.syncCell.bind(storageManager);
      storageManager.syncCell = ((cell, options) => {
        const id = cell.getAsNormalizedFullLink().id;
        if (id === second) return Promise.reject(new Error("second refused"));
        if (id !== first) return sync(cell, options);
        let later = Promise.resolve();
        for (let step = 0; step < 10; step++) later = later.then(() => {});
        return later.then(() => {
          throw new Error("first refused");
        });
      }) as typeof storageManager.syncCell;

      const opener = newRuntime();
      const verdict = ensurePieceRunningVerdict(
        opener,
        hub.getAsNormalizedFullLink(),
        { startInputSources: true, propagateErrors: true },
      );

      await expect(verdict).rejects.toThrow("first refused");
    });

    for (const recordsOrigin of [false, true]) {
      it(
        `starts both pieces enclosing a piece nested two deep${
          recordsOrigin ? ", following the outermost one's origin" : ""
        }`,
        async () => {
          const { stream, enclosing } = await stopAfterInputChanges(
            THREE_LEVEL,
            { recordsOrigin },
          );
          const opener = newRuntime();
          const reconciled: string[] = [];
          opener.sourceReconciler.reconcile = (cell) => {
            reconciled.push(cell.getAsNormalizedFullLink().id);
            return Promise.resolve("current");
          };
          const warned = openWarnings();

          const { seen } = await openThenEvent(opener, stream, {
            followOrigins: true,
          });

          expect(seen).toBe(11);
          expect(opener.runner.isRunning(opener.getCellFromLink(enclosing)))
            .toBe(true);
          expect(reconciled).toEqual(recordsOrigin ? [enclosing.id] : []);
          expect(openWarnings()).toBe(warned);
        },
      );
    }

    // The outermost enclosing pattern's module, as the patterns route serves
    // it: the stored one doubles, and the one its origin offers triples. A
    // piece nested two deep records one more than its enclosing piece derives.
    for (
      const { where, program, followed, stored } of [
        { where: "", program: PROGRAM, followed: 15, stored: 10 },
        {
          where: " two levels up",
          program: THREE_LEVEL,
          followed: 16,
          stored: 11,
        },
      ]
    ) {
      describe(`with an enclosing piece${where} whose origin offers another source`, () => {
        const ROUTE_PATH = "/api/patterns/system/input-sources-outer.tsx";
        const outerSource = (factor: number) =>
          program.files[0].contents.replace("value * 2", `value * ${factor}`);
        let root: string;

        beforeEach(async () => {
          root = await Deno.makeTempDir({ prefix: "input-sources-origin-" });
          await Deno.mkdir(`${root}/system`);
          await Deno.writeTextFile(
            `${root}/system/input-sources-outer.tsx`,
            outerSource(3),
          );
        });

        afterEach(async () => {
          for (const runtime of runtimes) {
            await runtime.sourceReconciler.idle();
            await runtime.patternManager.flushCompileCacheWrites();
          }
          await Deno.remove(root, { recursive: true });
        });

        /**
         * `stopAfterInputChanges()` for the stored enclosing source, whose
         * piece records the `system:` origin the route serves.
         */
        const stopAfterInputChangesWithOrigin = async () => {
          const first = routedRuntime(root);
          const compiled = await first.patternManager.compilePattern({
            main: ROUTE_PATH,
            files: [{ name: ROUTE_PATH, contents: outerSource(2) }],
          }, { space });
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
          expect(
            (await first.editWithRetry((tx) => {
              setPatternSource(
                result,
                tx,
                systemPatternSource("system/input-sources-outer.tsx"),
              );
            })).error,
          ).toBeUndefined();
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
          return stream;
        };

        it("follows the enclosing piece's origin before starting it, for an open that follows origins", async () => {
          const stream = await stopAfterInputChangesWithOrigin();

          const { seen } = await openThenEvent(routedRuntime(root), stream, {
            followOrigins: true,
          });

          expect(seen).toBe(followed);
        });

        it("starts the enclosing piece on its stored source for an open that does not follow origins", async () => {
          const stream = await stopAfterInputChangesWithOrigin();

          const { seen } = await openThenEvent(routedRuntime(root), stream);

          expect(seen).toBe(stored);
        });
      });
    }
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
