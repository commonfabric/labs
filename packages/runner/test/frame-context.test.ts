import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { defer, type Deferred } from "@commonfabric/utils/defer";

import {
  inActionExecution,
  runInActionExecution,
  runInFrameContext,
} from "../src/builder/frame-context.ts";
import {
  getTopFrame,
  popFrame,
  pushFrame,
  pushRuntimeDefaultFrame,
} from "../src/builder/pattern.ts";
import type { Cell, Frame, Pattern } from "../src/builder/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signerA = await Identity.fromPassphrase("frame context A");
const signerB = await Identity.fromPassphrase("frame context B");
const signerC = await Identity.fromPassphrase("frame context C");
const spaceA = signerA.did();
const spaceB = signerB.did();

// A pattern whose body mints an internal cell and binds it into its UI, so the
// space its `$value` link names is the space module evaluation bound it to.
const DRAFT_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { NAME, UI, pattern, Writable } from 'commonfabric';",
      "export default pattern(() => {",
      "  const draft = new Writable('').for('draft');",
      "  return {",
      "    [NAME]: 'draft holder',",
      "    [UI]: <cf-input $value={draft} />,",
      "  };",
      "});",
    ].join("\n"),
  }],
};

// A compiled pattern whose handler reads the ambient clock after an `await`,
// which the sandbox answers only under the handler's own frame.
const ASYNC_CLOCK_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { handler, pattern, Writable } from 'commonfabric';",
      "const stamp = handler<{ go: boolean }, { at: Writable<number> }>(",
      "  async (_event, { at }) => {",
      "    await Promise.resolve();",
      "    at.set(Date.now());",
      "  },",
      ");",
      "export default pattern<{ at: Writable<number> }>(({ at }) => {",
      "  return { at, stamp: stamp({ at }) };",
      "});",
    ].join("\n"),
  }],
};

/** A handler run held open at an `await` until the test releases it. */
type HeldHandler = {
  /** Resolves once the handler body has started. */
  started: Deferred;

  /** Resolving it lets the handler body continue past its `await`. */
  gate: Deferred;

  /** The top frame the body read before its `await`. */
  before?: Frame;

  /** The top frame the body read after its `await`. */
  after?: Frame;
};

/**
 * Helper for the interleaving tests, which runs a piece in `space` whose async
 * handler records the top frame on either side of an `await` on
 * `held.gate`, and sends it one event.
 */
async function sendToHeldHandler(
  runtime: Runtime,
  space: string,
  held: HeldHandler,
): Promise<void> {
  const { commonfabric } = createTrustedBuilder(runtime);
  const { cell, handler, pattern } = commonfabric;
  const wait = handler<{ n: number }, { effects: Cell<{ n: number }> }>(
    true,
    {
      type: "object",
      properties: { effects: { type: "object", asCell: ["cell"] } },
    },
    async (_event, { effects }) => {
      held.before = getTopFrame();
      held.started.resolve();
      await held.gate.promise;
      held.after = getTopFrame();
      effects.key("n").set(1);
    },
  );
  const root = pattern(() => {
    const effects = cell({ n: 0 });
    return { effects, stream: wait({ effects }) };
  });
  const tx = runtime.edit();
  const rootCell = runtime.getCell<{ effects: unknown; stream: unknown }>(
    space as `did:${string}:${string}`,
    `frame context piece ${space}`,
    undefined,
    tx,
  );
  const result = runtime.run(tx, root, {}, rootCell);
  await tx.commit();
  await runtime.idle();
  const streamLink = resolveLink(
    runtime,
    runtime.readTx(),
    result.key("stream").getAsNormalizedFullLink(),
  );
  runtime.scheduler.queueEvent(streamLink, { n: 1 }, true);
  await held.started.promise;
}

/** Returns a handler run not yet started. */
function heldHandler(): HeldHandler {
  return { started: defer(), gate: defer() };
}

/**
 * Helper for the module-evaluation tests, which runs `pattern` in `space` and
 * returns the space its UI's `$value` link names.
 */
async function boundSpace(
  runtime: Runtime,
  space: string,
  pattern: Pattern,
): Promise<string | undefined> {
  const result = runtime.getCell(
    space as `did:${string}:${string}`,
    "frame context result",
  );
  await runtime.runSynced(result, pattern, {});
  const rendered = result.getRaw() as { $UI: { props: { $value: unknown } } };
  return parseLink(rendered.$UI.props.$value, result)?.space;
}

