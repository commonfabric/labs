import { toFileUrl } from "@std/path";
import type { JSONSchema } from "@commonfabric/api";
import { spliceAll } from "@commonfabric/utils/arrays";
import type { URI } from "../interface.ts";
import type { GraphQuery } from "../v2.ts";
import { applyCommit, close, type Engine, open } from "../v2/engine.ts";
import {
  extendTrackedGraph,
  type QueryTraversalStats,
  refreshTrackedGraph,
  toDirtyKey,
  type TrackedGraphState,
  trackGraph,
} from "../v2/query.ts";

const DOC_COUNT = readIntEnv("V2_QUERY_COVERAGE_DOCS", 1_000, 2);
const DIRTY_PERCENT = readNumberEnv("V2_QUERY_COVERAGE_DIRTY_PERCENT", 1, 0);
const DIRTY_COUNT = Math.max(
  1,
  Math.min(DOC_COUNT - 1, Math.floor(DOC_COUNT * (DIRTY_PERCENT / 100))),
);
const HIDDEN_COUNT = DIRTY_COUNT;
const INCLUDE_STATS = readBoolEnv("V2_QUERY_COVERAGE_STATS", true);

const space = "did:key:z6Mk-memory-v2-query-coverage";
const rootId = "of:v2-query-coverage-root" as URI;
const overlapRootId = "of:v2-query-coverage-overlap-root" as URI;

type Link = {
  "/": {
    "link@1": {
      id: URI;
      path: [];
      space: string;
    };
  };
};

type NodeValue = {
  label: string;
  version: number;
  children?: Link[];
};

const nodeSchema = {
  type: "object",
  properties: {
    label: { type: "string" },
    version: { type: "number" },
    children: {
      type: "array",
      items: { $ref: "#/$defs/node" },
    },
  },
  required: ["label", "version"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const graphSchema = {
  ...nodeSchema,
  $defs: {
    node: nodeSchema,
  },
} as const satisfies JSONSchema;

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

function readNumberEnv(
  name: string,
  defaultValue: number,
  min: number,
): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return defaultValue;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(
      `${name} must be a number >= ${min}; got ${JSON.stringify(raw)}`,
    );
  }

  return value;
}

function readBoolEnv(name: string, defaultValue: boolean): boolean {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return defaultValue;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new Error(
    `${name} must be one of 1, true, 0, false; got ${JSON.stringify(raw)}`,
  );
}

const invocationFor = (localSeq: number) => ({
  iss: "did:key:alice",
  aud: "did:key:service",
  cmd: "/memory/transact",
  sub: space,
  args: { localSeq },
});

const authorization = {
  signature: "sig:alice",
  access: { "proof:1": {} },
};

const baseChildId = (index: number) =>
  `of:v2-query-coverage-child-${String(index).padStart(8, "0")}` as URI;

const hiddenId = (index: number) =>
  `of:v2-query-coverage-hidden-${String(index).padStart(8, "0")}` as URI;

const linkTo = (id: URI): Link => ({
  "/": {
    "link@1": {
      id,
      path: [],
      space,
    },
  },
});

const dirtyKeySet = (ids: Iterable<URI>): Set<string> =>
  new Set(Array.from(ids, (id) => toDirtyKey(id)));

const baseChildIds = (): URI[] =>
  Array.from({ length: DOC_COUNT - 1 }, (_, index) => baseChildId(index));

const hiddenIds = (): URI[] =>
  Array.from({ length: HIDDEN_COUNT }, (_, index) => hiddenId(index));

const rootValue = (version: number, childIds = baseChildIds()): NodeValue => ({
  label: "root",
  version,
  children: childIds.map(linkTo),
});

const leafValue = (id: URI, version: number): NodeValue => ({
  label: id,
  version,
});

const overlapRootValue = (): NodeValue => {
  const existing = baseChildIds().slice(0, Math.max(0, DOC_COUNT - 1));
  spliceAll(existing, 0, HIDDEN_COUNT, hiddenIds());
  return {
    label: "overlap-root",
    version: 0,
    children: existing.map(linkTo),
  };
};

const retargetedRootValue = (): NodeValue => {
  const children = baseChildIds();
  spliceAll(children, 0, HIDDEN_COUNT, hiddenIds());
  return rootValue(1, children);
};

