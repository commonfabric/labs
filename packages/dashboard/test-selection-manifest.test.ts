import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  MANIFEST_SCHEMA_VERSION,
  sampleEntry,
  sampleManifest,
  serializeManifest,
} from "@commonfabric/test-support/records";

import {
  FLAKE_WINDOW_FALLBACK_DAYS,
  generatedAtOf,
  LANE_BUDGET_FALLBACK_SECONDS,
  laneBudgetOf,
  ManifestSchemaError,
  newestManifest,
  TEST_SELECTION_PREFIX,
} from "./test-selection-manifest.ts";
import { manifestPrefix } from "../../tasks/test-selection/store.ts";
import type { TestSelectionSource } from "./test-selection-history.ts";
import { makeTestFlakes } from "./tiles/test-flakes.ts";
import { makeTestSelection } from "./tiles/test-selection.ts";
import { HEALTH_SECTION_ID, TEST_SELECTION_PATH } from "./test-selection-page.ts";
import type { Ctx } from "./types.ts";

const PREFIX = TEST_SELECTION_PREFIX.replace(/\/$/, "");

/**
 * A store answering one listing and the objects it named. Bodies are the
 * text a real fetch delivers: the store serves with transcoding, so the
 * gzip an object is stored under is already decoded by the time a reader
 * sees it.
 */
function storeOf(objects: Record<string, string>): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/o")) {
      const items = Object.keys(objects).map((name) => ({ name }));
      return Promise.resolve(new Response(JSON.stringify({ items }), { status: 200 }));
    }
    const name = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
    const body = objects[name];
    return Promise.resolve(
      body === undefined
        ? new Response("", { status: 404 })
        : new Response(body as BodyInit, { status: 200 }),
    );
  }) as typeof fetch;
}

Deno.test("generatedAtOf reads the time out of a manifest's name", () => {
  assertEquals(
    generatedAtOf(`${PREFIX}/manifest-2026-08-20T04:00:00.000Z-a.json.gz`),
    "2026-08-20T04:00:00.000Z",
  );
  assertEquals(generatedAtOf(`${PREFIX}/state/2026-08-20-a.json.gz`), undefined);
});

Deno.test("newestManifest takes the newest object under the prefix", async () => {
  const older = sampleManifest({ generatedAt: "2026-08-20T00:00:00.000Z" });
  const newer = sampleManifest({ generatedAt: "2026-08-20T04:00:00.000Z" });
  const found = await newestManifest({
    fetchImpl: storeOf({
      [`${PREFIX}/manifest-2026-08-20T00:00:00.000Z-a.json.gz`]:
        serializeManifest(older),
      [`${PREFIX}/manifest-2026-08-20T04:00:00.000Z-b.json.gz`]:
        serializeManifest(newer),
    }),
  });
  assertEquals(found?.generatedAt, "2026-08-20T04:00:00.000Z");
});

Deno.test("newestManifest reports a body that is not a manifest", async () => {
  await assertRejects(
    () =>
      newestManifest({
        fetchImpl: storeOf({
          [`${PREFIX}/manifest-2026-08-20T04:00:00.000Z-b.json.gz`]:
            "{not a manifest",
        }),
      }),
    Error,
    "not a manifest",
  );
});

Deno.test("the reader looks where the publisher writes", () => {
  // Two spellings of the area would part company the first time either
  // moved, and what that produces is a reader listing objects that are
  // all refused: a fault where a figure should be.
  assertEquals(`${manifestPrefix(() => undefined)}/`, TEST_SELECTION_PREFIX);
});

Deno.test("a version ahead is named even where its shape dropped a field", async () => {
  // A later shape may drop a field this reader requires, as the
  // calibration has already lost one. Deciding from the body's declared
  // version holds there; offering the body under this reader's own
  // version does not, because the validator then refuses it over the
  // missing field and the version goes unreported.
  const name = `${PREFIX}/manifest-2026-08-20T04:00:00.000Z-a.json.gz`;
  const ahead = MANIFEST_SCHEMA_VERSION + 1;
  const error = await assertRejects(
    () =>
      newestManifest({
        fetchImpl: storeOf({
          [name]: JSON.stringify({
            ...sampleManifest({}),
            schema: ahead,
            calibration: { setupCost: {}, suites: {} },
          }),
        }),
      }),
    ManifestSchemaError,
  );
  assertStringIncludes(error.reason, `schema ${ahead}`);
});

