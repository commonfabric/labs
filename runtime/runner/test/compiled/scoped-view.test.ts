import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import {
  type CompiledServingMemoryServer,
  listenCompiledServingMemoryServer,
} from "../../src/compiled/serving-memory-server.deno.ts";
import { setUpCompiledPiece } from "../../src/compiled/setup.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const fixture = (extension: string): URL =>
  new URL(
    `../../../../base/pattern-compiler/compare/fixtures/scoped-view.${extension}`,
    import.meta.url,
  );

const [{ patterns }] = JSON.parse(
  await Deno.readTextFile(fixture("emit.json")),
) as { patterns: Artifact[] }[];
const MAIN = patterns.find(({ name }) => name === "default")!;
const PROGRAM = {
  main: "/scoped-view.tsx",
  files: [{
    name: "/scoped-view.tsx",
    contents: await Deno.readTextFile(fixture("tsx")),
  }],
};

// `fixtures/scoped-view.tsx` under the serving loop: a rendered tree that
// holds the rows of a `map` over an array of references, whose rows read
// nothing of a user, and reads whether the acting user has a nickname, a
// value of the scope `user`, in the condition of a branch and in an
// attribute. Two principals read the piece of the first one's space. The
// crate plans the two expressions as values of their own (P451), and the
// tree holds a reference to the scope instance of each.
describe("a rendered tree under the serving loop that reads a value of the scope `user` beside the rows of a `map` over an array of references", () => {
  let servers: CompiledServingMemoryServer[];
  let clients: Runtime[];
  let cancels: (() => void)[];

  beforeEach(() => {
    servers = [];
    clients = [];
    cancels = [];
  });

  afterEach(async () => {
    for (const cancel of cancels) cancel();
    for (const serving of servers) await serving.host.close();
    for (const client of clients) await client.dispose();
    for (const serving of servers) await serving.close();
  });

  /** Resolves when `runtime` reads at `path` of the tree what `test` takes. */
  const reads = async (
    runtime: Runtime,
    result: Cell<unknown>,
    path: (string | number)[],
    test: (held: unknown) => boolean,
  ) => {
    // deno-lint-ignore no-explicit-any
    let cell: any = runtime.getCellFromLink(result.getAsNormalizedFullLink())
      .key("$UI" as never);
    for (const segment of path) cell = cell.key(segment);
    cancels.push(cell.sink(() => {}));
    await waitForCellValue<unknown>(runtime, cell, test, {
      stuckLabel: `a client reads ${path.join("/")}`,
    });
  };

  /**
   * A piece over `size` items, read by two principals, `ann` giving
   * herself a nickname, and an edit of the title of one item: what the
   * serving runtime's executor holds in scope instances, and the documents
   * the edit changed that a client was delivered.
   */
  const run = async (size: number) => {
    const [ann, bob] = await Promise.all([
      Identity.fromPassphrase(`compiled scoped view ann ${size}`),
      Identity.fromPassphrase(`compiled scoped view bob ${size}`),
    ]);
    const space: MemorySpace = ann.did();
    const serving = await listenCompiledServingMemoryServer({
      // What stands in the place of the crate's binary gives the artifact
      // the crate emitted for the fixture.
      compile: () =>
        Promise.resolve({ main: MAIN, artifacts: () => undefined }),
    });
    servers.push(serving);
    const client = (identity: Identity): Runtime => {
      const runtime = new Runtime({
        apiUrl: serving.url,
        storageManager: StorageManager.open({
          as: identity,
          memoryHost: serving.url,
        }),
        experimental: { serverExecution: true },
      });
      clients.push(runtime);
      return runtime;
    };
    const first = client(ann);
    const items = Array.from(
      { length: size },
      (_, index) => first.getCell<{ title: string }>(space, `item ${index}`),
    );
    const result = first.getCell<Record<string, unknown>>(space, "view");
    const tx = first.edit();
    items.forEach((item, index) =>
      item.withTx(tx).set({ title: `item ${index}` })
    );
    setUpCompiledPiece(first, tx, PROGRAM, { items }, result.withTx(tx));
    expect((await tx.commit().settled).error).toBeUndefined();
    const second = client(bob);
    await reads(
      first,
      result,
      ["children", 2, 3, "children", 0],
      (held) => held === "item 3!",
    );
    await reads(
      second,
      result,
      ["children", 1, "props", "disabled"],
      (held) => held === true,
    );
    const read = first.getCellFromLink<{ call?: unknown }>(
      result.getAsNormalizedFullLink(),
    );
    cancels.push(read.sink(() => {}));
    await waitForCellValue<{ call?: unknown }>(
      first,
      read,
      (held) => held?.call !== undefined,
      {
        stuckLabel: "the first client reads the stream `call`",
      },
    );
    (read.key("call" as never) as unknown as Cell<unknown>).send(
      { name: "Ann" } as never,
    );
    await reads(
      first,
      result,
      ["children", 1, "props", "disabled"],
      (held) => held === false,
    );
    await reads(
      second,
      result,
      ["children", 1, "props", "disabled"],
      (held) => held === true,
    );
    await serving.host.whenQuiescent();
    const [piece] = serving.pieces();
    const scoped = () =>
      [...piece.instance.store.docs].filter(([, { kind }]) =>
        kind === "scope instance"
      ).reduce(
        (sum, [, document]) => sum + JSON.stringify(document.value).length,
        0,
      );
    const before = scoped();
    const writes = piece.transactions.counts.writes;
    const delivered: string[] = [];
    const deliveries = {
      next(
        notification: Parameters<
          Parameters<Runtime["storageManager"]["subscribe"]>[0]["next"]
        >[0],
      ) {
        if (notification.type === "reset") return undefined;
        for (const { address } of notification.changes) {
          delivered.push(`${address.id} ${address.scope ?? "space"}`);
        }
        return undefined;
      },
    };
    second.storageManager.subscribe(deliveries);
    const edit = first.edit();
    items[3].withTx(edit).key("title").set("renamed");
    expect((await edit.commit().settled).error).toBeUndefined();
    await reads(
      second,
      result,
      ["children", 2, 3, "children", 0],
      (held) => held === "renamed!",
    );
    await serving.host.whenQuiescent();
    second.storageManager.unsubscribe?.(deliveries);
    return {
      scoped: before,
      scopedAfter: scoped(),
      writes: piece.transactions.counts.writes - writes,
      delivered: [...new Set(delivered)],
      refusals: piece.refusals,
    };
  };

  it("holds no row in a scope instance and changes one row document and no scope instance for an edit of one item, at 10 items as at 100", async () => {
    const small = await run(10);
    const large = await run(100);

    expect(large.scoped).toBe(small.scoped);
    expect(large.scopedAfter).toBe(large.scoped);
    expect(small.scopedAfter).toBe(small.scoped);
    for (const { delivered } of [small, large]) {
      expect(delivered.filter((change) => !change.endsWith(" space")))
        .toEqual([]);
    }
    expect(large.delivered.length).toBe(small.delivered.length);
    expect(large.writes).toBe(small.writes);
    expect([...small.refusals, ...large.refusals]).toEqual([]);
  });
});
