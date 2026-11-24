import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { resolveLink } from "../src/link-resolution.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

Deno.bench("followWriteRedirects with simple alias", () => {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  const testCell = runtime.getCell<{ value: number }>(
    space,
    "bench-simple-alias",
    undefined,
    tx,
  );
  testCell.set({ value: 42 });

  resolveLink(
    runtime,
    tx,
    {
      ...testCell.getAsNormalizedFullLink(),
      path: ["value"],
      overwrite: "redirect",
    },
    "writeRedirect",
  );

  tx.commit();
  runtime.dispose();
  storageManager.close();
});

Deno.bench("followWriteRedirects with nested aliases (5 levels)", () => {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  const depth = 5;
  const cells: any[] = [];

  for (let i = 0; i < depth; i++) {
    const cell = runtime.getCell<any>(
      space,
      `bench-nested-${i}`,
      undefined,
      tx,
    );
    cells.push(cell);
  }

  cells[depth - 1].set({ finalValue: 999 });

  for (let i = depth - 2; i >= 0; i--) {
    cells[i].setRaw({
      next: cells[i + 1].key("finalValue").getAsWriteRedirectLink(),
    });
  }

  resolveLink(
    runtime,
    tx,
    {
      ...cells[0].getAsNormalizedFullLink(),
      path: ["next"],
      overwrite: "redirect",
    },
    "writeRedirect",
  );

  tx.commit();
  runtime.dispose();
  storageManager.close();
});

Deno.bench("resolveLink with direct reference", () => {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  const cell = runtime.getCell<{ id: number; data: string }>(
    space,
    "bench-resolve",
    undefined,
    tx,
  );
  cell.set({ id: 1, data: "Test data" });

  resolveLink(runtime, tx, cell.getAsNormalizedFullLink());

  tx.commit();
  runtime.dispose();
  storageManager.close();
});

Deno.bench("circular reference navigation (A->B->A->value)", () => {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  const cellA = runtime.getCell<{ b: any; value: string }>(
    space,
    "bench-circular-A",
    undefined,
    tx,
  );
  const cellB = runtime.getCell<{ a: any; value: string }>(
    space,
    "bench-circular-B",
    undefined,
    tx,
  );

  cellA.set({ b: cellB, value: "A" });
  cellB.set({ a: cellA, value: "B" });

  cellA.key("b").key("a").key("value").get();

  tx.commit();
  runtime.dispose();
  storageManager.close();
});

Deno.bench("complex path navigation (6 hops through 3 cells)", () => {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  const cellA = runtime.getCell<{ b: any; c: any; data: { value: number } }>(
    space,
    "bench-complex-A",
    undefined,
    tx,
  );
  const cellB = runtime.getCell<{ a: any; c: any; data: { value: number } }>(
    space,
    "bench-complex-B",
    undefined,
    tx,
  );
  const cellC = runtime.getCell<{ a: any; b: any; data: { value: number } }>(
    space,
    "bench-complex-C",
    undefined,
    tx,
  );

  cellA.set({ b: cellB, c: cellC, data: { value: 100 } });
  cellB.set({ a: cellA, c: cellC, data: { value: 200 } });
  cellC.set({ a: cellA, b: cellB, data: { value: 300 } });

  cellA.key("b").key("c").key("a").key("c").key("data").key("value").get();

  tx.commit();
  runtime.dispose();
  storageManager.close();
});

Deno.bench("array element resolution in circular structures", () => {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  const cellA = runtime.getCell<{ items: any[]; name: string }>(
    space,
    "bench-array-A",
    undefined,
    tx,
  );
  const cellB = runtime.getCell<{ parent: any; index: number }>(
    space,
    "bench-array-B",
    undefined,
    tx,
  );
  const cellC = runtime.getCell<{ parent: any; index: number }>(
    space,
    "bench-array-C",
    undefined,
    tx,
  );

  cellA.set({ items: [cellB, cellC], name: "Array Parent" });
  cellB.set({ parent: cellA, index: 0 });
  cellC.set({ parent: cellA, index: 1 });

  cellA.key("items").key(0).key("parent").key("items").key(1).key("index")
    .get();

  tx.commit();
  runtime.dispose();
  storageManager.close();
});

//
// Reactive-list scans
//
// A list scanned through the reactive proxy: what a lift does when it reads a
// collection of linked entries, and the shape the transaction-scoped memo
// exists for. `one element read` is the per-element cost; `whole array read per
// element` is a full pass for each element. The unmemoized cost of both is
// linear in the number of resolutions, so a scan that touches each element more
// than once pays it again per touch.
//

const LIST_LENGTH = 50;

const listBoardSetup = () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  const entries = [];
  for (let index = 0; index < LIST_LENGTH; index++) {
    const entry = runtime.getCell<{ title: string }>(
      space,
      `bench-list-entry-${index}`,
      undefined,
      tx,
    );
    entry.set({ title: `Entry ${index}` });
    entries.push(entry);
  }
  const board = runtime.getCell<unknown[]>(
    space,
    "bench-list-board",
    undefined,
    tx,
  );
  board.set(entries as never);
  return { storageManager, runtime, tx, board };
};

Deno.bench("reactive list: one element read", () => {
  const { storageManager, runtime, tx, board } = listBoardSetup();
  const list = board.get() as unknown[];

  for (let index = 0; index < LIST_LENGTH; index++) void list[index];

  tx.commit();
  runtime.dispose();
  storageManager.close();
});

Deno.bench("reactive list: whole array read per element", () => {
  const { storageManager, runtime, tx, board } = listBoardSetup();
  const list = board.get() as unknown[];

  // Every `filter` materializes every element, so this touches each element
  // once per element -- the scan an author writes when a row needs to know
  // about the other rows.
  for (let index = 0; index < LIST_LENGTH; index++) {
    void list.filter((_entry, other) => other !== index);
  }

  tx.commit();
  runtime.dispose();
  storageManager.close();
});

//
// A path that never stops growing
//

Deno.bench("resolveLink with infinitely growing path (A->A/foo)", () => {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  const cellA = runtime.getCell<any>(
    space,
    "bench-growing-path",
    undefined,
    tx,
  );

  // Create a link from A to A/foo using setRaw to bypass cycle detection on write
  cellA.setRaw(cellA.key("foo").getAsLink());

  // resolveLink detects the self-subpath cycle on the first hop and throws
  let threw = false;
  try {
    resolveLink(runtime, tx, cellA.getAsNormalizedFullLink());
  } catch (e) {
    if (e instanceof Error && e.message.includes("Link cycle detected")) {
      threw = true;
    } else {
      throw e;
    }
  }

  if (!threw) {
    throw new Error("Expected resolveLink to throw a cycle error");
  }

  tx.commit();
  runtime.dispose();
  storageManager.close();
});