const graphQuery = (id = rootId): GraphQuery => ({
  roots: [{
    id,
    selector: {
      path: [],
      schema: graphSchema,
    },
  }],
});

const setOperation = (id: URI, value: NodeValue) => ({
  op: "set" as const,
  id,
  value: { value },
});

async function createEngine(): Promise<{ engine: Engine; path: string }> {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
}

function seedGraph(engine: Engine): void {
  applyCommit(engine, {
    sessionId: "session:writer",
    invocation: invocationFor(1),
    authorization,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [
        setOperation(rootId, rootValue(0)),
        ...baseChildIds().map((id) => setOperation(id, leafValue(id, 0))),
        ...hiddenIds().map((id) => setOperation(id, leafValue(id, 0))),
        setOperation(overlapRootId, overlapRootValue()),
      ],
    },
  });
}

function updateLeaves(engine: Engine, ids: URI[], version: number): void {
  applyCommit(engine, {
    sessionId: "session:writer",
    invocation: invocationFor(version + 1),
    authorization,
    commit: {
      localSeq: version + 1,
      reads: { confirmed: [], pending: [] },
      operations: ids.map((id) => setOperation(id, leafValue(id, version))),
    },
  });
}

function updateRoot(engine: Engine, value: NodeValue, version: number): void {
  applyCommit(engine, {
    sessionId: "session:writer",
    invocation: invocationFor(version + 1),
    authorization,
    commit: {
      localSeq: version + 1,
      reads: { confirmed: [], pending: [] },
      operations: [setOperation(rootId, value)],
    },
  });
}

async function setupSeededEngine(): Promise<{
  engine: Engine;
  path: string;
}> {
  const result = await createEngine();
  seedGraph(result.engine);
  return result;
}

async function setupTrackedEngine(): Promise<{
  engine: Engine;
  path: string;
  tracked: TrackedGraphState;
}> {
  const result = await setupSeededEngine();
  const tracked = trackGraph(space, result.engine, graphQuery()).state;
  return { ...result, tracked };
}

async function cleanup(engine: Engine, path: string): Promise<void> {
  close(engine);
  await Deno.remove(path);
}

type DiagnosticCase =
  | "track-cold"
  | "extend-covered"
  | "extend-overlap"
  | "refresh-leaves"
  | "refresh-root-stable"
  | "refresh-root-retargeted";

type Diagnostics = Partial<Record<DiagnosticCase, QueryTraversalStats>>;

async function collectDiagnostics(): Promise<Diagnostics> {
  if (!INCLUDE_STATS) {
    return {};
  }

  const diagnostics: Diagnostics = {};

  {
    const { engine, path } = await setupSeededEngine();
    try {
      diagnostics["track-cold"] = trackGraph(
        space,
        engine,
        graphQuery(),
      ).stats;
    } finally {
      await cleanup(engine, path);
    }
  }

  {
    const { engine, path, tracked } = await setupTrackedEngine();
    try {
      diagnostics["extend-covered"] = extendTrackedGraph(
        space,
        engine,
        tracked,
        graphQuery(baseChildId(0)),
      ).stats;
    } finally {
      await cleanup(engine, path);
    }
  }

  {
    const { engine, path, tracked } = await setupTrackedEngine();
    try {
      diagnostics["extend-overlap"] = extendTrackedGraph(
        space,
        engine,
        tracked,
        graphQuery(overlapRootId),
      ).stats;
    } finally {
      await cleanup(engine, path);
    }
  }

  {
    const { engine, path, tracked } = await setupTrackedEngine();
    const dirtyIds = baseChildIds().slice(0, DIRTY_COUNT);
    updateLeaves(engine, dirtyIds, 1);
    try {
      diagnostics["refresh-leaves"] = refreshTrackedGraph(
        space,
        engine,
        tracked,
        dirtyKeySet(dirtyIds),
      )?.stats;
    } finally {
      await cleanup(engine, path);
    }
  }

  {
    const { engine, path, tracked } = await setupTrackedEngine();
    updateRoot(engine, rootValue(1), 1);
    try {
      diagnostics["refresh-root-stable"] = refreshTrackedGraph(
        space,
        engine,
        tracked,
        dirtyKeySet([rootId]),
      )?.stats;
    } finally {
      await cleanup(engine, path);
    }
  }

  {
    const { engine, path, tracked } = await setupTrackedEngine();
    updateRoot(engine, retargetedRootValue(), 1);
    try {
      diagnostics["refresh-root-retargeted"] = refreshTrackedGraph(
        space,
        engine,
        tracked,
        dirtyKeySet([rootId]),
      )?.stats;
    } finally {
      await cleanup(engine, path);
    }
  }

  return diagnostics;
}

