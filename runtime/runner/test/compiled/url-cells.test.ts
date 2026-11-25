import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { MemorySpace } from "../../src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { unansweredRequestOf } from "../../src/compiled/wish.ts";
import { Runtime } from "../../src/runtime.ts";
import { openStorage, type TestStorage } from "./storage.ts";

/** The pattern of `compare/fixtures/url-cells.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/url-cells.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

/** What the tests read of the piece's result. */
type Held = { targets: { named: boolean[]; cells: unknown[] } };

// The request of each element's effect is answered by the runtime's own
// `cellFromUrl`, which parses the URL and stores a link to the cell it names.
describe("a compiled piece whose pattern requests `cellFromUrl`", () => {
  let runtime: Runtime;
  let storageManager: TestStorage;
  let space: MemorySpace;
  let piece: CompiledPiece | undefined;

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("compiled piece cellFromUrl");
    space = signer.did();
    storageManager = openStorage(signer);
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
    piece = undefined;
  });

  afterEach(async () => {
    piece?.stop();
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.dispose();
    await storageManager.close();
  });

  it("is a program a compiled piece can run", async () => {
    expect(unansweredRequestOf({ main: await artifact() })).toBeUndefined();
  });

  /**
   * Starts the piece over the two links `links` makes of a web page's URL
   * and of a URL that names a cell holding `{ title: "the target" }`, and
   * returns what the piece holds once the runtime answered.
   */
  const started = async (
    links: (urls: string[], tx: ReturnType<Runtime["edit"]>) => unknown[],
  ): Promise<Held> => {
    const target = runtime.getCell<{ title: string }>(space, "url-target");
    const tx = runtime.edit();
    target.withTx(tx).set({ title: "the target" });
    const id = target.getAsNormalizedFullLink().id;
    const result = runtime.getCell<Record<string, unknown>>(space, "urls");
    piece = startCompiledPiece(
      runtime,
      tx,
      await artifact(),
      { links: links(["https://example.com/page", `/${id}`], tx) },
      result.withTx(tx),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.scheduler.idleWithPendingCommits();
    await clock.settle();
    await runtime.scheduler.idleWithPendingCommits();
    expect(piece.refusals).toEqual([]);
    return piece.instance.result() as Held;
  };

  it("holds the cell a link's URL names, over an array of references", async () => {
    const { targets } = await started((urls, tx) =>
      urls.map((url, index) => {
        const link = runtime.getCell<{ url: string }>(space, `link-${index}`);
        link.withTx(tx).set({ url });
        return link;
      })
    );

    expect(targets.named[1]).toBe(true);
    expect(targets.cells.at(-1)).toEqual({ title: "the target" });
  });

  it("holds the cell a link's URL names, over an array of plain values in place", async () => {
    const { targets } = await started((urls) => urls.map((url) => ({ url })));

    expect(targets.named[1]).toBe(true);
    expect(targets.cells.at(-1)).toEqual({ title: "the target" });
  });
});
