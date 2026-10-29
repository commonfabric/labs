import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";
import type { URI } from "../interface.ts";
import {
  applyCommit,
  close,
  type Engine,
  listEntityIds,
  open,
} from "../v2/engine.ts";

const BATCH_SIZE = 1_000;
const SPACE = "did:key:z6Mk-memory-v2-entity-id-list-bench";
const SESSION = "session:entity-id-list-bench";
const CURRENT_LIST_SQL = `
SELECT id
FROM head
WHERE branch = :branch
  AND scope_key = :scope_key
  AND op <> 'delete'
ORDER BY id ASC
`;
const LEGACY_LIST_SQL = `
SELECT h.id
FROM head h
JOIN revision r
 ON r.branch = h.branch
 AND r.id = h.id
 AND r.scope_key = h.scope_key
 AND r.seq = h.seq
 AND r.op_index = h.op_index
WHERE h.branch = :branch
  AND h.scope_key = :scope_key
  AND r.op <> 'delete'
ORDER BY h.id ASC
`;

interface FixtureOptions {
  name: string;
  liveCount: number;
  tombstoneCount?: number;
  payloadBytes: number;
  legacyComparator?: boolean;
}

interface Fixture extends FixtureOptions {
  engine: Engine;
  path: string;
  headCount: number;
  sqliteBytes: number;
  pageCount: number;
  pageSize: number;
  idBytes: number;
  currentPlan: string;
  legacyPlan?: string;
}

const fixtures: Fixture[] = [];
let observedCount = 0;

function idFor(index: number): URI {
  return `of:entity-id-list-bench-${String(index).padStart(7, "0")}` as URI;
}

function sqliteFileBytes(path: string): number {
  let total = 0;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      total += Deno.statSync(candidate).size;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return total;
}

function removeSqliteFiles(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      Deno.removeSync(candidate);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}

function pragmaNumber(
  engine: Engine,
  pragma: "page_count" | "page_size",
): number {
  const row = engine.database.prepare(`PRAGMA ${pragma}`).get() as
    | Record<string, number>
    | undefined;
  if (row === undefined) throw new Error(`PRAGMA ${pragma} returned no row`);
  const value = Object.values(row)[0];
  if (typeof value !== "number") {
    throw new Error(`PRAGMA ${pragma} did not return a number`);
  }
  return value;
}

function queryPlan(engine: Engine, sql: string): string {
  return (engine.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({
    branch: "",
    scope_key: "space",
  }) as Array<{ detail: string }>).map(({ detail }) => detail).join(" | ");
}

function applySets(
  engine: Engine,
  start: number,
  count: number,
  payload: string,
  nextLocalSeq: { value: number },
): void {
  for (let offset = 0; offset < count; offset += BATCH_SIZE) {
    const batchCount = Math.min(BATCH_SIZE, count - offset);
    applyCommit(engine, {
      sessionId: SESSION,
      principal: "did:key:alice",
      space: SPACE,
      commit: {
        localSeq: nextLocalSeq.value++,
        reads: { confirmed: [], pending: [] },
        operations: Array.from({ length: batchCount }, (_, batchIndex) => ({
          op: "set" as const,
          id: idFor(start + offset + batchIndex),
          value: { value: { payload } },
        })),
      },
    });
  }
}

function applyDeletes(
  engine: Engine,
  start: number,
  count: number,
  nextLocalSeq: { value: number },
): void {
  for (let offset = 0; offset < count; offset += BATCH_SIZE) {
    const batchCount = Math.min(BATCH_SIZE, count - offset);
    applyCommit(engine, {
      sessionId: SESSION,
      principal: "did:key:alice",
      space: SPACE,
      commit: {
        localSeq: nextLocalSeq.value++,
        reads: { confirmed: [], pending: [] },
        operations: Array.from({ length: batchCount }, (_, batchIndex) => ({
          op: "delete" as const,
          id: idFor(start + offset + batchIndex),
        })),
      },
    });
  }
}

