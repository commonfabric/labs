/**
 * Runs authored compile requests through a serving host and observes the child
 * from a separate client runtime over the in-process memory server.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import * as Engine from "@commonfabric/memory/v2/engine";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { maxOf } from "@commonfabric/utils/math";

import { type Cell, sendEvent } from "../src/cell.ts";
import { readWatermarkSeq } from "../src/executor/watermark.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { waitUntil } from "./support/wait-until.ts";

const spaceSigner = await Identity.fromPassphrase("served compile space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("served compile service");
const aliceSigner = await Identity.fromPassphrase("served compile alice");
const bobSigner = await Identity.fromPassphrase("served compile bob");

const PARENT_PATTERN = `
import { compileAndRun, pattern } from "commonfabric";
export default pattern<{ code: string }, { compiled: any }>(({ code }) => ({
  compiled: compileAndRun({
    files: [{ name: "/main.tsx", contents: code }],
    main: "/main.tsx",
  }),
}));
`;

const PER_USER_PARENT = `
import { compileAndRun, Default, pattern, PerUser, Writable } from "commonfabric";
type Draft = Writable<string | Default<"">>;
export default pattern<{ code?: PerUser<Draft>; count?: PerUser<Writable<number | Default<0>>> }, { compiled: any }>(({ code, count }) => ({
  compiled: compileAndRun({
    files: [{ name: "/main.tsx", contents: code! }],
    main: "/main.tsx",
    input: { count },
  }),
}));
`;

const PER_SESSION_PARENT = PER_USER_PARENT.replaceAll("PerUser", "PerSession");

const STATIC_CHILD_PARENT = `
import { action, computed, Default, pattern, PerUser, Stream, Writable } from "commonfabric";
const Child = pattern<{ count: Writable<number> }, { answer: number; bump: Stream<unknown>; isHidden: boolean }>(
  ({ count }) => ({
    answer: computed(() => count.get()),
    bump: action(() => count.set(count.get() + 1)),
    isHidden: true,
  }),
);
export default pattern<{ code?: PerUser<Writable<string | Default<"">>>; count?: PerUser<Writable<number | Default<0>>> }>(
  ({ count }) => ({ compiled: { pending: false, result: Child({ count: count! }) } }),
);
`;

const CLEARABLE_PER_USER_PARENT = `
import { compileAndRun, computed, Default, pattern, PerUser, Writable } from "commonfabric";
type Draft = Writable<string | Default<"">>;
export default pattern<{ code?: PerUser<Draft>; count?: PerUser<Writable<number | Default<0>>> }, { compiled: any }>(({ code, count }) => ({
  compiled: compileAndRun({
    files: computed(() => {
      const contents = code!.get();
      return contents ? [{ name: "/main.tsx", contents }] : [];
    }),
    main: computed(() => code!.get() ? "/main.tsx" : ""),
    input: { count },
  }),
}));
`;

/** Builds a child whose output identifies the compiled program. */
function childProgram(answer: number): string {
  return `
import { pattern } from "commonfabric";
export default pattern<Record<string, never>, { answer: number }>(
  () => ({ answer: ${answer} }),
);
`;
}

/** Builds a child whose derivation depends on its live input. */
function reactiveChildProgram(offset: number): string {
  return `
import { computed, pattern } from "commonfabric";
export default pattern<{ count: number }, { answer: number }>(({ count }) => ({
  answer: computed(() => ${offset} + count),
}));
`;
}

/** Builds a child whose handler identifies the selected program. */
function handlerChildProgram(step: number): string {
  return `
import { action, computed, pattern, Stream, Writable } from "commonfabric";
export default pattern<{ count: Writable<number> }, { answer: number; bump: Stream<unknown> }>(({ count }) => ({
  answer: computed(() => count.get()),
  bump: action(() => count.set(count.get() + ${step})),
}));
`;
}

/** Public result of one compile request. */
type CompiledView = {
  /** Whether compilation or child setup is in progress. */
  pending?: boolean;

  /** The child piece's result. */
  result?: { answer?: number; isHidden?: boolean; bump?: unknown };

  /** Unstructured compiler failure. */
  error?: string;

  /** Source diagnostics from a compiler failure. */
  errors?: unknown[];
};