Deno.test("a broken body of a shape this reader does read is a plain fault", async () => {
  // The reader reads earlier shapes, so an earlier one it cannot parse is
  // a broken object rather than one from further ahead. Naming its shape
  // would say the dashboard cannot read that shape, which is false, and would
  // have the dashboard stop fetching an object it should read again.
  const name = `${PREFIX}/manifest-2026-08-20T04:00:00.000Z-a.json.gz`;
  const error = await assertRejects(
    () =>
      newestManifest({
        fetchImpl: storeOf({
          [name]: JSON.stringify({
            ...sampleManifest({}),
            schema: MANIFEST_SCHEMA_VERSION - 1,
            entries: "not a list of entries",
          }),
        }),
      }),
    Error,
    "not a manifest",
  );
  assertEquals(error instanceof ManifestSchemaError, false);
});

Deno.test("a broken body of this reader's own version is a plain fault", async () => {
  const name = `${PREFIX}/manifest-2026-08-20T04:00:00.000Z-a.json.gz`;
  const error = await assertRejects(
    () =>
      newestManifest({
        fetchImpl: storeOf({
          [name]: JSON.stringify({
            ...sampleManifest({}),
            entries: "not a list of entries",
          }),
        }),
      }),
    Error,
    "not a manifest",
  );
  assertEquals(error instanceof ManifestSchemaError, false);
});

Deno.test("newestManifest names a version it cannot read", async () => {
  const name = `${PREFIX}/manifest-2026-08-20T04:00:00.000Z-a.json.gz`;
  const later = MANIFEST_SCHEMA_VERSION + 1;
  const error = await assertRejects(
    () =>
      newestManifest({
        fetchImpl: storeOf({
          [name]: JSON.stringify({
            ...sampleManifest({}),
            schema: later,
          }),
        }),
      }),
    ManifestSchemaError,
  );
  assertStringIncludes(error.message, name);
  assertEquals(
    error.reason,
    `store holds schema ${later}, this dashboard reads ${MANIFEST_SCHEMA_VERSION}`,
  );
});

Deno.test("a tile and the page name a schema rather than saying nothing useful", async () => {
  const error = new ManifestSchemaError("a.json.gz", 1);
  const source: TestSelectionSource = {
    latest: () => Promise.reject(error),
    history: () => Promise.resolve({ samples: [], errors: [] }),
  };
  for (
    const tile of [
      makeTestFlakes({ source }),
      makeTestSelection({ source }),
    ]
  ) {
    const view = await tile.collect(CTX);
    assertEquals(view.value, "—");
    assertEquals(view.sub, error.reason);
  }
  const route = makeTestSelection({ source }).routes?.find((r) =>
    r.path === TEST_SELECTION_PATH
  );
  assertExists(route);
  const url = new URL(`http://dashboard${TEST_SELECTION_PATH}`);
  const body = await (await route.handler(new Request(url), url)).text();
  assertStringIncludes(body, error.reason);
  assertEquals(body.includes("temporarily unavailable"), false);
});

Deno.test("a body that is not an object declares no version", async () => {
  // A body is untrusted input, and JSON has values that are not objects.
  // Neither of these declares a version, and asking one whether it owns a
  // field is a question only an object answers.
  const name = `${PREFIX}/manifest-2026-08-20T04:00:00.000Z-a.json.gz`;
  for (const body of ["null", "42", '"a string"']) {
    const error = await assertRejects(
      () => newestManifest({ fetchImpl: storeOf({ [name]: body }) }),
      Error,
      "not a manifest",
    );
    assertEquals(error instanceof ManifestSchemaError, false);
  }
});

Deno.test("a version inherited from the prototype is not a declared one", async () => {
  // A body declares a version in its own field or not at all. Reading an
  // inherited one would refuse an object that is no manifest at all, and
  // refuse it for the life of the process.
  const name = `${PREFIX}/manifest-2026-08-20T04:00:00.000Z-a.json.gz`;
  // deno-lint-ignore no-explicit-any
  (Object.prototype as any).schema = MANIFEST_SCHEMA_VERSION + 1;
  try {
    const error = await assertRejects(
      () =>
        newestManifest({
          fetchImpl: storeOf({ [name]: JSON.stringify({ not: "a manifest" }) }),
        }),
      Error,
      "not a manifest",
    );
    assertEquals(error instanceof ManifestSchemaError, false);
  } finally {
    // deno-lint-ignore no-explicit-any
    delete (Object.prototype as any).schema;
  }
});

Deno.test("newestManifest reports nothing when the store holds none", async () => {
  assertEquals(await newestManifest({ fetchImpl: storeOf({}) }), undefined);
});

/**
 * A store that lists one manifest and then answers for the object
 * itself however the caller says. The listing has to succeed for the
 * reader to reach the object at all.
 */