const diagnostics = await collectDiagnostics();

function withStats(name: string, key: DiagnosticCase): string {
  const stats = diagnostics[key];
  if (stats === undefined) {
    return name;
  }
  return `${name}, reads=${stats.managerReads}, traversals=${stats.schemaTraversals}, skips=${stats.coveredSelectorSkips}, memoHits=${stats.schemaMemoHits}`;
}

Deno.bench({
  name: withStats(
    `trackGraph cold linked graph - docs=${DOC_COUNT}`,
    "track-cold",
  ),
  group: "v2-query-coverage",
  baseline: true,
  async fn(b) {
    const { engine, path } = await setupSeededEngine();
    try {
      b.start();
      trackGraph(space, engine, graphQuery());
      b.end();
    } finally {
      await cleanup(engine, path);
    }
  },
});

Deno.bench({
  name: withStats(
    `extendTrackedGraph already-covered descendant root - docs=${DOC_COUNT}`,
    "extend-covered",
  ),
  group: "v2-query-coverage",
  async fn(b) {
    const { engine, path, tracked } = await setupTrackedEngine();
    try {
      b.start();
      extendTrackedGraph(space, engine, tracked, graphQuery(baseChildId(0)));
      b.end();
    } finally {
      await cleanup(engine, path);
    }
  },
});

Deno.bench({
  name: withStats(
    `extendTrackedGraph overlapping root - docs=${DOC_COUNT}, new=${HIDDEN_COUNT}`,
    "extend-overlap",
  ),
  group: "v2-query-coverage",
  async fn(b) {
    const { engine, path, tracked } = await setupTrackedEngine();
    try {
      b.start();
      extendTrackedGraph(space, engine, tracked, graphQuery(overlapRootId));
      b.end();
    } finally {
      await cleanup(engine, path);
    }
  },
});

Deno.bench({
  name: withStats(
    `refreshTrackedGraph dirty leaves - docs=${DOC_COUNT}, dirty=${DIRTY_COUNT}`,
    "refresh-leaves",
  ),
  group: "v2-query-coverage",
  async fn(b) {
    const { engine, path, tracked } = await setupTrackedEngine();
    const dirtyIds = baseChildIds().slice(0, DIRTY_COUNT);
    updateLeaves(engine, dirtyIds, 1);
    try {
      b.start();
      refreshTrackedGraph(space, engine, tracked, dirtyKeySet(dirtyIds));
      b.end();
    } finally {
      await cleanup(engine, path);
    }
  },
});

Deno.bench({
  name: withStats(
    `refreshTrackedGraph dirty root stable links - docs=${DOC_COUNT}`,
    "refresh-root-stable",
  ),
  group: "v2-query-coverage",
  async fn(b) {
    const { engine, path, tracked } = await setupTrackedEngine();
    updateRoot(engine, rootValue(1), 1);
    try {
      b.start();
      refreshTrackedGraph(space, engine, tracked, dirtyKeySet([rootId]));
      b.end();
    } finally {
      await cleanup(engine, path);
    }
  },
});

Deno.bench({
  name: withStats(
    `refreshTrackedGraph dirty root retargeted links - docs=${DOC_COUNT}, new=${HIDDEN_COUNT}`,
    "refresh-root-retargeted",
  ),
  group: "v2-query-coverage",
  async fn(b) {
    const { engine, path, tracked } = await setupTrackedEngine();
    updateRoot(engine, retargetedRootValue(), 1);
    try {
      b.start();
      refreshTrackedGraph(space, engine, tracked, dirtyKeySet([rootId]));
      b.end();
    } finally {
      await cleanup(engine, path);
    }
  },
});
