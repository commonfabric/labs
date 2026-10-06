import {
  FabricUnavailable,
  UNAVAILABLE_PENDING,
  UNAVAILABLE_SYNCING,
  unavailableError,
  unavailableMismatch,
} from "@commonfabric/data-model/availability";

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { latestComplete as latestCompleteBuiltin } from "../src/builtins/latest-complete.ts";
import { type Cell, createCell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { toMemorySpaceAddress } from "../src/link-types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("latest complete test");
const space = signer.did();

const numberSchema = {
  type: "number",
} as const satisfies JSONSchema;

const optionalNumberSchema = {
  anyOf: [{ type: "number" }, { type: "undefined" }],
} as const satisfies JSONSchema;

const joinedSchema = {
  type: "object",
  properties: {
    repo: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    ticket: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
    variable: { type: "number" },
  },
  required: ["repo", "ticket", "variable"],
  additionalProperties: false,
} as const satisfies JSONSchema;

describe("latestComplete", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let latestComplete: (
    input: { value: unknown; schema: JSONSchema },
  ) => unknown;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    pattern = commonfabric.pattern;
    latestComplete = commonfabric
      .latestComplete as unknown as typeof latestComplete;
  });

  afterEach(async () => {
    if (tx.status().status === "ready") {
      runtime.prepareTxForCommit(tx);
      await tx.commit().settled;
    }
    await runtime?.dispose();
    await storageManager?.close();
  });

  async function commitAndPull<T>(result: Cell<T>): Promise<void> {
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    tx = runtime.edit();
    await result.pull();
    await runtime.idle();
  }

  async function writeAndSettle<T>(
    source: Cell<T>,
    value: T,
    result: Cell<unknown>,
  ): Promise<void> {
    source.withTx(tx).set(value);
    await commitAndPull(result);
  }

  function raw(cell: Cell<unknown>): unknown {
    return cell.resolveAsCell().getRaw();
  }

  it("reinitializes a snapshot after its staged write is aborted", async () => {
    for (const initial of [7, UNAVAILABLE_PENDING]) {
      const cause = `aborted latest snapshot ${typeof initial}`;
      const source = runtime.getCell<unknown>(
        space,
        `${cause} source`,
        undefined,
        tx,
      );
      source.set(initial);
      const inputs = runtime.getCell<{ value: unknown; schema: JSONSchema }>(
        space,
        `${cause} inputs`,
        undefined,
        tx,
      );
      inputs.set({ value: source.getAsLink(), schema: numberSchema });
      const parent = runtime.getCell(space, `${cause} parent`, undefined, tx);
      parent.set({});
      const binding = runtime.getCell(space, `${cause} binding`)
        .getAsNormalizedFullLink();
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).ok).toBeDefined();

      let snapshot: Cell<unknown> | undefined;
      const action = latestCompleteBuiltin(
        inputs,
        (_, result) => {
          snapshot = result as Cell<unknown>;
        },
        () => {},
        cause,
        parent,
        runtime,
        binding,
      );
      tx = runtime.edit();
      await action(tx);
      expect(snapshot).toBeDefined();
      expect(snapshot!.withTx(tx).getRaw()).toBe(initial);
      source.withTx(tx).set(UNAVAILABLE_PENDING);
      await action(tx);
      expect(snapshot!.withTx(tx).getRaw()).toBe(initial);
      tx.abort();

      tx = runtime.edit();
      source.withTx(tx).set(UNAVAILABLE_PENDING);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).ok).toBeDefined();
      tx = runtime.edit();
      await action(tx);

      expect(snapshot!.withTx(tx).getRaw()).toBe(UNAVAILABLE_PENDING);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).ok).toBeDefined();
      tx = runtime.edit();
      expect(snapshot!.withTx(tx).getRaw()).toBe(UNAVAILABLE_PENDING);
    }
  });

  it("waits initially and retains the last complete scalar", async () => {
    const source = runtime.getCell<number | FabricUnavailable>(
      space,
      "latest complete scalar source",
      undefined,
      tx,
    );
    source.set(UNAVAILABLE_PENDING);

    const Root = pattern<{ source: unknown }>(({ source }) => ({
      snapshot: latestComplete({ value: source, schema: numberSchema }),
    }));
    const result = runtime.run(
      tx,
      Root,
      { source: source.getAsLink() },
      runtime.getCell(space, "latest complete scalar result", undefined, tx),
    );

    await commitAndPull(result);
    expect(raw(result.key("snapshot"))).toBe(UNAVAILABLE_PENDING);

    await writeAndSettle(source, 1, result);
    expect(result.key("snapshot").get()).toBe(1);

    await writeAndSettle(source, UNAVAILABLE_PENDING, result);
    expect(result.key("snapshot").get()).toBe(1);

    await writeAndSettle(
      source,
      unavailableError(new Error("refresh")),
      result,
    );
    expect(result.key("snapshot").get()).toBe(1);

    await writeAndSettle(source, 2, result);
    expect(result.key("snapshot").get()).toBe(2);
  });

  it("updates an object join only when every input is complete", async () => {
    const repo = runtime.getCell<unknown>(space, "latest repo", undefined, tx);
    const ticket = runtime.getCell<unknown>(
      space,
      "latest ticket",
      undefined,
      tx,
    );
    const variable = runtime.getCell<number>(
      space,
      "latest variable",
      undefined,
      tx,
    );
    repo.set({ name: "one", ignored: true });
    ticket.set(UNAVAILABLE_PENDING);
    variable.set(1);

    const Root = pattern<{
      repo: unknown;
      ticket: unknown;
      variable: number;
    }>(({ repo, ticket, variable }) => ({
      snapshot: latestComplete({
        value: { repo, ticket, variable },
        schema: joinedSchema,
      }),
    }));
    const result = runtime.run(
      tx,
      Root,
      {
        repo: repo.getAsLink(),
        ticket: ticket.getAsLink(),
        variable: variable.getAsLink(),
      },
      runtime.getCell(space, "latest joined result", undefined, tx),
    );

    await commitAndPull(result);
    expect(raw(result.key("snapshot"))).toBe(UNAVAILABLE_PENDING);

    await writeAndSettle(variable, 2, result);
    expect(raw(result.key("snapshot"))).toBe(UNAVAILABLE_PENDING);

    await writeAndSettle(ticket, { title: "ready", ignored: true }, result);
    expect(result.key("snapshot").get()).toEqual({
      repo: { name: "one" },
      ticket: { title: "ready" },
      variable: 2,
    });

    await writeAndSettle(ticket, UNAVAILABLE_SYNCING, result);
    await writeAndSettle(repo, { name: "two" }, result);
    await writeAndSettle(variable, 3, result);
    expect(result.key("snapshot").get()).toEqual({
      repo: { name: "one" },
      ticket: { title: "ready" },
      variable: 2,
    });

    await writeAndSettle(ticket, { title: "next" }, result);
    expect(result.key("snapshot").get()).toEqual({
      repo: { name: "two" },
      ticket: { title: "next" },
      variable: 3,
    });
  });

  it("distinguishes a complete undefined snapshot from no snapshot", async () => {
    const source = runtime.getCell<number | FabricUnavailable | undefined>(
      space,
      "latest optional source",
      undefined,
      tx,
    );
    source.set(unavailableMismatch());

    const Root = pattern<{ source: unknown }>(({ source }) => ({
      snapshot: latestComplete({ value: source, schema: optionalNumberSchema }),
    }));
    const result = runtime.run(
      tx,
      Root,
      { source: source.getAsLink() },
      runtime.getCell(space, "latest optional result", undefined, tx),
    );

    await commitAndPull(result);
    expect(raw(result.key("snapshot"))).toBe(UNAVAILABLE_PENDING);

    await writeAndSettle(source, undefined, result);
    const snapshot = result.key("snapshot").resolveAsCell();
    const stored = tx.read(
      toMemorySpaceAddress(snapshot.getAsNormalizedFullLink()),
    );
    expect(stored.ok).toBeDefined();
    expect(stored.ok?.value).toBeUndefined();

    await writeAndSettle(source, UNAVAILABLE_PENDING, result);
    const retained = tx.read(
      toMemorySpaceAddress(snapshot.getAsNormalizedFullLink()),
    );
    expect(retained.ok).toBeDefined();
    expect(retained.ok?.value).toBeUndefined();

    await writeAndSettle(source, 4, result);
    expect(result.key("snapshot").get()).toBe(4);
  });

  it("uses the narrowest input scope for its persisted snapshot", async () => {
    const baseSource = runtime.getCell<number>(
      space,
      "latest scoped source",
      undefined,
      tx,
    );
    const source = createCell<number>(
      runtime,
      { ...baseSource.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    source.set(9);

    const Root = pattern<{ source: number }>(({ source }) => ({
      snapshot: latestComplete({ value: source, schema: numberSchema }),
    }));
    const result = runtime.run(
      tx,
      Root,
      { source: source.getAsLink() },
      runtime.getCell(space, "latest scoped result", undefined, tx),
    );

    await commitAndPull(result);
    const snapshot = result.key("snapshot").resolveAsCell();
    expect(snapshot.get()).toBe(9);
    expect(snapshot.getAsNormalizedFullLink().scope).toBe("user");
  });
});

