/**
 * Benchmarks Cell.set()/get() for a FLAT LIST of many similar shallow items —
 * the "search index / autocomplete list" shape.
 *
 * Why: a production capture of a Mobile Loom boot (loom repo,
 * docs/development/projects/mobile-loom-production-performance/findings.md,
 * 2026-07-10 HAR forensics) showed a ~3k-item derived jump-search list
 * weighing ~1.33MB per copy (~445B/item) and re-materialized once per
 * consuming pattern instance — 58% of a 25MB boot payload. Before assigning
 * blame between the runtime and that usage, this bench measures the
 * runtime's NATIVE dynamics for the shape in isolation:
 *
 *   1. write cost + stored bytes + docs created for one flat array in ONE
 *      doc vs one doc PER ITEM, as f(N)
 *   2. read cost in fresh transaction-bound cells: first whole-array get(),
 *      repeated schemaless get(), and repeated get() through a JSON schema,
 *      as f(N)
 *   3. update cost: whole-array re-set with one item changed vs a targeted
 *      per-index write — bytes written per transaction (history growth)
 *
 * The first two group names say how the write is issued, not how many
 * documents it makes. Both report N+1: the runtime gives every object element
 * of an array a document of its own, and the parent array holds a link per
 * element.
 *
 * Interpretation guide: if stored bytes ≈ raw JSON and per-tx update bytes
 * ≈ one item, the runtime is efficient for this shape and the production
 * bloat is usage (item shape redundancy + per-instance copies). Superlinear
 * read times or whole-doc rewrites on single-item updates would instead be
 * runtime terms.
 *
 * Environment controls:
 * - FLAT_INDEX_LIST_SIZES: comma-separated Ns, default "100,1000,3000"
 * - FLAT_INDEX_LIST_UPDATE_TXS: update transactions per bench, default 20
 * - FLAT_INDEX_LIST_REPORT: "1" (default) prints a one-line stored-bytes/doc
 *   accounting per bench+N to stderr, from one extra untimed run of that
 *   benchmark's scenario; "0" silences the reports and skips those runs
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import {
  type Cell,
  type Frame,
  type JSONSchema,
} from "../src/builder/types.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { benchDiagnostic } from "./bench-diagnostics.ts";
import {
  accountNovelty,
  addAccounts,
  jsonBytes,
  type WriteAccount,
} from "./bench-write-accounting.ts";

const signer = await Identity.fromPassphrase("bench flat index list");
const space = signer.did();
const { commonfabric: { Writable } } = createBuilder();

const SIZES = (Deno.env.get("FLAT_INDEX_LIST_SIZES") ?? "100,1000,3000")
  .split(",")
  .map((s) => {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`FLAT_INDEX_LIST_SIZES entries must be integers >= 1`);
    }
    return n;
  });
const UPDATE_TXS = Number(Deno.env.get("FLAT_INDEX_LIST_UPDATE_TXS") ?? "20");
const REPORT = (Deno.env.get("FLAT_INDEX_LIST_REPORT") ?? "1") !== "0";

// Item shape modeled on the production jump-search entries: an EntityRef-ish
// `data` object plus duplicated presentation fields (~445B/item in the wild).
type IndexItem = {
  data: {
    group: string;
    id: string;
    kind: string;
    label: string;
    name: string;
    path: string;
  };
  group: string;
  label: string;
  searchAliases: string[];
  value: string;
};

function makeItem(i: number, mutation = ""): IndexItem {
  const name = `entry-${i}${mutation}`;
  const id = `FC:Folder ${i % 37}/Subfolder ${i % 11}/${name}.md`;
  return {
    data: {
      group: i % 3 === 0 ? "Folders" : i % 3 === 1 ? "Pages" : "Notes",
      id,
      kind: i % 3 === 0 ? "folder" : "page",
      label: name,
      name,
      path: `Folder ${i % 37}/Subfolder ${i % 11}/${name}.md`,
    },
    group: i % 3 === 0 ? "Folders" : i % 3 === 1 ? "Pages" : "Notes",
    label: name,
    searchAliases: [id],
    value: `${i % 3 === 0 ? "folder" : "page"}:${id}`,
  };
}

function makeList(n: number, mutation = ""): IndexItem[] {
  return Array.from({ length: n }, (_, i) => makeItem(i, mutation));
}

const ITEM_SCHEMA = {
  type: "object",
  properties: {
    data: {
      type: "object",
      properties: {
        group: { type: "string" },
        id: { type: "string" },
        kind: { type: "string" },
        label: { type: "string" },
        name: { type: "string" },
        path: { type: "string" },
      },
    },
    group: { type: "string" },
    label: { type: "string" },
    searchAliases: { type: "array", items: { type: "string" } },
    value: { type: "string" },
  },
} as const satisfies JSONSchema;

const LIST_SCHEMA = {
  type: "array",
  items: ITEM_SCHEMA,
} as const satisfies JSONSchema;

function setup() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  return { runtime, storageManager, tx };
}

async function cleanup(
  runtime: Runtime,
  storageManager: ReturnType<typeof StorageManager.emulate>,
  tx?: IExtendedStorageTransaction,
) {
  if (tx && tx.status().status === "ready") tx.abort();
  await runtime.dispose();
  await storageManager.close();
}

//
// write accounting
//
// A transaction holds its journal only while it is open: commit() releases it
// on the way to settling, so tx.journal.novelty(space) is empty afterwards.
// Each write scenario below therefore takes an `account` callback and hands it
// the transaction while the writes are still on it, just before committing.
//
// A benchmark cannot afford that call inside its timed window, so it does not
// pass one. Instead it runs the same scenario once more, untimed and with the
// callback, and reports what came back. The reports are per bench name, once.
//

type Account = (tx: IExtendedStorageTransaction) => void;

const reported = new Set<string>();

/**
 * Runs `scenario` once with an accounting callback and writes one line for
 * `name`. Repeat calls for the same name do nothing, so a benchmark can ask on
 * every iteration and pay for one run.
 */
