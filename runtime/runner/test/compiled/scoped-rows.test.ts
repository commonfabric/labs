import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { maxOf } from "@commonfabric/collections/math";
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
    `../../../../base/pattern-compiler/compare/fixtures/scoped-view-rows.${extension}`,
    import.meta.url,
  );

const [{ patterns }] = JSON.parse(
  await Deno.readTextFile(fixture("emit.json")),
) as { patterns: Artifact[] }[];
const MAIN = patterns.find(({ name }) => name === "default")!;
const PROGRAM = {
  main: "/scoped-view-rows.tsx",
  files: [{
    name: "/scoped-view-rows.tsx",
    contents: await Deno.readTextFile(fixture("tsx")),
  }],
};

// `fixtures/scoped-view-rows.tsx` under the serving loop: the rows of a
// `map` over an array of references each say whether the acting session
// has a nickname, a value of the scope `session`. The crate plans that
// expression as a cone of its own per element key and the row places it
// (P454), so each row is a row document of the space that holds a link to
// the row's place, a document of its own with an instance for each
// session that derived it. Two principals read the piece of the first
// one's space.
describe("rows of a `map` over an array of references under the serving loop, whose body reads a value of the scope `session`", () => {
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
   * A piece over `size` items, read by two principals, `ann` giving her
   * session a nickname, and an edit of the title of one item: what the
   * serving runtime's executor holds in scope instances, and the documents
   * the edit changed that the second client was delivered.
   */
  const run = async (size: number) => {
    const [ann, bob] = await Promise.all([
      Identity.fromPassphrase(`compiled scoped rows ann ${size}`),
      Identity.fromPassphrase(`compiled scoped rows bob ${size}`),
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
    const row = ["children", 2, 3, "children", 0];
    await reads(first, result, row, (held) => held === "item 3");
    await reads(second, result, row, (held) => held === "item 3");
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
    await reads(first, result, row, (held) => held === "item 3!");
    await reads(second, result, row, (held) => held === "item 3");
    await serving.host.whenQuiescent();
    const [piece] = serving.pieces();
    const instances = () =>
      [...piece.instance.store.docs].filter(([, { kind }]) =>
        kind === "scope instance"
      ).map(([, document]) => JSON.stringify(document.value).length);
    const before = instances();
    const writes = piece.transactions.counts.writes;
    const delivered: { change: string; size: number }[] = [];
    const deliveries = {
      next(
        notification: Parameters<
          Parameters<Runtime["storageManager"]["subscribe"]>[0]["next"]
        >[0],
      ) {
        if (notification.type === "reset") return undefined;
        for (const { address, after } of notification.changes) {
          delivered.push({
            change: `${address.id} ${address.scope ?? "space"}`,
            size: (JSON.stringify(after) ?? "").length,
          });
        }
        return undefined;
      },
    };
    second.storageManager.subscribe(deliveries);
    const edit = first.edit();
    items[3].withTx(edit).key("title").set("renamed");
    expect((await edit.commit().settled).error).toBeUndefined();
    await reads(second, result, row, (held) => held === "renamed");
    await reads(first, result, row, (held) => held === "renamed!");
    await serving.host.whenQuiescent();
    second.storageManager.unsubscribe?.(deliveries);
    const changes = new Map<string, number>();
    for (const { change, size } of delivered) {
      changes.set(change, Math.max(changes.get(change) ?? 0, size));
    }
    return {
      instances: before.length,
      largest: maxOf(before),
      writes: piece.transactions.counts.writes - writes,
      delivered: [...changes],
      refusals: piece.refusals,
    };
  };

  it("holds one place per row and session, of a size that does not follow the rows, and delivers the same documents of the same size for an edit of one item, at 10 items as at 100", async () => {
    const small = await run(10);
    const large = await run(100);

    // One place more for each further row, in each session that derived
    // the rows.
    expect((large.instances - small.instances) % 90).toBe(0);
    expect(large.instances).toBeGreaterThan(small.instances);
    expect(large.largest - small.largest).toBeLessThanOrEqual(2);
    expect(large.delivered.length).toBe(small.delivered.length);
    const sizes = ({ delivered }: { delivered: [string, number][] }) =>
      delivered.map(([change, size]) => [change.split(" ")[1], size]).sort();
    expect(sizes(large)).toEqual(sizes(small));
    expect(large.writes).toBe(small.writes);
    expect([...small.refusals, ...large.refusals]).toEqual([]);
  });
});