describe("latestComplete cold resume", () => {
  const resultCause = "latest complete cold resume result";
  const program: RuntimeProgram = {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        'import { AsyncResult, latestComplete, pattern } from "commonfabric";',
        "export default pattern<{ request: AsyncResult<number> }>(",
        "  ({ request }) => ({ snapshot: latestComplete(request) }),",
        ");",
      ].join("\n"),
    }],
  };

  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    await storageManager?.close();
  });

  it("keeps the durable snapshot when resumed with a pending source", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    try {
      const tx1 = rt1.edit();
      const source = rt1.getCell<number | FabricUnavailable>(
        space,
        "latest complete cold resume source",
        undefined,
        tx1,
      );
      source.set(7);
      const compiled = await rt1.patternManager.compilePattern(program, {
        space,
        tx: tx1,
      });
      const result1 = rt1.getCell<{ snapshot: number }>(
        space,
        resultCause,
        compiled.resultSchema,
        tx1,
      );
      const run1 = rt1.run(
        tx1,
        compiled,
        { request: source.getAsLink() },
        result1,
      );
      await tx1.commit().settled;
      await run1.pull();
      await rt1.idle();
      expect(run1.key("snapshot").get()).toBe(7);

      const pendingTx = rt1.edit();
      source.withTx(pendingTx).set(UNAVAILABLE_PENDING);
      await pendingTx.commit().settled;
      await run1.pull();
      await rt1.idle();
      expect(run1.key("snapshot").get()).toBe(7);

      await rt1.patternManager.flushCompileCacheWrites();
      await storageManager.synced();
      rt1.scheduler.dispose();

      const tx2 = rt2.edit();
      const result2 = rt2.getCell<{ snapshot: number }>(
        space,
        resultCause,
        compiled.resultSchema,
        tx2,
      );
      await tx2.commit().settled;
      await result2.sync();
      expect(await rt2.start(result2)).toBe(true);

      for (let attempt = 0; attempt < 4; attempt++) {
        await result2.pull();
        await rt2.idle();
      }
      expect(result2.key("snapshot").get()).toBe(7);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});
