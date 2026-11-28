/**
 * `Runner.pieceCurrencyFacts()`: what the currency index learns of a running
 * piece, and the pieces it learns nothing of.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { getDerivedInternalCell } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";
import { trustExecutable } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner piece currency facts");
const space = signer.did();

/**
 * A piece that owns two per-session cells with a default: `note`, whose
 * default is a string, and `draft`, whose default is an object.
 */
const OWNING_PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern, Writable } from 'commonfabric';",
      "interface Draft { title: string }",
      "export default pattern<",
      "  { n?: number },",
      "  { note: Writable<string>; draft: Writable<Draft> }",
      ">(() => {",
      "  const note = new Writable.perSession<string>('');",
      "  const draft = new Writable.perSession<Draft>({ title: '' });",
      "  return { note, draft };",
      "});",
    ].join("\n"),
  }],
};

/** A piece that owns nothing narrower than itself. */
const PLAIN_PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "export default pattern<{ value: number }, { doubled: number }>(",
      "  ({ value }) => ({ doubled: computed(() => value * 2) }),",
      ");",
    ].join("\n"),
  }],
};

describe("Runner.pieceCurrencyFacts()", () => {
  describe("on a runtime that serves no space", () => {
    let storage: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;

    beforeEach(() => {
      storage = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
    });

    afterEach(async () => {
      await runtime.dispose();
      await storage.close();
    });

    it("names the cells a piece owns with a narrower default, and those an absent instance reads as its seed", async () => {
      const pattern = await runtime.patternManager.compilePattern(
        OWNING_PROGRAM,
        { space },
      );
      const result = runtime.getCell(space, "owning piece");
      await runtime.runSynced(result, pattern, {});
      const idOf = (name: string) => {
        const descriptor = pattern.derivedInternalCells!.find((cell) =>
          JSON.stringify(cell.partialCause).includes(name)
        );
        expect(descriptor).toBeDefined();
        return getDerivedInternalCell(result, descriptor!)
          .getAsNormalizedFullLink().id;
      };
      const note = idOf("note");
      const draft = idOf("draft");
      expect(note).not.toBe(draft);

      const facts = runtime.runner.pieceCurrencyFacts(result);
      expect(facts).toBeDefined();
      expect(facts!.followsOrigin).toBe(false);
      expect([...facts!.owned].sort()).toEqual([note, draft].sort());
      // An absent `note` reads as the string the seed writes; an absent
      // `draft` does not read as the whole object a seed writes.
      expect(facts!.absentAsDefault).toEqual([note]);

      // A cell within the result names the same piece.
      expect(runtime.runner.pieceCurrencyFacts(result.key("note"))).toEqual(
        facts,
      );
    });

    it("names no owned cell for a piece that owns none narrower than itself", async () => {
      const pattern = await runtime.patternManager.compilePattern(
        PLAIN_PROGRAM,
        { space },
      );
      const result = runtime.getCell(space, "plain piece");
      await runtime.runSynced(result, pattern, { value: 2 });

      expect(runtime.runner.pieceCurrencyFacts(result)).toEqual({
        followsOrigin: false,
        owned: [],
        absentAsDefault: [],
      });
    });

    it("answers nothing for a piece that is not running here", async () => {
      const pattern = await runtime.patternManager.compilePattern(
        PLAIN_PROGRAM,
        { space },
      );
      expect(
        runtime.runner.pieceCurrencyFacts(runtime.getCell(space, "never run")),
      ).toBeUndefined();

      const result = runtime.getCell(space, "stopped piece");
      await runtime.runSynced(result, pattern, { value: 2 });
      expect(runtime.runner.pieceCurrencyFacts(result)).toBeDefined();
      runtime.runner.stop(result);
      expect(runtime.runner.pieceCurrencyFacts(result)).toBeUndefined();
    });

    it("answers nothing for a running piece whose result records no pattern", async () => {
      const keyless: Pattern = {
        argumentSchema: {},
        resultSchema: {},
        result: { marker: "keyless" },
        nodes: [],
      };
      const result = runtime.getCell(space, "keyless piece");
      await runtime.runSynced(result, trustExecutable(runtime, keyless), {});
      expect(runtime.runner.isRunning(result)).toBe(true);

      expect(runtime.runner.pieceCurrencyFacts(result)).toBeUndefined();
    });

    it("answers nothing for a running piece whose recorded pattern this runtime cannot name", async () => {
      const pattern = await runtime.patternManager.compilePattern(
        PLAIN_PROGRAM,
        { space },
      );
      const result = runtime.getCell(space, "unnamed piece");
      await runtime.runSynced(result, pattern, { value: 2 });
      expect(runtime.runner.pieceCurrencyFacts(result)).toBeDefined();

      // What the branch responds to is the pattern manager's answer, so the
      // answer is given directly.
      using _unloaded = stub(
        runtime.patternManager,
        "artifactFromIdentitySyncInSpace",
        () => undefined,
      );
      expect(runtime.runner.pieceCurrencyFacts(result)).toBeUndefined();
    });
  });

  describe("for a running piece whose root this replica cannot read", () => {
    let storage: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let result: Cell<unknown>;

    beforeEach(async () => {
      storage = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      const pattern = await runtime.patternManager.compilePattern(
        PLAIN_PROGRAM,
        { space },
      );
      result = runtime.getCell(space, "unreadable root");
      await runtime.runSynced(result, pattern, { value: 2 });
      expect(runtime.runner.pieceCurrencyFacts(result)).toBeDefined();
    });

    afterEach(async () => {
      await runtime.dispose();
      await storage.close();
    });

    it("answers nothing where the replica no longer covers the root", () => {
      const replica = runtime.storageManager.open(space).replica;
      const root = result.getAsNormalizedFullLink().id;
      using _uncovered = stub(
        replica,
        "hasLocalDocumentCoverage",
        (id) => id !== root,
      );

      expect(runtime.runner.isRunning(result)).toBe(true);
      expect(runtime.runner.pieceCurrencyFacts(result)).toBeUndefined();
    });

    it("throws a failure of the replica's read of the root", () => {
      const replica = runtime.storageManager.open(space).replica;
      const failure = new Error("Replica read failed");
      using _reads = stub(replica, "getDocument", () => {
        throw failure;
      });

      expect(() => runtime.runner.pieceCurrencyFacts(result)).toThrow(failure);
    });
  });

  describe("on a serving runtime, for a piece each viewer holds an instance of", () => {
    const alice = signer;
    let server: ReturnType<typeof newLoopbackServer>;
    let storage: EmulatedStorageManager;
    let runtime: Runtime;
    let lease: ExecutionLeaseCycle;
    let demands: Array<() => void>;

    beforeEach(async () => {
      server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
      const holder = executionLeaseHolder(alice.did());
      storage = EmulatedStorageManager.connectTo(server, {
        as: alice,
        id: holder,
      });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
        servingPosture: true,
        experimental: { serverExecution: true },
      });
      const engine = await server.engineForSpace(space);
      lease = new ExecutionLeaseCycle({
        leases: engine.executionLeases,
        space,
        holder,
      });
      expect(await lease.acquire()).toBe(true);
      demands = [];
    });

    afterEach(async () => {
      runtime.clearSealDestination();
      for (const cancel of demands) cancel();
      await runtime.dispose();
      await lease.release();
      await storage.close();
      await server.close();
    });

    it("answers for the programs the instances select, and nothing once none selects one", async () => {
      const pattern = await runtime.patternManager.compilePattern(
        PLAIN_PROGRAM,
        { space },
      );
      const result = runtime.getCell<{ doubled: number }>(
        space,
        "per-viewer piece",
        pattern.resultSchema,
        undefined,
        "user",
      );
      const start = runtime.edit();
      runtime.run(start, pattern, { value: 3 }, result);
      expect((await start.commit().settled).error).toBeUndefined();
      demands.push(result.sink(() => {}));
      expect(await result.pull()).toEqual({ doubled: 6 });

      expect(runtime.runner.pieceCurrencyFacts(result)).toEqual({
        followsOrigin: false,
        owned: [],
        absentAsDefault: [],
      });

      const clear = runtime.edit();
      runtime.runner.clearInTransaction(clear, result);
      expect((await clear.commit().settled).error).toBeUndefined();
      await runtime.idle();
      const piece = result.getAsNormalizedFullLink().id;
      expect(runtime.runner.accessForTestingOnly.scopedProgramCounts())
        .toEqual([{ piece, variants: 0 }]);
      expect(runtime.runner.isRunning(result)).toBe(true);

      expect(runtime.runner.pieceCurrencyFacts(result)).toBeUndefined();
    });
  });
});
