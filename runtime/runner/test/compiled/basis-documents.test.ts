import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import {
  basisDocumentOf,
  basisMadePartDocumentOf,
  basisPartDocumentOf,
} from "../../src/compiled/basis.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import {
  resumeCompiledPieceFromBasis,
  type ResumedPiece,
} from "../../src/compiled/resume.ts";
import { Runtime } from "../../src/runtime.ts";
import { type SharedStorage, shareStorage } from "./storage.ts";

const [{ patterns }] = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../../../../base/pattern-compiler/compare/fixtures/scoped-rows-made.emit.json",
      import.meta.url,
    ),
  ),
) as { patterns: Artifact[] }[];
const ARTIFACT = patterns.find(({ name }) => name === "default")!;

const itemsSchema = {
  type: "array",
  items: { type: "object", properties: { title: { type: "string" } } },
} as JSONSchema;

// `fixtures/scoped-rows-made.tsx`: the rows of a `map` over an array of
// references, each with a handler of its own and a value of the scope
// `session` that the row places (P455), and an event that adds an item in
// a document the piece makes. The piece has documents of a scope, so it
// resumes whole (note 892), and its basis lists the documents it made
// that a resume reads as stored.
describe("the basis of a piece whose rows each have a stream and a place of the scope `session`", () => {
  let signer: Identity;
  let space: MemorySpace;
  let shared: SharedStorage;
  let runtimes: Runtime[];
  let pieces: CompiledPiece[];
  let resumes: ResumedPiece[];

  /** A runtime on a session of its own of the shared server. */
  const session = (): Runtime => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: shared.open(signer),
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
    runtimes.push(runtime);
    return runtime;
  };

  const settled = async (runtime: Runtime) => {
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.storageManager.synced();
  };

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("compiled piece basis documents");
    space = signer.did();
    shared = shareStorage();
    runtimes = [];
    pieces = [];
    resumes = [];
  });

  afterEach(async () => {
    for (const piece of pieces) piece.stop();
    for (const resumed of resumes) resumed.stop();
    for (const runtime of runtimes) {
      await runtime.scheduler.idleWithPendingCommits();
      await runtime.dispose();
    }
    await shared.close();
  });

  /** Sends `event` to the stream `name` of `result` and waits. */
  const send = async (
    runtime: Runtime,
    result: Cell<unknown>,
    name: string,
    event: unknown,
  ) => {
    runtime.getCellFromLink(result.getAsNormalizedFullLink()).key(
      name as never,
    ).send(event as never);
    await settled(runtime);
  };

  /** The titles the rows of the tree show, with every link followed. */
  const titles = (runtime: Runtime, result: Cell<unknown>): string[] => {
    const tx = runtime.edit();
    try {
      const tree = JSON.parse(JSON.stringify(
        runtime.getCellFromLink(result.getAsNormalizedFullLink()).withTx(tx)
          .key("$UI" as never).get(),
      )) as { children: { children: string[] }[][] };
      return tree.children[0].map((row) => row.children[0]);
    } finally {
      tx.abort();
    }
  };

  /**
   * The documents of the basis of the piece of `result` that the commits
   * of `run` change: how many documents they list as made by the piece,
   * and their size as JSON after the commit.
   */
  const basisWritten = async (
    runtime: Runtime,
    result: Cell<unknown>,
    run: () => Promise<void>,
  ) => {
    const { id } = result.getAsNormalizedFullLink();
    const root = `of:${basisDocumentOf(id)}`;
    const ofBasis = new Set([
      root,
      ...Array.from({ length: 256 }, (_, part) => [
        `of:${basisPartDocumentOf(id, part)}`,
        `of:${basisMadePartDocumentOf(id, part)}`,
      ]).flat(),
    ]);
    const made = new Set(
      Array.from(
        { length: 256 },
        (_, part) => `of:${basisMadePartDocumentOf(id, part)}`,
      ),
    );
    const changed = new Map<string, unknown>();
    const listener = {
      next(
        notification: Parameters<
          Parameters<Runtime["storageManager"]["subscribe"]>[0]["next"]
        >[0],
      ) {
        if (notification.type !== "commit") return undefined;
        for (const { address, after } of notification.changes) {
          if (ofBasis.has(address.id)) changed.set(address.id, after);
        }
        return undefined;
      },
    };
    runtime.storageManager.subscribe(listener);
    await run();
    runtime.storageManager.unsubscribe?.(listener);
    let listed = 0;
    let bytes = 0;
    for (const [entity, after] of changed) {
      const value = (after as { value?: Record<string, unknown> } | undefined)
        ?.value;
      bytes += (JSON.stringify(after) ?? "").length;
      if (entity === root) {
        listed += Object.keys(
          (value?.documents ?? {}) as Record<string, unknown>,
        ).length;
      } else if (made.has(entity)) {
        listed += Object.keys(value ?? {}).length;
      }
    }
    return { listed, bytes };
  };

  /**
   * A piece over no item that `size` events each add one to, and then a
   * further one: what the commits of the further one change of the basis,
   * and the titles a runtime that resumes the piece from its basis shows.
   */
  const run = async (size: number) => {
    const first = session();
    const items = first.getCell<{ title: string }[]>(
      space,
      `items ${size}`,
      itemsSchema,
    );
    const result = first.getCell<Record<string, unknown>>(
      space,
      `piece ${size}`,
    );
    const tx = first.edit();
    items.withTx(tx).set([]);
    pieces.push(
      startCompiledPiece(first, tx, ARTIFACT, { items }, result.withTx(tx)),
    );
    first.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await settled(first);
    for (let index = 0; index < size; index++) {
      await send(first, result, "add", { title: `item ${index}` });
    }
    const written = await basisWritten(
      first,
      result,
      () => send(first, result, "add", { title: "last" }),
    );
    const shown = titles(first, result);
    const refusals = [...pieces[0].refusals];
    for (const piece of pieces.splice(0)) piece.stop();
    await settled(first);
    const second = session();
    const resumed = await resumeCompiledPieceFromBasis(
      second,
      ARTIFACT,
      second.getCellFromLink(result.getAsNormalizedFullLink()),
    );
    resumes.push(resumed);
    await settled(second);
    return {
      ...written,
      shown,
      resumed: titles(second, result),
      refusals: [...refusals, ...(resumed.piece?.refusals ?? [])],
    };
  };

  it("lists no more documents for an added item at 100 items than at 10, and is resumed from with every row", async () => {
    const small = await run(10);
    const large = await run(100);

    // The documents the further item made, in a part of the list of its
    // own; a part holds about one in 256 of the documents listed.
    expect(large.listed - small.listed).toBeLessThanOrEqual(2);
    expect(large.shown.length).toBe(101);
    expect(large.resumed).toEqual(large.shown);
    expect(small.resumed).toEqual(small.shown);
    expect([...small.refusals, ...large.refusals]).toEqual([]);
  });
});
