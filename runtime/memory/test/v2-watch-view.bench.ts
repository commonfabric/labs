import { WatchView } from "../v2/client.ts";
import type { EntityDocument, SessionSync, SessionSyncUpsert } from "../v2.ts";

const ENTITY_COUNT = readIntEnv("WATCH_VIEW_ENTITY_COUNT", 10_000, 1);
const CHANGE_COUNT = readIntEnv("WATCH_VIEW_CHANGE_COUNT", 1_000, 1);

const documentFor = (id: string, seq: number): EntityDocument => ({
  value: { id, seq },
});

const idFor = (index: number): string =>
  `of:watch-view:${String(index).padStart(8, "0")}`;

const interleavedIdAfter = (index: number): string => `${idFor(index)}:new`;

const snapshotFor = (index: number, seq = 1): SessionSyncUpsert => {
  const id = idFor(index);
  return { branch: "", id, seq, doc: documentFor(id, seq) };
};

const snapshotForId = (id: string, seq = 1): SessionSyncUpsert => ({
  branch: "",
  id,
  seq,
  doc: documentFor(id, seq),
});

function readIntEnv(name: string, defaultValue: number, min: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return defaultValue;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(
      `${name} must be an integer >= ${min}; got ${JSON.stringify(raw)}`,
    );
  }

  return value;
}

function makeSync(
  upserts: SessionSyncUpsert[],
  toSeq: number,
  removes: Array<{ branch: string; id: string }> = [],
): SessionSync {
  return {
    type: "sync",
    fromSeq: toSeq - 1,
    toSeq,
    upserts,
    removes,
  };
}

function makeView(entityCount = ENTITY_COUNT): WatchView {
  return WatchView.fromSync(makeSync(
    Array.from({ length: entityCount }, (_, index) => snapshotFor(index)),
    1,
  ));
}

function evenlySpacedExistingIndexes(
  count: number,
  entityCount = ENTITY_COUNT,
): number[] {
  const safeCount = Math.min(count, entityCount);
  const stride = Math.max(1, Math.floor(entityCount / safeCount));
  return Array.from(
    { length: safeCount },
    (_, index) => Math.min(entityCount - 1, index * stride),
  );
}

function interleavedNewIds(
  count: number,
  entityCount = ENTITY_COUNT,
): string[] {
  const safeCount = Math.min(count, entityCount);
  const stride = Math.max(1, Math.floor(entityCount / safeCount));
  return Array.from(
    { length: safeCount },
    (_, index) => interleavedIdAfter(Math.min(entityCount - 1, index * stride)),
  );
}

Deno.bench({
  name:
    `WatchView.applySync existing upserts - entities=${ENTITY_COUNT}, changes=${CHANGE_COUNT}`,
  group: "watch-view-apply-sync",
  baseline: true,
  fn(b) {
    const view = makeView();
    const upserts = evenlySpacedExistingIndexes(CHANGE_COUNT).map((index) =>
      snapshotFor(index, 2)
    );

    b.start();
    view.applySync(makeSync(upserts, 2), false);
    b.end();
  },
});

Deno.bench({
  name:
    `WatchView.applySync new interleaved upserts - entities=${ENTITY_COUNT}, changes=${CHANGE_COUNT}`,
  group: "watch-view-apply-sync",
  fn(b) {
    const view = makeView();
    const upserts = interleavedNewIds(CHANGE_COUNT).map((id) =>
      snapshotForId(id, 2)
    );

    b.start();
    view.applySync(makeSync(upserts, 2), false);
    b.end();
  },
});

Deno.bench({
  name:
    `WatchView.applySync new tail upserts - entities=${ENTITY_COUNT}, changes=${CHANGE_COUNT}`,
  group: "watch-view-apply-sync",
  fn(b) {
    const view = makeView();
    const upserts = Array.from(
      { length: CHANGE_COUNT },
      (_, index) => snapshotFor(ENTITY_COUNT + index, 2),
    );

    b.start();
    view.applySync(makeSync(upserts, 2), false);
    b.end();
  },
});

Deno.bench({
  name:
    `WatchView.applySync interleaved removes - entities=${ENTITY_COUNT}, changes=${CHANGE_COUNT}`,
  group: "watch-view-apply-sync",
  fn(b) {
    const view = makeView();
    const removes = evenlySpacedExistingIndexes(CHANGE_COUNT).map((index) => ({
      branch: "",
      id: idFor(index),
    }));

    b.start();
    view.applySync(makeSync([], 2, removes), false);
    b.end();
  },
});