async function reportOnce(
  name: string,
  scenario: (account: Account) => Promise<void>,
  format: (account: WriteAccount) => string,
): Promise<void> {
  if (!REPORT || reported.has(name)) return;
  reported.add(name);
  let total: WriteAccount = { docs: 0, bytes: 0 };
  await scenario((tx) => {
    total = addAccounts(total, accountNovelty(tx.journal.novelty(space)));
  });
  benchDiagnostic(`[flat-index-list] ${name}: ${format(total)}`);
}

/** The accounting line for a scenario that stores a list from nothing. */
function creationLine(
  N: number,
  rawBytes: number,
): (a: WriteAccount) => string {
  return ({ docs, bytes }) =>
    `docs=${docs} storedBytes=${bytes} rawJSON=${rawBytes} ` +
    `overhead=${(bytes / rawBytes).toFixed(2)}x ` +
    `perItem=${Math.round(bytes / N)}B`;
}

/** The accounting line for a scenario that runs UPDATE_TXS transactions. */
function updateLine({ docs, bytes }: WriteAccount): string {
  return `txs=${UPDATE_TXS} avgBytes/tx=${Math.round(bytes / UPDATE_TXS)} ` +
    `avgDocs/tx=${(docs / UPDATE_TXS).toFixed(1)} ` +
    `(one raw item≈${jsonBytes(makeItem(0))}B)`;
}

//
// 1. WRITE: one flat array in ONE doc, via a single Cell.set()
//

async function writeOneDoc(
  N: number,
  b?: Deno.BenchContext,
  account?: Account,
): Promise<void> {
  const { runtime, storageManager, tx } = setup();
  const cell = runtime.getCell<IndexItem[]>(
    space,
    `bench-flat-index-one-doc-${N}`,
    undefined,
    tx,
  );
  const list = makeList(N);
  try {
    b?.start();
    cell.set(list);
    account?.(tx);
    await tx.commit().settled;
    b?.end();
  } finally {
    await cleanup(runtime, storageManager, tx);
  }
}

//
// 2. WRITE: one doc PER ITEM (parent array holds cell links)
//

async function writePerItem(
  N: number,
  b?: Deno.BenchContext,
  account?: Account,
): Promise<void> {
  const { runtime, storageManager, tx } = setup();
  const frame: Frame = pushFrame({
    cause: { type: "bench-flat-index-per-item", n: N },
    runtime,
    tx,
    space,
    inHandler: true,
  });
  const parent = runtime.getCell<Cell<IndexItem>[]>(
    space,
    `bench-flat-index-per-item-${N}`,
    undefined,
    tx,
  );
  try {
    b?.start();
    const cells = makeList(N).map((item, i) =>
      Writable.for<IndexItem>(`bench-flat-index-item-${N}-${i}`)
        .set(item) as unknown as Cell<IndexItem>
    );
    parent.set(cells);
    account?.(tx);
    await tx.commit().settled;
    b?.end();
  } finally {
    popFrame(frame);
    await cleanup(runtime, storageManager, tx);
  }
}