function storeRefusing(answer: () => Promise<Response>): typeof fetch {
  const name = `${PREFIX}/manifest-2026-08-20T04:00:00.000Z-a.json.gz`;
  return ((input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/o")) {
      return Promise.resolve(
        new Response(JSON.stringify({ items: [{ name }] }), { status: 200 }),
      );
    }
    return answer();
  }) as typeof fetch;
}

Deno.test("newestManifest reports a refused manifest", async () => {
  // Listed but not readable, which is what a manifest deleted between
  // the listing and the read looks like.
  for (const status of [403, 404, 500]) {
    await assertRejects(
      () =>
        newestManifest({
          fetchImpl: storeRefusing(() =>
            Promise.resolve(new Response("", { status }))
          ),
        }),
      Error,
      `HTTP ${status}`,
    );
  }
});

Deno.test("newestManifest reports a failed read", async () => {
  await assertRejects(
    () =>
      newestManifest({
        fetchImpl: storeRefusing(() => Promise.reject(new Error("no network"))),
      }),
    Error,
    "no network",
  );
});

Deno.test("newestManifest reports an unreachable store", async () => {
  await assertRejects(
    () =>
      newestManifest({
        fetchImpl: (() =>
          Promise.reject(new Error("no network"))) as typeof fetch,
      }),
    Error,
    "no network",
  );
});

const CTX: Ctx = {
  runs: () => Promise.resolve([]),
  runsFor: () => Promise.resolve([]),
  env: () => undefined,
};

/** A reader over a store holding one manifest under a fixed name. */
function reading(
  manifest: Parameters<typeof serializeManifest>[0],
): TestSelectionSource {
  const fetchImpl = storeOf({
    [`${PREFIX}/manifest-2026-08-20T04:00:00.000Z-a.json.gz`]:
      serializeManifest(manifest),
  });
  return {
    latest: () => newestManifest({ fetchImpl }),
    history: () => Promise.resolve({ samples: [], errors: [] }),
  };
}

Deno.test("both test tiles are unknown when there is no manifest", async () => {
  const empty: TestSelectionSource = {
    latest: () => Promise.resolve(undefined),
    history: () => Promise.resolve({ samples: [], errors: [] }),
  };
  for (
    const tile of [
      makeTestFlakes({ source: empty }),
      makeTestSelection({ source: empty }),
    ]
  ) {
    const view = await tile.collect(CTX);
    assertEquals(view.status, "unknown");
    assertEquals(view.sub, "no selection manifest yet");
  }
});

Deno.test("the flake tile is green when nothing is withheld as flaky", async () => {
  const tile = makeTestFlakes({
    source: reading(sampleManifest()),
    now: () => Date.parse("2026-08-20T00:30:00.000Z"),
  });
  const view = await tile.collect(CTX);
  assertEquals(view.status, "good");
  assertEquals(view.value, "no flaky tests");
  // What the conclusion was drawn from: the window the share is measured
  // over, and how long ago the publisher measured it.
  assertEquals(view.sub, `${FLAKE_WINDOW_FALLBACK_DAYS} days of runs · 30m old`);
});

Deno.test("the flake tile counts what selection held back, and points at them", async () => {
  const longName = "space > flakes with a name that keeps going past the tile limit";
  const noisy = sampleEntry({ k: "unit", s: "memory", n: longName, v: "worker" }, {
    flakeRate: 0.4,
  });
  const manifest = sampleManifest({
    entries: [noisy],
    withheld: [{ test: noisy.test, suite: noisy.suite, reason: "flaky" }],
  });
  const view = await makeTestFlakes({
    source: reading(manifest),
    now: () => Date.parse("2026-08-20T04:00:00.000Z"),
  }).collect(CTX);
  assertEquals(view.status, "warn");
  assertEquals(view.value, "1 flaky test");
  assertEquals(view.sub, `${FLAKE_WINDOW_FALLBACK_DAYS} days of runs · 4h old`);
  // A source with no history adds no chart or test names to the tile.
  assertEquals(view.extra, undefined);
  assertEquals(view.href, "/test-selection#flaky");
  assertEquals(view.hint, "flakes ↗");
});

Deno.test("the selection tile says what share of the corpus would run", async () => {
  const entry = sampleEntry({ k: "unit", s: "memory", n: "a" }, { cost: 3 });
  const other = sampleEntry({ k: "unit", s: "memory", n: "b" }, { cost: 1 });
  const manifest = sampleManifest({
    entries: [entry, other],
    lanes: [{
      lane: 1,
      projectedSeconds: 3,
      batches: [{
        suite: entry.suite,
        identities: [JSON.stringify(entry.test)],
      }],
    }],
  });
  const view = await makeTestSelection({
    source: reading(manifest),
    now: () => Date.parse("2026-08-20T05:00:00.000Z"),
  }).collect(CTX);
  assertEquals(view.status, "good");
  assertEquals(view.value, "50%");
  assertEquals(view.sub, "1 of 2 tests");
  assertEquals(view.href, "/test-selection");
  assertEquals(view.hint, "lanes ↗");
});