async function createFixture(options: FixtureOptions): Promise<Fixture> {
  console.error(`Seeding ${options.name}...`);
  const path = await Deno.makeTempFile({
    prefix: "v2-entity-id-list-bench-",
    suffix: ".sqlite",
  });
  const engine = await open({ url: toFileUrl(path) });
  const tombstoneCount = options.tombstoneCount ?? 0;
  const headCount = options.liveCount + tombstoneCount;
  const nextLocalSeq = { value: 1 };
  const payload = "x".repeat(options.payloadBytes);

  applySets(engine, 0, headCount, payload, nextLocalSeq);
  if (tombstoneCount > 0) {
    applyDeletes(engine, 0, tombstoneCount, nextLocalSeq);
  }

  const ids = listEntityIds(engine);
  if (ids.length !== options.liveCount) {
    throw new Error(
      `${options.name}: expected ${options.liveCount} live ids, got ${ids.length}`,
    );
  }
  const idBytes = ids.reduce((total, id) => total + id.length, 0);
  const fixture: Fixture = {
    ...options,
    tombstoneCount,
    engine,
    path,
    headCount,
    sqliteBytes: sqliteFileBytes(path),
    pageCount: pragmaNumber(engine, "page_count"),
    pageSize: pragmaNumber(engine, "page_size"),
    idBytes,
    currentPlan: queryPlan(engine, CURRENT_LIST_SQL),
    ...(options.legacyComparator
      ? { legacyPlan: queryPlan(engine, LEGACY_LIST_SQL) }
      : {}),
  };
  console.error(
    `Seeded ${options.name}: live=${options.liveCount}, heads=${headCount}, ` +
      `payload=${options.payloadBytes} B, sqlite=${fixture.sqliteBytes} B, ` +
      `idBytes=${idBytes}`,
  );
  return fixture;
}

fixtures.push(
  await createFixture({
    name: "live-1k-small",
    liveCount: 1_000,
    payloadBytes: 16,
  }),
  await createFixture({
    name: "live-10k-small",
    liveCount: 10_000,
    payloadBytes: 16,
  }),
  await createFixture({
    name: "live-100k-small",
    liveCount: 100_000,
    payloadBytes: 16,
    legacyComparator: true,
  }),
  await createFixture({
    name: "live-10k-large",
    liveCount: 10_000,
    payloadBytes: 4_096,
  }),
  await createFixture({
    name: "lifetime-100k-live-1k",
    liveCount: 1_000,
    tombstoneCount: 99_000,
    payloadBytes: 16,
    legacyComparator: true,
  }),
);

for (const fixture of fixtures) {
  Deno.bench({
    name: `current ${fixture.name}`,
    group: "v2-entity-id-list",
    baseline: fixture.name === "live-1k-small",
    fn() {
      const ids = listEntityIds(fixture.engine);
      if (ids.length !== fixture.liveCount) {
        throw new Error(`unexpected live id count: ${ids.length}`);
      }
      observedCount ^= ids.length;
    },
  });

  if (fixture.legacyComparator) {
    const statement = fixture.engine.database.prepare(LEGACY_LIST_SQL);
    Deno.bench({
      name: `legacy ${fixture.name}`,
      group: "v2-entity-id-list",
      fn() {
        const ids = (statement.all({
          branch: "",
          scope_key: "space",
        }) as Array<{ id: string }>).map(({ id }) => id);
        if (ids.length !== fixture.liveCount) {
          throw new Error(`unexpected legacy live id count: ${ids.length}`);
        }
        observedCount ^= ids.length;
      },
    });
  }
}

async function measureMigration(): Promise<number> {
  const fixture = await createFixture({
    name: "migration-lifetime-100k-live-1k",
    liveCount: 1_000,
    tombstoneCount: 99_000,
    payloadBytes: 16,
  });
  close(fixture.engine);

  const legacyDb = new Database(fixture.path);
  legacyDb.exec(`
    DROP INDEX idx_head_live_entity_ids;
    ALTER TABLE head DROP COLUMN op;
  `);
  legacyDb.close();

  let migrated: Engine | undefined;
  try {
    const startedAt = performance.now();
    migrated = await open({ url: toFileUrl(fixture.path) });
    const duration = performance.now() - startedAt;
    const ids = listEntityIds(migrated);
    if (ids.length !== fixture.liveCount) {
      throw new Error(`unexpected migrated live id count: ${ids.length}`);
    }
    return duration;
  } finally {
    if (migrated !== undefined) close(migrated);
    removeSqliteFiles(fixture.path);
  }
}

const migrationDurationMs = await measureMigration();
console.error(
  `Migrated lifetime-100k-live-1k in ${migrationDurationMs.toFixed(1)} ms`,
);

addEventListener("unload", () => {
  console.error(`Entity ID list benchmark sink: ${observedCount}`);
  for (const fixture of fixtures) {
    console.error(
      `${fixture.name}: live=${fixture.liveCount}, tombstones=${fixture.tombstoneCount}, ` +
        `heads=${fixture.headCount}, payload=${fixture.payloadBytes} B, ` +
        `sqlite=${fixture.sqliteBytes} B, pages=${fixture.pageCount}x${fixture.pageSize}, ` +
        `idBytes=${fixture.idBytes}, currentPlan=${fixture.currentPlan}` +
        (fixture.legacyPlan === undefined
          ? ""
          : `, legacyPlan=${fixture.legacyPlan}`),
    );
    close(fixture.engine);
    removeSqliteFiles(fixture.path);
  }
});