for (const N of SIZES) {
  const rawBytes = jsonBytes(makeList(N));

  Deno.bench({
    name: `flat list ONE doc - cell.set(${N} items) + commit`,
    group: `write-${N}`,
    baseline: true,
    async fn(b) {
      await reportOnce(
        `one-doc write N=${N}`,
        (account) => writeOneDoc(N, undefined, account),
        creationLine(N, rawBytes),
      );
      await writeOneDoc(N, b);
    },
  });

  Deno.bench({
    name: `flat list PER-ITEM docs - ${N} Writable.set + parent set + commit`,
    group: `write-${N}`,
    async fn(b) {
      await reportOnce(
        `per-item write N=${N}`,
        (account) => writePerItem(N, undefined, account),
        creationLine(N, rawBytes),
      );
      await writePerItem(N, b);
    },
  });
}

//
// 3. READ: one whole-array get() in a fresh tx, then repeated reads in one tx
//

for (const N of SIZES) {
  Deno.bench({
    name: `flat list read - fresh-tx schemaless get() (${N} items)`,
    group: `read-materialize-${N}`,
    baseline: true,
    async fn(b) {
      const { runtime, storageManager, tx } = setup();
      const cell = runtime.getCell<IndexItem[]>(
        space,
        `bench-flat-index-read-first-${N}`,
        undefined,
        tx,
      );
      cell.set(makeList(N));
      await tx.commit().settled;
      const readTx = runtime.edit();
      const reader = cell.withTx(readTx);
      try {
        b.start();
        reader.get();
        b.end();
      } finally {
        await cleanup(runtime, storageManager, readTx);
      }
    },
  });

  Deno.bench({
    name: `flat list read - fresh-tx schema get() (${N} items)`,
    group: `read-materialize-${N}`,
    async fn(b) {
      const { runtime, storageManager, tx } = setup();
      const cell = runtime.getCell(
        space,
        `bench-flat-index-read-first-schema-${N}`,
        LIST_SCHEMA,
        tx,
      );
      cell.set(makeList(N));
      await tx.commit().settled;
      const readTx = runtime.edit();
      const reader = cell.withTx(readTx);
      try {
        b.start();
        reader.get();
        b.end();
      } finally {
        await cleanup(runtime, storageManager, readTx);
      }
    },
  });

  Deno.bench({
    name:
      `flat list read - same-tx schemaless get() x100, unchanged (${N} items)`,
    group: `read-cache-${N}`,
    baseline: true,
    async fn(b) {
      const { runtime, storageManager, tx } = setup();
      const cell = runtime.getCell<IndexItem[]>(
        space,
        `bench-flat-index-read-repeat-${N}`,
        undefined,
        tx,
      );
      cell.set(makeList(N));
      await tx.commit().settled;
      const readTx = runtime.edit();
      const reader = cell.withTx(readTx);
      try {
        reader.get(); // warm the per-transaction cache
        b.start();
        for (let i = 0; i < 100; i++) reader.get();
        b.end();
      } finally {
        await cleanup(runtime, storageManager, readTx);
      }
    },
  });

  Deno.bench({
    name: `flat list read - same-tx schema get() x100, unchanged (${N} items)`,
    group: `read-cache-${N}`,
    async fn(b) {
      const { runtime, storageManager, tx } = setup();
      const cell = runtime.getCell(
        space,
        `bench-flat-index-read-schema-${N}`,
        LIST_SCHEMA,
        tx,
      );
      cell.set(makeList(N));
      await tx.commit().settled;
      const readTx = runtime.edit();
      const reader = cell.withTx(readTx);
      try {
        reader.get(); // warm the per-transaction cache
        b.start();
        for (let i = 0; i < 100; i++) reader.get();
        b.end();
      } finally {
        await cleanup(runtime, storageManager, readTx);
      }
    },
  });
}