Deno.test("the selection tile goes amber once the manifest has gone stale", async () => {
  const view = await makeTestSelection({
    source: reading(sampleManifest()),
    now: () => Date.parse("2026-08-21T04:00:00.000Z"),
  }).collect(CTX);
  assertEquals(view.status, "warn");
  assertEquals(view.aside, '<span class="hfacet" title="28h old">28h old</span>');
  // Staleness reports itself in the badge, so it leaves the sub line to
  // the counts rather than taking it.
  assertEquals(view.sub, "0 of 1 tests");
});

Deno.test("the lane budget comes from the manifest that named it", () => {
  assertEquals(laneBudgetOf({ LANE_BUDGET_SECONDS: 180 }), 180);
  assertEquals(laneBudgetOf({}), LANE_BUDGET_FALLBACK_SECONDS);
  assertEquals(laneBudgetOf({ LANE_BUDGET_SECONDS: 0 }), LANE_BUDGET_FALLBACK_SECONDS);
  assertEquals(laneBudgetOf({ LANE_BUDGET_SECONDS: "x" }), LANE_BUDGET_FALLBACK_SECONDS);
});

Deno.test("the selection tile goes red when a lane is past its budget", async () => {
  const heavy = sampleEntry({ k: "unit", s: "memory", n: "a" }, { cost: 400 });
  const manifest = sampleManifest({
    entries: [heavy],
    lanes: [{
      lane: 1,
      projectedSeconds: 400,
      batches: [{
        suite: heavy.suite,
        identities: [JSON.stringify(heavy.test)],
      }],
    }],
  });
  const view = await makeTestSelection({
    source: reading(manifest),
    now: () => Date.parse("2026-08-20T05:00:00.000Z"),
  }).collect(CTX);
  assertEquals(view.status, "bad");
  // The overrun is why the tile is red, so it takes the line the share holds.
  assertEquals(
    view.sub,
    `fullest lane 400s of ${LANE_BUDGET_FALLBACK_SECONDS}s`,
  );
});

Deno.test("the selection tile goes amber while a test is too long for any lane", async () => {
  const huge = sampleEntry({ k: "integration", s: "cli", n: "acl.sh" }, { cost: 900 });
  const other = sampleEntry({ k: "unit", s: "memory", n: "b" }, { cost: 1 });
  const manifest = sampleManifest({
    entries: [huge, other],
    unschedulable: [{ test: huge.test, suite: huge.suite, cost: 900 }],
    lanes: [{
      lane: 1,
      projectedSeconds: 1,
      batches: [{ suite: other.suite, identities: [JSON.stringify(other.test)] }],
    }],
  });
  const view = await makeTestSelection({
    source: reading(manifest),
    now: () => Date.parse("2026-08-20T05:00:00.000Z"),
  }).collect(CTX);
  assertEquals(view.status, "warn");
  // The share is still the headline; what the tile turned amber for takes
  // the line under it.
  assertEquals(view.value, "50%");
  assertEquals(view.sub, "1 test too long for any lane");
  assertEquals(view.href, TEST_SELECTION_PATH);
  assertEquals(view.hint, "lanes ↗");
});

Deno.test("the selection tile counts every test no lane can hold", async () => {
  const heavy = (n: string) =>
    sampleEntry({ k: "integration", s: "cli", n }, { cost: 900 });
  const manifest = sampleManifest({
    entries: [heavy("a"), heavy("b")],
    unschedulable: [
      { test: heavy("a").test, suite: "cli", cost: 900 },
      { test: heavy("b").test, suite: "cli", cost: 900 },
    ],
  });
  const view = await makeTestSelection({
    source: reading(manifest),
    now: () => Date.parse("2026-08-20T05:00:00.000Z"),
  }).collect(CTX);
  assertEquals(view.status, "warn");
  assertEquals(view.sub, "2 tests too long for any lane");
});