describe("executor-compile-and-run", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost;
  let clientManager: EmulatedStorageManager;
  let client: Runtime;
  let servingCompiles: string[];
  let clientCompiles: string[];
  let created: Cell<unknown>[];
  let servingErrors: unknown[];
  let servingRuntimes: Runtime[];
  let compileGates: Map<string, {
    entered: ReturnType<typeof Promise.withResolvers<void>>;
    release: ReturnType<typeof Promise.withResolvers<void>>;
  }>;

  /** Counts real compiler calls, including calls reached through the cache. */
  function countCompiles(runtime: Runtime, into: string[]): void {
    const manager = runtime.patternManager;
    const compile = manager.compilePattern.bind(manager);
    manager.compilePattern = (program, options) => {
      into.push(
        typeof program === "string"
          ? program
          : program.files[0]?.contents ?? "",
      );
      const gate = runtime.servingPosture && compileGates.get(into.at(-1)!);
      if (gate) {
        compileGates.delete(into.at(-1)!);
        gate.entered.resolve();
        return gate.release.promise.then(() => compile(program, options));
      }
      return compile(program, options);
    };
  }

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    servingCompiles = [];
    clientCompiles = [];
    created = [];
    servingErrors = [];
    servingRuntimes = [];
    compileGates = new Map();
    host = new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      // The host factory contract is asynchronous.
      // deno-lint-ignore require-await
      createRuntime: async () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        servingRuntimes.push(runtime);
        countCompiles(runtime, servingCompiles);
        runtime.scheduler.onError((error) => servingErrors.push(error));
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    client = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
      pieceCreatedCallback: (piece) => created.push(piece),
    });
    countCompiles(client, clientCompiles);
  });

  afterEach(async () => {
    await host.close();
    await client.dispose();
    await clientManager.close();
    await server.close();
  });

  /** Creates the parent through an authored client transaction. */
  async function createParent(
    code: string,
    parentSource = PARENT_PATTERN,
    perUser = false,
    initialCount?: number,
  ) {
    const parent = await client.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: parentSource }],
    }, { space });
    const argument = client.getCell<{ code: string }>(
      space,
      "compile-arg",
      perUser ? parent.argumentSchema : undefined,
    );
    const result = client.getCell<{ compiled: CompiledView }>(
      space,
      "compile-result",
      parent.resultSchema,
    );
    await argument.sync();
    await result.sync();
    const seed = client.edit();
    if (perUser) argument.withTx(seed).key("code").set(code);
    else argument.withTx(seed).set({ code });
    if (initialCount !== undefined) {
      argument.withTx(seed).key("count").set(initialCount);
    }
    expect((await seed.commit().settled).error).toBeUndefined();
    const tx = client.edit();
    client.run(tx, parent, argument, result);
    expect((await tx.commit().settled).error).toBeUndefined();
    return { parent, argument, result, cancelDemand: result.sink(() => {}) };
  }

  /** Writes a fresh program as an authored client input. */
  async function setCode(argument: Cell<{ code: string }>, code: string) {
    const tx = client.edit();
    argument.withTx(tx).set({ code });
    expect((await tx.commit().settled).error).toBeUndefined();
  }

  /** Opens another client's instance of an existing parent. */
  async function joinParent(
    piece: Awaited<ReturnType<typeof createParent>>,
    signer: typeof aliceSigner,
    code: string,
    initialCount?: number,
  ) {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    countCompiles(runtime, clientCompiles);
    const argument = runtime.getCell<{ code: string; count?: number }>(
      space,
      "compile-arg",
      piece.parent.argumentSchema,
    );
    const result = runtime.getCell<{ compiled: CompiledView }>(
      space,
      "compile-result",
      piece.parent.resultSchema,
    );
    try {
      await argument.sync();
      await result.sync();
      const tx = runtime.edit();
      argument.withTx(tx).key("code").set(code);
      if (initialCount !== undefined) {
        argument.withTx(tx).key("count").set(initialCount);
      }
      expect((await tx.commit().settled).error).toBeUndefined();
      const cancelDemand = result.sink(() => {});
      return {
        runtime,
        argument,
        result,
        dispose: async () => {
          cancelDemand();
          await runtime.dispose();
          await manager.close();
        },
      };
    } catch (error) {
      await runtime.dispose();
      await manager.close();
      throw error;
    }
  }

  /** Commits one scoped input without replacing the sibling input slots. */
  async function writeInput(
    runtime: Runtime,
    piece: Awaited<ReturnType<typeof createParent>>,
    key: "code" | "count",
    value: string | number,
  ) {
    const argument = runtime.getCell<{ code: string; count: number }>(
      space,
      "compile-arg",
      piece.parent.argumentSchema,
    );
    const tx = runtime.edit();
    argument.withTx(tx).key(key).set(value);
    expect((await tx.commit().settled).error).toBeUndefined();
  }

  /** Waits for a scoped piece to share exactly the expected program groups. */
  async function variantsFor(pieceId: string, count: number) {
    const counts = () =>
      servingRuntimes.at(-1)!.runner.accessForTestingOnly.scopedProgramCounts();
    await waitUntil(
      () =>
        counts().find((entry) => entry.piece === pieceId)?.variants === count,
      () => `program groups for ${pieceId}: ${JSON.stringify(counts())}`,
    );
    expect(counts().find((entry) => entry.piece === pieceId)?.variants).toBe(
      count,
    );
  }

  /** Holds one real compile at its entry, leaving the serving loop free. */
  function holdCompile(code: string) {
    const gate = {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    compileGates.set(code, gate);
    return gate;
  }

  /** Waits for the engine watermark to cover an authored input. */
  async function covered() {
    const engine = await server.engineForSpace(space);
    const seq = Math.max(
      0,
      maxOf(
        Engine.selectCommitsSince(engine, { fromSeq: 0 })
          .filter((commit) => commit.class === "authored")
          .map((commit) => commit.seq),
      ),
    );
    expect(seq).toBeGreaterThan(0);
    await waitUntil(
      () => readWatermarkSeq(engine) >= seq,
      "authored input coverage",
    );
  }

  /** Observes the child's visible output from the client. */
  function childValue(
    result: Cell<{ compiled: CompiledView }>,
    answer: number,
    reader = client,
  ) {
    return waitForCellValue<CompiledView>(
      reader,
      result.key("compiled"),
      (value) =>
        value?.pending === false && value.result?.answer === answer &&
        value.result.isHidden === true,
    );
  }

  it("serves a compiled child and recompiles changed source without compiling on the client", async () => {
    const { argument, result, cancelDemand } = await createParent(
      childProgram(42),
    );
    try {
      const compiled = result.key("compiled");
      await waitUntil(
        () => servingCompiles.includes(childProgram(42)),
        () =>
          `served compile; ${
            JSON.stringify({
              servingCompiles,
              stats: host.stats(),
              value: result.get(),
            })
          }`,
      );
      expect(host.stats().outbox.queued).toBeGreaterThanOrEqual(1);
      const value = await waitForCellValue<CompiledView>(
        client,
        compiled,
        (value) =>
          value?.pending === false && value.result?.answer === 42 &&
          value.result.isHidden === true,
      );
      expect(value.error).toBeUndefined();
      expect(value.errors).toBeUndefined();
      expect(value.result?.isHidden).toBe(true);
      expect(servingCompiles.filter((code) => code === childProgram(42)))
        .toHaveLength(1);
      expect(clientCompiles).toEqual([PARENT_PATTERN]);
      await waitUntil(() => created.length === 1, "child creation callback");
      expect(created[0].getAsNormalizedFullLink().id).toBe(
        compiled.key("result").resolveAsCell().getAsNormalizedFullLink().id,
      );
      const tx = client.edit();
      argument.withTx(tx).set({ code: childProgram(7) });
      expect((await tx.commit().settled).error).toBeUndefined();
      await waitForCellValue<CompiledView>(
        client,
        compiled,
        (value) => value?.pending === false && value.result?.answer === 7,
      );
      expect(servingCompiles.filter((code) => code === childProgram(7)))
        .toHaveLength(1);
      expect(clientCompiles).toEqual([PARENT_PATTERN]);
      await waitUntil(
        () => created.length === 2,
        "replacement creation callback",
      );
      expect(host.stats().outbox.completed).toBeGreaterThanOrEqual(2);
      expect(host.stats().unstampedSealRefusals).toBe(0);
      expect(servingErrors).toEqual([]);
    } finally {
      cancelDemand();
    }
  });
  it("commits compile errors once and retries when source changes", async () => {
    const broken = "this is not valid (((";
    const piece = await createParent(broken);
    try {
      const value = await waitForCellValue<CompiledView>(
        client,
        piece.result.key("compiled"),
        (value) =>
          value?.pending === false &&
          (value.error !== undefined || value.errors !== undefined),
      );
      expect(value.errors?.length).toBeGreaterThan(0);
      expect(value.result).toBeUndefined();
      const poke = client.getCell<number>(space, "unrelated-input");
      const tx = client.edit();
      poke.withTx(tx).set(1);
      expect((await tx.commit().settled).error).toBeUndefined();
      await covered();
      expect(servingCompiles.filter((code) => code === broken)).toHaveLength(1);
      expect(created).toEqual([]);
      await setCode(piece.argument, childProgram(9));
      const fixed = await childValue(piece.result, 9);
      expect(fixed.error).toBeUndefined();
      expect(fixed.errors).toBeUndefined();
      expect(host.stats().outbox.failed).toBe(0);
      expect(host.stats().unstampedSealRefusals).toBe(0);
      expect(servingErrors).toEqual([]);
    } finally {
      piece.cancelDemand();
    }
  });

  it("preserves attached data files through the served compile", async () => {
    const parentSource = `
import { compileAndRun, pattern } from "commonfabric";
export default pattern<{ code: string }, { compiled: any }>(({ code }) => ({
  compiled: compileAndRun({
    files: [
      { name: "/main.tsx", contents: code },
      { name: "/data/answer.json", contents: '{"answer":42}' },
    ],
    dataFiles: ["/data/answer.json"],
    main: "/main.tsx",
  }),
}));
`;
    const code = `
import { dataFile, pattern } from "commonfabric";
export default pattern<Record<string, never>, { answer: number }>(() => ({
  answer: JSON.parse(dataFile("/data/answer.json")).answer,
}));
`;
    const piece = await createParent(code, parentSource);
    try {
      const value = await childValue(piece.result, 42);
      expect(value.error).toBeUndefined();
      expect(value.errors).toBeUndefined();
      expect(servingCompiles.filter((source) => source === code)).toHaveLength(
        1,
      );
      expect(host.stats().unstampedSealRefusals).toBe(0);
      expect(servingErrors).toEqual([]);
    } finally {
      piece.cancelDemand();
    }
  });

  it("reuses a resolved child after the serving runtime restarts", async () => {
    const parentSource = `
import { compileAndRun, pattern } from "commonfabric";
export default pattern<{ code: string; count: number }, { compiled: any }>(({ code, count }) => ({
  compiled: compileAndRun({
    files: [{ name: "/main.tsx", contents: code }],
    main: "/main.tsx",
    input: { count },
  }),
}));
`;
    const piece = await createParent(
      reactiveChildProgram(5),
      parentSource,
      false,
      2,
    );
    try {
      await childValue(piece.result, 7);
      await waitUntil(
        () => host.stats().memo.inflight === 0,
        "compile retirement",
      );
      const queued = host.stats().outbox.queued;
      await host.spaceServer(space)!.park("test-recovery");
      const poke = client.getCell<number>(space, "reactivation-input");
      const tx = client.edit();
      poke.withTx(tx).set(1);
      expect((await tx.commit().settled).error).toBeUndefined();
      await waitUntil(
        () => servingRuntimes.length === 2,
        "fresh serving runtime",
      );
      await covered();
      await writeInput(client, piece, "count", 4);
      await childValue(piece.result, 9);
      expect(host.stats().outbox.queued).toBeLessThanOrEqual(queued + 1);
      expect(host.stats().unstampedSealRefusals).toBe(0);
      expect(servingErrors).toEqual([]);
    } finally {
      piece.cancelDemand();
    }
  });

  it("reissues an unresolved request after the serving runtime restarts", async () => {
    const code = childProgram(17);
    const gate = holdCompile(code);
    const piece = await createParent(code);
    try {
      await gate.entered.promise;
      await covered();
      const pending = await waitForCellValue<CompiledView>(
        client,
        piece.result.key("compiled"),
        (value) => value?.pending === true,
      );
      expect(pending.pending).toBe(true);
      await host.spaceServer(space)!.park("test-pending-compile-recovery");
      const poke = client.getCell<number>(space, "reactivation-input");
      const tx = client.edit();
      poke.withTx(tx).set(1);
      expect((await tx.commit().settled).error).toBeUndefined();
      await childValue(piece.result, 17);
      expect(servingRuntimes).toHaveLength(2);
      expect(servingCompiles.filter((source) => source === code)).toHaveLength(
        2,
      );
      expect(host.stats().unstampedSealRefusals).toBe(0);
      expect(servingErrors).toEqual([]);
    } finally {
      // The held compile represents work lost with the disposed process.
      piece.cancelDemand();
    }
  });

  it("reattaches an A to B to A request to the outstanding A compile", async () => {
    const a = childProgram(31);
    const b = childProgram(32);
    const gateA = holdCompile(a);
    const gateB = holdCompile(b);
    const piece = await createParent(a);
    try {
      await gateA.entered.promise;
      await setCode(piece.argument, b);
      await gateB.entered.promise;
      await setCode(piece.argument, a);
      await covered();
      expect(host.stats().outbox.queued).toBe(2);
      gateA.release.resolve();
      await childValue(piece.result, 31);
      gateB.release.resolve();
      await waitUntil(
        () => host.stats().memo.inflight === 0,
        "both compile retirements",
      );
      await client.idle();
      expect(piece.result.key("compiled").get()?.result?.answer).toBe(31);
      expect(servingCompiles.filter((code) => code === a)).toHaveLength(1);
      expect(servingCompiles.filter((code) => code === b)).toHaveLength(1);
      expect(host.stats().outbox.superseded).toBe(1);
      expect(host.stats().outbox.failed).toBe(0);
      expect(host.stats().unstampedSealRefusals).toBe(0);
      expect(servingErrors).toEqual([]);
    } finally {
      gateA.release.resolve();
      gateB.release.resolve();
      piece.cancelDemand();
    }
  });
  it("completes identical requests per user and replaces one user's child independently", async () => {
    const a = reactiveChildProgram(21);
    const gate = holdCompile(a);
    const piece = await createParent(a, PER_USER_PARENT, true);
    const bobManager = EmulatedStorageManager.connectTo(server, {
      as: bobSigner,
    });
    const bob = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: bobManager,
      experimental: { serverExecution: true },
    });
    const bobArgument = bob.getCell<{ code: string }>(
      space,
      "compile-arg",
      piece.parent.argumentSchema,
    );
    const bobResult = bob.getCell<{ compiled: CompiledView }>(
      space,
      "compile-result",
      piece.parent.resultSchema,
    );
    let cancelBob: (() => void) | undefined;
    try {
      await gate.entered.promise;
      await bobArgument.sync();
      await bobResult.sync();
      const tx = bob.edit();
      bobArgument.withTx(tx).key("code").set(a);
      expect((await tx.commit().settled).error).toBeUndefined();
      cancelBob = bobResult.sink(() => {});
      await waitUntil(
        () => host.stats().outbox.queued === 2,
        "both user compile requests",
      );
      gate.release.resolve();
      await waitUntil(
        () =>
          piece.result.key("compiled").get()?.result?.answer === 21 &&
          bobResult.key("compiled").get()?.result?.answer === 21,
        () =>
          `both user children: ${
            JSON.stringify({
              alice: piece.result.key("compiled").get()?.result?.answer,
              bob: bobResult.key("compiled").get()?.result?.answer,
              errors: servingErrors.map(String),
              stats: host.stats().outbox,
            })
          }`,
      );
      expect(servingCompiles.filter((code) => code === a)).toHaveLength(1);
      const childId = piece.result.key("compiled").key("result")
        .resolveAsCell().getAsNormalizedFullLink().id;
      expect(
        bobResult.key("compiled").key("result").resolveAsCell()
          .getAsNormalizedFullLink().id,
      )
        .toBe(childId);
      await variantsFor(childId, 1);
      const count = client.getCell<{ count: number }>(
        space,
        "compile-arg",
        piece.parent.argumentSchema,
      );
      const updateInput = client.edit();
      count.withTx(updateInput).key("count").set(3);
      expect((await updateInput.commit().settled).error).toBeUndefined();
      await waitUntil(
        () => piece.result.key("compiled").get()?.result?.answer === 24,
        () =>
          `Alice's live child: ${
            JSON.stringify({
              alice: piece.result.key("compiled").get()?.result?.answer,
              bob: bobResult.key("compiled").get()?.result?.answer,
              errors: servingErrors.map(String),
            })
          }`,
      );
      expect(bobResult.key("compiled").get()?.result?.answer).toBe(21);

      const change = bob.edit();
      bobArgument.withTx(change).key("code").set(reactiveChildProgram(22));
      expect((await change.commit().settled).error).toBeUndefined();
      await waitUntil(
        () => bobResult.key("compiled").get()?.result?.answer === 22,
        () =>
          `Bob's replacement: ${
            JSON.stringify({
              alice: piece.result.key("compiled").get()?.result?.answer,
              bob: bobResult.key("compiled").get()?.result?.answer,
              errors: servingErrors.map(String),
              stats: host.stats().outbox,
            })
          }`,
      );
      expect(piece.result.key("compiled").get()?.result?.answer).toBe(24);
      await variantsFor(childId, 2);

      await writeInput(bob, piece, "code", a);
      await childValue(bobResult, 21, bob);
      await variantsFor(childId, 1);
      await writeInput(bob, piece, "count", 5);
      await childValue(bobResult, 26, bob);
      expect(piece.result.key("compiled").get()?.result?.answer).toBe(24);
      expect(
        bobResult.key("compiled").key("result").resolveAsCell()
          .getAsNormalizedFullLink().id,
      )
        .toBe(childId);
      expect(servingCompiles.filter((code) => code === a)).toHaveLength(1);

      expect(host.stats().unstampedSealRefusals).toBe(0);
      expect(servingErrors).toEqual([]);
    } finally {
      gate.release.resolve();
      cancelBob?.();
      piece.cancelDemand();
      await bob.dispose();
      await bobManager.close();
    }
  });

  it("keeps a cleared user's child absent while another user continues the shared program", async () => {
    const code = reactiveChildProgram(43);
    const piece = await createParent(code, CLEARABLE_PER_USER_PARENT, true);
    let bob: Awaited<ReturnType<typeof joinParent>> | undefined;
    try {
      await childValue(piece.result, 43);
      bob = await joinParent(piece, bobSigner, code);
      await childValue(bob.result, 43, bob.runtime);
      const childId = piece.result.key("compiled").key("result")
        .resolveAsCell().getAsNormalizedFullLink().id;
      await variantsFor(childId, 1);

      await writeInput(client, piece, "code", "");
      const cleared = await waitForCellValue<CompiledView>(
        client,
        piece.result.key("compiled"),
        (value) => value?.pending === false && value.result === undefined,
      );
      expect(cleared.error).toBeUndefined();
      expect(cleared.errors).toBeUndefined();
      await writeInput(client, piece, "count", 7);
      await writeInput(bob.runtime, piece, "count", 2);
      await childValue(bob.result, 45, bob.runtime);
      await covered();
      await client.idle();
      expect(piece.result.key("compiled").get()?.result).toBeUndefined();
      expect(piece.result.key("compiled").get()?.pending).toBe(false);
      await variantsFor(childId, 1);
      expect(host.stats().unstampedSealRefusals).toBe(0);
      expect(servingErrors).toEqual([]);
    } finally {
      await bob?.dispose();
      piece.cancelDemand();
    }
  });

  it("recovers two different user programs after park and continues deriving each user's inputs", async () => {
    const piece = await createParent(
      reactiveChildProgram(51),
      PER_USER_PARENT,
      true,
    );
    let bob: Awaited<ReturnType<typeof joinParent>> | undefined;
    try {
      await childValue(piece.result, 51);
      bob = await joinParent(piece, bobSigner, reactiveChildProgram(61));
      await childValue(bob.result, 61, bob.runtime);
      const childId = piece.result.key("compiled").key("result")
        .resolveAsCell().getAsNormalizedFullLink().id;
      await variantsFor(childId, 2);
      await writeInput(client, piece, "count", 2);
      await childValue(piece.result, 53);
      await writeInput(bob.runtime, piece, "count", 3);
      await childValue(bob.result, 64, bob.runtime);
      await waitUntil(
        () => host.stats().memo.inflight === 0,
        "both programs to finish compiling before park",
      );

      await host.spaceServer(space)!.park("test-divergent-program-recovery");
      await writeInput(client, piece, "count", 5);
      await waitUntil(
        () => servingRuntimes.length === 2,
        "fresh runtime for the divergent programs",
      );
      await childValue(piece.result, 56);
      await childValue(bob.result, 64, bob.runtime);
      await writeInput(bob.runtime, piece, "count", 8);
      await childValue(bob.result, 69, bob.runtime);
      expect(piece.result.key("compiled").get()?.result?.answer).toBe(56);
      expect(
        bob.result.key("compiled").key("result").resolveAsCell()
          .getAsNormalizedFullLink().id,
      )
        .toBe(childId);
      await variantsFor(childId, 2);
      expect(host.stats().unstampedSealRefusals).toBe(0);
      expect(servingErrors).toEqual([]);
    } finally {
      await bob?.dispose();
      piece.cancelDemand();
    }
  });

  it("selects and shares programs independently for two sessions of the same user", async () => {
    const a = reactiveChildProgram(71);
    const piece = await createParent(a, PER_SESSION_PARENT, true);
    let other: Awaited<ReturnType<typeof joinParent>> | undefined;
    try {
      await childValue(piece.result, 71);
      other = await joinParent(piece, aliceSigner, a);
      await childValue(other.result, 71, other.runtime);
      expect(other.runtime.scopeKeyIdentity.principal).toBe(
        client.scopeKeyIdentity.principal,
      );
      expect(other.runtime.scopeKeyIdentity.sessionId).not.toBe(
        client.scopeKeyIdentity.sessionId,
      );
      const childId = piece.result.key("compiled").key("result")
        .resolveAsCell().getAsNormalizedFullLink().id;
      expect(
        other.result.key("compiled").key("result").resolveAsCell()
          .getAsNormalizedFullLink().id,
      )
        .toBe(childId);
      await variantsFor(childId, 1);

      await writeInput(client, piece, "count", 2);
      await childValue(piece.result, 73);
      expect(other.result.key("compiled").get()?.result?.answer).toBe(71);
      await writeInput(other.runtime, piece, "code", reactiveChildProgram(81));
      await childValue(other.result, 81, other.runtime);
      await variantsFor(childId, 2);
      await writeInput(other.runtime, piece, "count", 4);
      await childValue(other.result, 85, other.runtime);
      expect(piece.result.key("compiled").get()?.result?.answer).toBe(73);

      await writeInput(other.runtime, piece, "code", a);
      await childValue(other.result, 75, other.runtime);
      await variantsFor(childId, 1);
      expect(piece.result.key("compiled").get()?.result?.answer).toBe(73);
      expect(servingCompiles.filter((code) => code === a)).toHaveLength(1);
      expect(host.stats().unstampedSealRefusals).toBe(0);
      expect(servingErrors).toEqual([]);
    } finally {
      await other?.dispose();
      piece.cancelDemand();
    }
  });

  for (const scope of ["user", "session"] as const) {
    for (const compiled of [false, true]) {
      it(`isolates uninitialized ${scope} defaults in ${compiled ? "compiled" : "static"} child handlers`, async () => {
        const parentSource = compiled ? PER_USER_PARENT : STATIC_CHILD_PARENT;
        const code = handlerChildProgram(1);
        const piece = await createParent(
          code,
          scope === "session"
            ? parentSource.replaceAll("PerUser", "PerSession")
            : parentSource,
          true,
        );
        let other: Awaited<ReturnType<typeof joinParent>> | undefined;
        try {
          await childValue(piece.result, 0);
          other = await joinParent(
            piece,
            scope === "session" ? aliceSigner : bobSigner,
            code,
          );
          await childValue(other.result, 0, other.runtime);

          expect(
            piece.argument.key("count").resolveAsCell()
              .getAsNormalizedFullLink().scope,
          ).toBe(scope);
          expect(
            other.argument.key("count").resolveAsCell()
              .getAsNormalizedFullLink().scope,
          ).toBe(scope);

          const firstDelivered = Promise.withResolvers<string>();
          sendEvent(
            piece.result.key("compiled").key("result").key("bump"),
            {},
            (tx) => {
              firstDelivered.resolve(tx.status().status);
            },
          );
          expect(await firstDelivered.promise).not.toBe("error");
          await childValue(piece.result, 1);
          await covered();
          await other.runtime.idle();
          expect(other.result.key("compiled").get()?.result?.answer).toBe(0);

          const secondDelivered = Promise.withResolvers<string>();
          sendEvent(
            other.result.key("compiled").key("result").key("bump"),
            {},
            (tx) => {
              secondDelivered.resolve(tx.status().status);
            },
          );
          expect(await secondDelivered.promise).not.toBe("error");
          await childValue(other.result, 1, other.runtime);
          await covered();
          await client.idle();
          expect(piece.result.key("compiled").get()?.result?.answer).toBe(1);
          expect(host.stats().unstampedSealRefusals).toBe(0);
          expect(servingErrors).toEqual([]);
        } finally {
          await other?.dispose();
          piece.cancelDemand();
        }
      });
    }
  }

  it("dispatches each user's child handler to that user's selected program", async () => {
    const a = handlerChildProgram(1);
    const piece = await createParent(a, PER_USER_PARENT, true, 0);
    let bob: Awaited<ReturnType<typeof joinParent>> | undefined;
    try {
      await childValue(piece.result, 0);
      bob = await joinParent(piece, bobSigner, handlerChildProgram(10), 0);
      await childValue(bob.result, 0, bob.runtime);
      const childId = piece.result.key("compiled").key("result")
        .resolveAsCell().getAsNormalizedFullLink().id;
      expect(
        bob.result.key("compiled").key("result").resolveAsCell()
          .getAsNormalizedFullLink().id,
      ).toBe(childId);
      await variantsFor(childId, 2);

      const aliceDelivered = Promise.withResolvers<string>();
      sendEvent(
        piece.result.key("compiled").key("result").key("bump"),
        {},
        (tx) => {
          aliceDelivered.resolve(tx.status().status);
        },
      );
      expect(await aliceDelivered.promise).not.toBe("error");
      await childValue(piece.result, 1);
      expect(bob.result.key("compiled").get()?.result?.answer).toBe(0);
      const bobBump = bob.result.key("compiled").key("result").key("bump")
        .resolveAsCell();
      const bobDelivered = Promise.withResolvers<string>();
      sendEvent(bobBump, {}, (tx) => {
        bobDelivered.resolve(tx.status().status);
      });
      expect(await bobDelivered.promise).not.toBe("error");
      await childValue(bob.result, 10, bob.runtime);
      expect(piece.result.key("compiled").get()?.result?.answer).toBe(1);

      await writeInput(bob.runtime, piece, "code", a);
      await childValue(bob.result, 10, bob.runtime);
      await variantsFor(childId, 1);
      const bobReplacedDelivered = Promise.withResolvers<string>();
      sendEvent(bobBump, {}, (tx) => {
        bobReplacedDelivered.resolve(tx.status().status);
      });
      expect(await bobReplacedDelivered.promise).not.toBe("error");
      await childValue(bob.result, 11, bob.runtime);
      expect(piece.result.key("compiled").get()?.result?.answer).toBe(1);
      expect(host.stats().unstampedSealRefusals).toBe(0);
      expect(servingErrors).toEqual([]);
    } finally {
      await bob?.dispose();
      piece.cancelDemand();
    }
  });

  it("shares a static nested child across selected programs and keeps it reactive as a parent group retires", async () => {
    const sharedChild = `
import { computed, pattern, PerUser } from "commonfabric";
export const Child = pattern<{ count: number }, PerUser<{ doubled: number }>>(
  ({ count }) => ({ doubled: computed(() => count * 2) }),
);
`;
    const parentSource = `
import { compileAndRun, Default, pattern, PerUser, Writable } from "commonfabric";
type Draft = Writable<string | Default<"">>;
export default pattern<{ code?: PerUser<Draft>; count?: PerUser<Writable<number | Default<0>>> }, { compiled: any }>(({ code, count }) => ({
  compiled: compileAndRun({
    files: [
      { name: "/main.tsx", contents: code! },
      { name: "/shared-child.tsx", contents: ${JSON.stringify(sharedChild)} },
    ],
    main: "/main.tsx",
    input: { count },
  }),
}));
`;
    const program = (offset: number) => `
import { computed, pattern } from "commonfabric";
import { Child } from "./shared-child.tsx";
export default pattern<{ count: number }, { answer: number; nested: { doubled: number } }>(
  ({ count }) => {
    const nested = Child({ count });
    return { answer: computed(() => nested.doubled + ${offset}), nested };
  },
);
`;
    const a = program(100);
    const piece = await createParent(a, parentSource, true, 2);
    let bob: Awaited<ReturnType<typeof joinParent>> | undefined;
    try {
      await childValue(piece.result, 104);
      await waitForCellValue<{ doubled: number }>(
        client,
        piece.result.key("compiled").key("result").key("nested"),
        (value) => value?.doubled === 4,
      );
      bob = await joinParent(piece, bobSigner, a, 3);
      await childValue(bob.result, 106, bob.runtime);
      await waitForCellValue<{ doubled: number }>(
        bob.runtime,
        bob.result.key("compiled").key("result").key("nested"),
        (value) => value?.doubled === 6,
      );
      const selectedChild = piece.result.key("compiled").key("result")
        .resolveAsCell();
      const childId = selectedChild.getAsNormalizedFullLink().id;
      const nestedId = selectedChild.key("nested").resolveAsCell()
        .getAsNormalizedFullLink().id;
      expect(
        bob.result.key("compiled").key("result").key("nested")
          .resolveAsCell().getAsNormalizedFullLink().id,
      ).toBe(nestedId);
      await variantsFor(childId, 1);
      await variantsFor(nestedId, 1);

      await writeInput(client, piece, "count", 4);
      await childValue(piece.result, 108);
      expect(bob.result.key("compiled").get()?.result?.answer).toBe(106);
      await writeInput(bob.runtime, piece, "code", program(200));
      await childValue(bob.result, 206, bob.runtime);
      await variantsFor(childId, 2);
      await variantsFor(nestedId, 1);
      expect(piece.result.key("compiled").get()?.result?.answer).toBe(108);

      await writeInput(bob.runtime, piece, "code", a);
      await childValue(bob.result, 106, bob.runtime);
      await variantsFor(childId, 1);
      await writeInput(bob.runtime, piece, "count", 5);
      await childValue(bob.result, 110, bob.runtime);
      expect(piece.result.key("compiled").get()?.result?.answer).toBe(108);
      await writeInput(client, piece, "count", 6);
      await childValue(piece.result, 112);
      expect(bob.result.key("compiled").get()?.result?.answer).toBe(110);
      await variantsFor(nestedId, 1);
      expect(
        bob.result.key("compiled").key("result").key("nested")
          .resolveAsCell().getAsNormalizedFullLink().id,
      ).toBe(nestedId);
      expect(host.stats().unstampedSealRefusals).toBe(0);
      expect(servingErrors).toEqual([]);
    } finally {
      await bob?.dispose();
      piece.cancelDemand();
    }
  });

  /** Delivers one child write and observes its committed output. */
  async function bumpChild(
    result: Cell<{ compiled: CompiledView }>,
    reader: Runtime,
    answer: number,
  ) {
    const delivered = Promise.withResolvers<string>();
    sendEvent(result.key("compiled").key("result").key("bump"), {}, (tx) => {
      delivered.resolve(tx.status().status);
    });
    expect(await delivered.promise).not.toBe("error");
    await childValue(result, answer, reader);
    await covered();
  }

  for (const compiled of [false, true]) {
    for (const initialCount of [undefined, 0]) {
      it(`initializes later users' ${initialCount === undefined ? "missing" : "seeded"} session inputs in ${compiled ? "compiled" : "static"} children after reload`, async () => {
        const code = handlerChildProgram(1);
        const parentSource = (compiled ? PER_USER_PARENT : STATIC_CHILD_PARENT)
          .replaceAll("PerUser", "PerSession");
        const piece = await createParent(
          code,
          parentSource,
          true,
          initialCount,
        );
        const later: Awaited<ReturnType<typeof joinParent>>[] = [];
        try {
          await childValue(piece.result, 0);
          await bumpChild(piece.result, client, 1);
          const runtimeCount = servingRuntimes.length;
          await host.spaceServer(space)!.park("test-session-input-recovery");
          const bob = await joinParent(piece, bobSigner, code);
          later.push(bob);
          await childValue(bob.result, 0, bob.runtime);
          expect(servingRuntimes).toHaveLength(runtimeCount + 1);
          const bobOther = await joinParent(piece, bobSigner, code);
          later.push(bobOther);
          await childValue(bobOther.result, 0, bobOther.runtime);
          for (const session of later) {
            expect(
              session.argument.key("count").resolveAsCell()
                .getAsNormalizedFullLink().scope,
            )
              .toBe("session");
          }
          await bumpChild(bob.result, bob.runtime, 1);
          await Promise.all([client.idle(), bobOther.runtime.idle()]);
          expect(bobOther.result.key("compiled").get()?.result?.answer).toBe(0);
          expect(piece.result.key("compiled").get()?.result?.answer).toBe(1);
          await bumpChild(bobOther.result, bobOther.runtime, 1);
          await bumpChild(bobOther.result, bobOther.runtime, 2);
          await bob.runtime.idle();
          expect(bob.result.key("compiled").get()?.result?.answer).toBe(1);
          expect(host.stats().unstampedSealRefusals).toBe(0);
          expect(servingErrors).toEqual([]);
        } finally {
          for (const session of later) await session.dispose();
          piece.cancelDemand();
        }
      });
    }

    it(`preserves a same-address explicit user input in ${compiled ? "compiled" : "static"} children after reload`, async () => {
      const code = handlerChildProgram(1);
      const parentSource = (compiled ? PER_USER_PARENT : STATIC_CHILD_PARENT)
        .replaceAll("PerUser", "PerSession");
      const piece = await createParent(code, parentSource, true);
      const later: Awaited<ReturnType<typeof joinParent>>[] = [];
      try {
        await childValue(piece.result, 0);
        await bumpChild(piece.result, client, 1);
        const explicit = client.getCell(
          space,
          "compile-arg",
          undefined,
          undefined,
          "user",
        ).key("count");
        const rebind = client.edit();
        piece.argument.asSchema(undefined).withTx(rebind).key("count").set(
          explicit,
        );
        expect((await rebind.commit().settled).error).toBeUndefined();
        await covered();
        const runtimeCount = servingRuntimes.length;
        await host.spaceServer(space)!.park(
          "test-explicit-session-input-recovery",
        );
        const bob = await joinParent(piece, bobSigner, code);
        later.push(bob);
        await childValue(bob.result, 0, bob.runtime);
        expect(servingRuntimes).toHaveLength(runtimeCount + 1);
        const bobOther = await joinParent(piece, bobSigner, code);
        later.push(bobOther);
        await childValue(bobOther.result, 0, bobOther.runtime);
        for (const session of later) {
          expect(
            session.argument.key("count").resolveAsCell()
              .getAsNormalizedFullLink().scope,
          )
            .toBe("user");
        }
        await bumpChild(bob.result, bob.runtime, 1);
        await childValue(bobOther.result, 1, bobOther.runtime);
        await bumpChild(bobOther.result, bobOther.runtime, 2);
        await childValue(bob.result, 2, bob.runtime);
        await client.idle();
        expect(piece.result.key("compiled").get()?.result?.answer).toBe(1);
        expect(host.stats().unstampedSealRefusals).toBe(0);
        expect(servingErrors).toEqual([]);
      } finally {
        for (const session of later) await session.dispose();
        piece.cancelDemand();
      }
    });
  }
});