//
// 4. UPDATE: three writer profiles for "one item changed"
//
// They are distinguished because they have wildly different write footprints:
//
//   a. REGENERATE from scratch (what a derivation/lift recompute does):
//      fresh objects carry no doc identity → every element re-minted.
//   b. READ-MODIFY-WRITE (the idiomatic handler edit): objects returned
//      by get() carry their doc identity → only the changed element and
//      the parent write.
//   c. TARGETED key(i).set: bypasses the array diff entirely.
//

async function updateRegenerate(
  N: number,
  b?: Deno.BenchContext,
  account?: Account,
): Promise<void> {
  const { runtime, storageManager, tx: setupTx } = setup();
  const cell0 = runtime.getCell<IndexItem[]>(
    space,
    `bench-flat-index-update-set-${N}`,
    undefined,
    setupTx,
  );
  cell0.set(makeList(N));
  await setupTx.commit().settled;

  b?.start();
  for (let t = 0; t < UPDATE_TXS; t++) {
    const tx = runtime.edit();
    const cell = runtime.getCell<IndexItem[]>(
      space,
      `bench-flat-index-update-set-${N}`,
      undefined,
      tx,
    );
    const list = makeList(N);
    list[t % N] = makeItem(t % N, `-mut${t}`);
    cell.set(list);
    account?.(tx);
    await tx.commit().settled;
  }
  b?.end();
  await cleanup(runtime, storageManager);
}

async function updateReadModifyWrite(
  N: number,
  b?: Deno.BenchContext,
  account?: Account,
): Promise<void> {
  const { runtime, storageManager, tx: setupTx } = setup();
  const cell0 = runtime.getCell<IndexItem[]>(
    space,
    `bench-flat-index-update-rmw-${N}`,
    undefined,
    setupTx,
  );
  cell0.set(makeList(N));
  await setupTx.commit().settled;

  b?.start();
  for (let t = 0; t < UPDATE_TXS; t++) {
    const tx = runtime.edit();
    const cell = runtime.getCell<IndexItem[]>(
      space,
      `bench-flat-index-update-rmw-${N}`,
      undefined,
      tx,
    );
    // Idiomatic edit: read the current array (elements carry their doc
    // identity), replace ONE element, write the array back.
    const current = cell.get();
    const list = [...current];
    list[t % N] = makeItem(t % N, `-mut${t}`);
    cell.set(list);
    account?.(tx);
    await tx.commit().settled;
  }
  b?.end();
  await cleanup(runtime, storageManager);
}

async function updateTargeted(
  N: number,
  b?: Deno.BenchContext,
  account?: Account,
): Promise<void> {
  const { runtime, storageManager, tx: setupTx } = setup();
  const cell0 = runtime.getCell<IndexItem[]>(
    space,
    `bench-flat-index-update-key-${N}`,
    undefined,
    setupTx,
  );
  cell0.set(makeList(N));
  await setupTx.commit().settled;

  b?.start();
  for (let t = 0; t < UPDATE_TXS; t++) {
    const tx = runtime.edit();
    const cell = runtime.getCell<IndexItem[]>(
      space,
      `bench-flat-index-update-key-${N}`,
      undefined,
      tx,
    );
    cell.key(t % N).set(makeItem(t % N, `-mut${t}`));
    account?.(tx);
    await tx.commit().settled;
  }
  b?.end();
  await cleanup(runtime, storageManager);
}

for (const N of SIZES) {
  Deno.bench({
    name:
      `flat list update - REGENERATE from scratch, 1 item changed (${N} items)`,
    group: `update-${N}`,
    baseline: true,
    async fn(b) {
      await reportOnce(
        `update regenerate N=${N}`,
        (account) => updateRegenerate(N, undefined, account),
        updateLine,
      );
      await updateRegenerate(N, b);
    },
  });

  Deno.bench({
    name: `flat list update - READ-MODIFY-WRITE, 1 item changed (${N} items)`,
    group: `update-${N}`,
    async fn(b) {
      await reportOnce(
        `update read-modify-write N=${N}`,
        (account) => updateReadModifyWrite(N, undefined, account),
        updateLine,
      );
      await updateReadModifyWrite(N, b);
    },
  });

  Deno.bench({
    name: `flat list update - targeted key(i).set, 1 item changed (${N} items)`,
    group: `update-${N}`,
    async fn(b) {
      await reportOnce(
        `update targeted N=${N}`,
        (account) => updateTargeted(N, undefined, account),
        updateLine,
      );
      await updateTargeted(N, b);
    },
  });
}
