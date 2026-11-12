import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/data-model";
import { getLogger } from "@commonfabric/logger";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { ensurePieceRunningVerdict } from "../src/ensure-piece-running.ts";
import { getMetaCell } from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { setResultCell } from "../src/result-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { trustPattern } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("ensure piece running walk");
const space = signer.did();

const PATTERN: Pattern = {
  argumentSchema: { type: "object" },
  resultSchema: { type: "object" },
  result: {},
  nodes: [],
};

describe("ensure-piece-running", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let identity: { identity: string; symbol: string };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    identity = {
      identity: `ensure-piece-walk-${crypto.randomUUID()}`,
      symbol: "default",
    };
    runtime.patternManager.associatePatternIdentity(
      trustPattern(runtime, PATTERN),
      identity,
    );
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /**
   * Commits whatever `write` stages, fails the case if it does not, and
   * returns what `write` returned.
   */
  async function commit<T>(write: (tx: ReturnType<Runtime["edit"]>) => T) {
    const tx = runtime.edit();
    const written = write(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    return written;
  }

  /**
   * Writes `count` documents, each but the last carrying a `result` backlink
   * to the next, and returns them in chain order.
   */
  async function resultChain(count: number): Promise<Cell<unknown>[]> {
    const name = crypto.randomUUID();
    return await commit((tx) => {
      const cells = Array.from({ length: count }, (_, i) => {
        const cell = runtime.getCell<unknown>(space, `${name}-${i}`, {}, tx);
        cell.setRaw({});
        return cell;
      });
      for (let i = 0; i + 1 < count; i++) setResultCell(cells[i], cells[i + 1]);
      return cells;
    });
  }

  /** The result document of a piece of the empty pattern, staged on `tx`. */
  function resultDocument(tx: ReturnType<Runtime["edit"]>): Cell<unknown> {
    const result = runtime.getCell<unknown>(
      space,
      `walk-piece-${crypto.randomUUID()}`,
      {},
      tx,
    );
    result.setRaw({});
    result.setMetaRaw("patternIdentity", identity, rawMetaWriteAuthorization);
    return result;
  }

  /**
   * The result and argument documents of a piece whose argument holds
   * `value`.
   */
  function piece(value: FabricValue) {
    return commit((tx) => {
      const result = resultDocument(tx);
      const argument = getMetaCell(result, "argument", tx);
      argument.setRaw(value);
      result.setMetaRaw(
        "argument",
        argument.getAsWriteRedirectLink(),
        rawMetaWriteAuthorization,
      );
      setResultCell(argument, result);
      return { result, argument };
    });
  }

  /**
   * The debug messages the walk logs while `work` runs, each resolved the
   * way the logger resolves a lazy message. The walk's logger is disabled, so
   * this reads them off the calls rather than the console.
   */
  async function debugWhile<T>(
    work: () => Promise<T>,
  ): Promise<{ value: T; messages: string[] }> {
    using debug = spy(getLogger("ensure-piece-running"), "debug");
    const value = await work();
    const messages = debug.calls.map((call) =>
      call.args.slice(1).flatMap((message) =>
        typeof message === "function" ? message() : [message]
      ).join(" ")
    );
    return { value, messages };
  }

  describe("following `result` backlinks", () => {
    it("returns the document ten hops along as the owning root", async () => {
      const chain = await resultChain(11);
      const { value: verdict, messages } = await debugWhile(() =>
        ensurePieceRunningVerdict(runtime, chain[0].getAsNormalizedFullLink())
      );

      expect(verdict).toMatchObject({
        started: false,
        reason: "no-pattern-meta",
        root: { space, id: chain[10].getAsNormalizedFullLink().id },
      });
      expect(verdict.observedDocIds).toEqual(
        chain.map((cell) => cell.getAsNormalizedFullLink().id),
      );
      expect(messages).toEqual([
        "No pattern identity found in result metadata",
      ]);
    });

    it("returns `chain-cycle` for a chain longer than ten hops, and logs where it started", async () => {
      const chain = await resultChain(12);
      const start = chain[0].getAsNormalizedFullLink().id;
      const { value: verdict, messages } = await debugWhile(() =>
        ensurePieceRunningVerdict(runtime, chain[0].getAsNormalizedFullLink())
      );

      expect(verdict).toEqual({
        started: false,
        reason: "chain-cycle",
        observedDocIds: chain.slice(0, 11).map((cell) =>
          cell.getAsNormalizedFullLink().id
        ),
        observedDocs: chain.slice(0, 11).map((cell) => {
          const { space, id, scope } = cell.getAsNormalizedFullLink();
          return { space, id, scope };
        }),
      });
      expect(messages).toEqual([
        `Exceeded result metadata traversal depth from ${start}`,
      ]);
    });

    it("returns `chain-cycle` for a chain that comes back to a document, and logs that document", async () => {
      const [first, second] = await resultChain(2);
      await commit((tx) => setResultCell(second.withTx(tx), first));
      const { value: verdict, messages } = await debugWhile(() =>
        ensurePieceRunningVerdict(runtime, first.getAsNormalizedFullLink())
      );

      expect(verdict).toMatchObject({ started: false, reason: "chain-cycle" });
      expect(verdict.observedDocIds).toEqual([
        first.getAsNormalizedFullLink().id,
        second.getAsNormalizedFullLink().id,
      ]);
      expect(messages).toEqual([
        "Cycle found while following result metadata at " +
        first.getAsNormalizedFullLink().id,
      ]);
    });
  });

  describe("starting the owning piece", () => {
    it("returns `pattern-unloadable` for a pattern nothing loads, and logs which", async () => {
      identity = { identity: "ensure-piece-walk-missing", symbol: "default" };
      const { result: missing } = await piece({});
      const { value: verdict, messages } = await debugWhile(() =>
        ensurePieceRunningVerdict(runtime, missing.getAsNormalizedFullLink())
      );

      expect(verdict).toMatchObject({
        started: false,
        reason: "pattern-unloadable",
        patternIdentity: "ensure-piece-walk-missing",
      });
      expect(messages).toEqual([
        "Failed to load pattern: ensure-piece-walk-missing#default",
      ]);
    });

    it("starts the piece, and logs the start and its success", async () => {
      const { result: started } = await piece({});
      const { value: verdict, messages } = await debugWhile(() =>
        ensurePieceRunningVerdict(runtime, started.getAsNormalizedFullLink())
      );

      expect(verdict.started).toBe(true);
      expect(runtime.runner.isRunning(started)).toBe(true);
      expect(messages).toEqual([
        `Starting piece with pattern ${identity.identity} for result cell ` +
        started.getAsNormalizedFullLink().id,
        "Piece started successfully",
      ]);
    });

    it("rethrows the walk's own failure when committing its read fails as well", async () => {
      const { result: failing } = await piece({});
      let calls = 0;
      using _prepare = stub(runtime, "prepareTxForCommit", () => {
        calls++;
        throw new Error(calls === 1 ? "the read failed" : "the cleanup failed");
      });

      await expect(
        ensurePieceRunningVerdict(runtime, failing.getAsNormalizedFullLink(), {
          propagateErrors: true,
        }),
      ).rejects.toThrow("the read failed");
      expect(calls).toBe(2);
      expect(runtime.runner.isRunning(failing)).toBe(false);
    });
  });

  describe("starting input sources first", () => {
    it("starts a piece that records no argument, having nothing to start ahead of it", async () => {
      const bare = await commit(resultDocument);
      const verdict = await ensurePieceRunningVerdict(
        runtime,
        bare.getAsNormalizedFullLink(),
        { startInputSources: true },
      );

      expect(verdict.started).toBe(true);
      expect(runtime.runner.isRunning(bare)).toBe(true);
    });

    it("starts two pieces whose arguments link to each other once each", async () => {
      const { result: first, argument: firstArgument } = await piece({});
      const { result: second } = await piece({ input: first.getAsLink() });
      await commit((tx) =>
        firstArgument.withTx(tx).setRaw({ input: second.getAsLink() })
      );
      using starts = spy(runtime, "start");

      const verdict = await ensurePieceRunningVerdict(
        runtime,
        first.getAsNormalizedFullLink(),
        { startInputSources: true },
      );

      expect(verdict.started).toBe(true);
      expect(runtime.runner.isRunning(first)).toBe(true);
      expect(runtime.runner.isRunning(second)).toBe(true);
      // The second piece is the first one's source, so it starts first.
      expect(
        starts.calls.map((call) => call.args[0].getAsNormalizedFullLink().id),
      ).toEqual([
        second.getAsNormalizedFullLink().id,
        first.getAsNormalizedFullLink().id,
      ]);
    });
  });
});