describe("frame-context", () => {
  describe("runInFrameContext()", () => {
    it("hides a frame pushed in the context from code outside it while the context awaits", async () => {
      const gate = defer();
      const pushed = defer<Frame>();
      const run = runInFrameContext(async () => {
        const frame = pushFrame({ cause: "inside" });
        pushed.resolve(frame);
        await gate.promise;
        popFrame(frame);
      });
      const inside = await pushed.promise;
      try {
        expect(getTopFrame()).not.toBe(inside);
      } finally {
        gate.resolve();
        await run;
      }
    });

    it("keeps the context's own frame on top after an `await`, over a frame pushed elsewhere meanwhile", async () => {
      const gate = defer();
      const pushed = defer<Frame>();
      const run = runInFrameContext(async () => {
        const frame = pushFrame({ cause: "inside" });
        pushed.resolve(frame);
        await gate.promise;
        const top = getTopFrame();
        popFrame(frame);
        return { frame, top };
      });
      await pushed.promise;
      const outside = pushFrame({ cause: "outside" });
      try {
        gate.resolve();
        const { frame, top } = await run;
        expect(top).toBe(frame);
      } finally {
        popFrame(outside);
      }
    });

    it("returns the root stack's top while the context's own stack is empty", () => {
      const root = pushFrame({ cause: "root" });
      try {
        expect(runInFrameContext(() => getTopFrame())).toBe(root);
      } finally {
        popFrame(root);
      }
    });
  });

  describe("pushRuntimeDefaultFrame()", () => {
    it("pushes a frame carrying only the runtime onto the root stack, from inside a context", () => {
      const runtime = {} as Runtime;
      const frame = runInFrameContext(() => {
        const action = pushFrame({ cause: "action", space: spaceA });
        const pushed = pushRuntimeDefaultFrame(runtime);
        popFrame(action);
        return pushed;
      });
      try {
        expect(frame.runtime).toBe(runtime);
        expect(frame.space).toBeUndefined();
        expect(frame.tx).toBeUndefined();
        expect(getTopFrame()).toBe(frame);
      } finally {
        popFrame(frame);
      }
    });
  });

  describe("runInActionExecution()", () => {
    it("marks only its own context as executing an action while it awaits", async () => {
      const gate = defer();
      const started = defer();
      const run = runInFrameContext(() =>
        runInActionExecution(async () => {
          started.resolve();
          await gate.promise;
          return inActionExecution();
        })
      );
      await started.promise;
      try {
        expect(inActionExecution()).toBe(false);
      } finally {
        gate.resolve();
      }
      expect(await run).toBe(true);
    });
  });

  describe("interleaving across runtimes", () => {
    let storageA: ReturnType<typeof StorageManager.emulate>;
    let storageB: ReturnType<typeof StorageManager.emulate>;
    let runtimeA: Runtime;
    let runtimeB: Runtime;

    beforeEach(() => {
      storageA = StorageManager.emulate({ as: signerA });
      storageB = StorageManager.emulate({ as: signerB });
      runtimeA = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storageA,
      });
      runtimeB = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storageB,
      });
    });

    afterEach(async () => {
      await runtimeA.dispose();
      await runtimeB.dispose();
      await storageA.close();
      await storageB.close();
    });

    it("binds a module evaluated while a handler of the same runtime awaits to the space it runs in", async () => {
      const held = heldHandler();
      await sendToHeldHandler(runtimeA, spaceB, held);
      let pattern: Pattern;
      try {
        const { main } = await runtimeA.harness.compileAndEvaluateModules(
          DRAFT_PROGRAM,
        );
        pattern = (main as { default: Pattern }).default;
      } finally {
        held.gate.resolve();
      }
      await runtimeA.idle();
      expect(await boundSpace(runtimeA, spaceA, pattern)).toBe(spaceA);
    });

    it("keeps an async handler's own frame on top after it resumes while another runtime's handler awaits", async () => {
      const heldA = heldHandler();
      const heldB = heldHandler();
      await sendToHeldHandler(runtimeA, spaceA, heldA);
      try {
        await sendToHeldHandler(runtimeB, spaceB, heldB);
        heldA.gate.resolve();
        await runtimeA.idle();
      } finally {
        heldA.gate.resolve();
        heldB.gate.resolve();
      }
      await runtimeB.idle();
      expect(heldA.after).toBe(heldA.before);
      expect(heldA.after?.space).toBe(spaceA);
    });

    it("gives a runtime built while another runtime's handler awaits a default frame with no space or transaction", async () => {
      const held = heldHandler();
      await sendToHeldHandler(runtimeA, spaceA, held);
      const storageC = StorageManager.emulate({ as: signerC });
      let runtimeC: Runtime | undefined;
      try {
        runtimeC = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: storageC,
        });
      } finally {
        held.gate.resolve();
      }
      await runtimeA.idle();
      const top = getTopFrame();
      try {
        expect(top?.runtime).toBe(runtimeC);
        expect(top?.space).toBeUndefined();
        expect(top?.tx).toBeUndefined();
      } finally {
        await runtimeC.dispose();
        await storageC.close();
      }
    });

    it("binds a module evaluated after that handler finished to the space it runs in", async () => {
      const held = heldHandler();
      await sendToHeldHandler(runtimeA, spaceA, held);
      const storageC = StorageManager.emulate({ as: signerC });
      let runtimeC: Runtime | undefined;
      try {
        runtimeC = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: storageC,
        });
      } finally {
        held.gate.resolve();
      }
      await runtimeA.idle();
      try {
        const { main } = await runtimeB.harness.compileAndEvaluateModules(
          DRAFT_PROGRAM,
        );
        const pattern = (main as { default: Pattern }).default;
        expect(await boundSpace(runtimeB, spaceB, pattern)).toBe(spaceB);
      } finally {
        await runtimeC.dispose();
        await storageC.close();
      }
    });
  });

  describe("a compiled async handler", () => {
    let storage: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;

    beforeEach(() => {
      storage = StorageManager.emulate({ as: signerA });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
    });

    afterEach(async () => {
      await runtime.dispose();
      await storage.close();
    });

    it("reads the ambient clock after an `await`, which needs its own handler frame", async () => {
      const { main } = await runtime.harness.compileAndEvaluateModules(
        ASYNC_CLOCK_PROGRAM,
      );
      const pattern = (main as { default: Pattern }).default;
      const errors: unknown[] = [];
      runtime.scheduler.onError((error) => errors.push(error));
      const result = runtime.getCell<{ at: number; stamp: unknown }>(
        spaceA,
        "frame context clock",
      );
      await runtime.runSynced(result, pattern, { at: 0 });
      const streamLink = resolveLink(
        runtime,
        runtime.readTx(),
        result.key("stamp").getAsNormalizedFullLink(),
      );
      runtime.scheduler.queueEvent(streamLink, { go: true }, true);
      await runtime.idle();
      expect(errors).toEqual([]);
      expect(result.key("at").get()).toBeGreaterThan(0);
    });
  });
});