Deno.test("a lane past its budget outranks the tests no lane can hold", async () => {
  const heavy = sampleEntry({ k: "unit", s: "memory", n: "a" }, { cost: 400 });
  const huge = sampleEntry({ k: "integration", s: "cli", n: "acl.sh" }, { cost: 900 });
  const manifest = sampleManifest({
    entries: [heavy, huge],
    unschedulable: [{ test: huge.test, suite: huge.suite, cost: 900 }],
    lanes: [{
      lane: 1,
      projectedSeconds: 400,
      batches: [{ suite: heavy.suite, identities: [JSON.stringify(heavy.test)] }],
    }],
  });
  const view = await makeTestSelection({
    source: reading(manifest),
    now: () => Date.parse("2026-08-20T05:00:00.000Z"),
  }).collect(CTX);
  assertEquals(view.status, "bad");
  assertEquals(view.sub, `fullest lane 400s of ${LANE_BUDGET_FALLBACK_SECONDS}s`);
});

Deno.test("the selection tile goes red when the publisher found the cost model broken", async () => {
  const heavy = sampleEntry({ k: "unit", s: "memory", n: "a" }, { cost: 400 });
  const manifest = sampleManifest({
    entries: [heavy],
    lanes: [{
      lane: 1,
      projectedSeconds: 400,
      batches: [{ suite: heavy.suite, identities: [JSON.stringify(heavy.test)] }],
    }],
    health: {
      suites: { "pattern-unit": { fixed: 351, tooLong: 181, batches: 0 } },
      lanes: { observed: 0, pastBound: 0, projectedInside: 0, overran: 0 },
      alarms: ["pattern-unit: a lane pays 5m51s before it runs any of it"],
    },
  });
  const view = await makeTestSelection({
    source: reading(manifest),
    now: () => Date.parse("2026-08-20T05:00:00.000Z"),
  }).collect(CTX);
  assertEquals(view.status, "bad");
  // Ahead of the overrun, which a broken model is the likelier cause of.
  assertEquals(view.sub, "cost model broken: 1 alarm");
  assertEquals(view.href, `${TEST_SELECTION_PATH}#${HEALTH_SECTION_ID}`);
});

Deno.test("the selection tile stays green for a cost model that holds", async () => {
  const view = await makeTestSelection({
    source: reading(sampleManifest({
      health: {
        suites: {},
        lanes: { observed: 0, pastBound: 0, projectedInside: 0, overran: 0 },
        alarms: [],
      },
    })),
    now: () => Date.parse("2026-08-20T05:00:00.000Z"),
  }).collect(CTX);
  assertEquals(view.status, "good");
  assertEquals(view.href, TEST_SELECTION_PATH);
});

Deno.test("the selection tile serves the page both tiles link to", async () => {
  const tile = makeTestSelection({ source: reading(sampleManifest()) });
  const route = tile.routes?.find((r) => r.path === TEST_SELECTION_PATH);
  assertExists(route);
  const url = new URL(`http://dashboard${TEST_SELECTION_PATH}`);
  const response = await route.handler(new Request(url), url);
  assertEquals(
    response.headers.get("content-type"),
    "text/html; charset=utf-8",
  );
  assertStringIncludes(await response.text(), "<title>Test selection</title>");
});

Deno.test("both tiles link into the page the route serves", async () => {
  const source = reading(sampleManifest());
  const flakes = await makeTestFlakes({ source }).collect(CTX);
  const selection = await makeTestSelection({ source }).collect(CTX);
  assertEquals(selection.href, TEST_SELECTION_PATH);
  assertEquals(flakes.href?.split("#")[0], TEST_SELECTION_PATH);
});

Deno.test("a tile lets a store failure through, for the dashboard to gray it", async () => {
  // The dashboard turns a collection that throws into a gray tile carrying the
  // reason, which is what separates an unreadable store from an empty one.
  const failing: TestSelectionSource = {
    latest: () => Promise.reject(new Error("no network")),
    history: () => Promise.reject(new Error("no network")),
  };
  for (
    const tile of [
      makeTestFlakes({ source: failing }),
      makeTestSelection({ source: failing }),
    ]
  ) {
    await assertRejects(() => tile.collect(CTX), Error, "no network");
  }
});

Deno.test("the page says a store could not be read, rather than that it is empty", async () => {
  const tile = makeTestSelection({
    source: {
      latest: () => Promise.reject(new Error("no network")),
      history: () => Promise.reject(new Error("no network")),
    },
  });
  const route = tile.routes?.find((r) => r.path === TEST_SELECTION_PATH);
  assertExists(route);
  const url = new URL(`http://dashboard${TEST_SELECTION_PATH}`);
  const response = await route.handler(new Request(url), url);
  assertEquals(response.status, 503);
  const body = await response.text();
  assertStringIncludes(body, "could not be read: source unreachable");
  assertEquals(body.includes("has been published yet"), false);
});
