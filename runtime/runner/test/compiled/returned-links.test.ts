import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { Runtime } from "../../src/runtime.ts";
import { openStorage, type TestStorage } from "./storage.ts";

/** The pattern of `compare/fixtures/returned-links.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/returned-links.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

/** The entity a stored link names, or nothing where the value is no link. */
const linkedId = (value: unknown): string | undefined => {
  const link = (value as { "/"?: { "link@1"?: { id?: string } } } | undefined)
    ?.["/"]?.["link@1"];
  return link?.id;
};

describe("returned-links", () => {
  // `fixtures/returned-links.tsx` on a compiled piece: `lift` bodies that
  // return what they read through a link. A value passed on unchanged is
  // stored as the link to where it was read (ES §2.4), as today's path
  // stores it; a value the body made of it is stored as the value.

  let runtime: Runtime;
  let storageManager: TestStorage;
  let space: MemorySpace;
  let pieces: CompiledPiece[];

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("compiled returned links");
    space = signer.did();
    storageManager = openStorage(signer);
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { compiledPatterns: true },
    });
    pieces = [];
  });

  afterEach(async () => {
    for (const piece of pieces) piece.stop();
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.dispose();
    await storageManager.close();
  });

  /**
   * The stored value of the result of a piece over two items, each a
   * document of its own, two plain values in place, and a record that
   * links the first item.
   */
  const stored = async (): Promise<
    { result: Record<string, unknown>; first: string; second: string }
  > => {
    const item = async (name: string, title: string) => {
      const seed = runtime.edit();
      const cell = runtime.getCell<{ title: string }>(
        space,
        name,
        undefined,
        seed,
      );
      cell.set({ title });
      expect((await seed.commit().settled).error).toBeUndefined();
      return cell;
    };
    const [first, second] = [
      await item("first", "a"),
      await item("second", "b"),
    ];
    const result = runtime.getCell<Record<string, unknown>>(space, "result");
    const tx = runtime.edit();
    pieces.push(
      startCompiledPiece(
        runtime,
        tx,
        await artifact(),
        {
          items: [first.withTx(tx), second.withTx(tx)],
          rows: [{ title: "r" }, { title: "s" }],
          holder: { item: first.withTx(tx) },
        },
        result.withTx(tx),
      ),
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.scheduler.idleWithPendingCommits();
    await result.sync();
    return {
      result: result.getRaw() as Record<string, unknown>,
      first: (first as Cell<unknown>).getAsNormalizedFullLink().id,
      second: (second as Cell<unknown>).getAsNormalizedFullLink().id,
    };
  };

  it("stores the link to the item where a body returns an element of an array of references, declared `unknown` and by its type (case a)", async () => {
    const { result, first } = await stored();

    expect(linkedId(result.element)).toBe(first);
    expect(linkedId(result.typedElement)).toBe(first);
  });

  it("stores the link to the item where a body returns a member it reached through a link at a static path (case c)", async () => {
    const { result, first } = await stored();

    expect(linkedId(result.member)).toBe(first);
  });

  it("stores the link to each item inside a record and an array a body builds (case e)", async () => {
    const { result, first, second } = await stored();

    expect(linkedId((result.picked as { picked: unknown }).picked)).toBe(
      first,
    );
    expect((result.kept as unknown[]).map(linkedId)).toEqual([first, second]);
  });

  it("stores a value where a body made one of an element, and where an element has no document of its own (case d)", async () => {
    const { result } = await stored();

    expect(result.renamed).toEqual({ title: "a!" });
    expect(result.row).toEqual({ title: "r" });
    expect(result.title).toBe("a");
  });
});
