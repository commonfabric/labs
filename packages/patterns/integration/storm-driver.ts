/**
 * Parametric driver for the convergence-storm repro — bisection matrix tool.
 * NOT a test; run directly:
 *
 *   deno run -A packages/patterns/integration/storm-driver.ts \
 *     [K=20] [writers=2] [idleMode=pipeline|serial] [wsDelay=0] [fixture=convergence-chat]
 *
 * Prints per-session views, raw replica reads of the messages doc, and
 * logger-count deltas, then exits. Used to pin down which conditions are
 * necessary for the divergence
 * (docs/history/plans/2026-07-02-convergence-evidence-appendix.md).
 */

import { join } from "@std/path";
import { debugStr } from "@commonfabric/data-model";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const K = Number(Deno.args[0] ?? 20);
const WRITERS = Number(Deno.args[1] ?? 2);
const IDLE_MODE = (Deno.args[2] ?? "pipeline") as "pipeline" | "serial";
const WS_DELAY = Number(Deno.args[3] ?? 0);
const FIXTURE = Deno.args[4] ?? "convergence-chat";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  FIXTURE,
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

type Msg = { author: string; body: string; n: number };
const messages = async (s: MultiRuntimeSession): Promise<Msg[]> =>
  ((await s.read(["messages"])) as Msg[] | undefined) ?? [];
const summarize = (list: Msg[]): Record<string, number> => {
  const by: Record<string, number> = {};
  for (const m of list) by[m.author] = (by[m.author] ?? 0) + 1;
  return by;
};

const storm = async (s: MultiRuntimeSession, author: string) => {
  for (let n = 0; n < K; n++) {
    await s.send("post", { author, body: `${author}-${n}`, n }, undefined, {
      idle: IDLE_MODE === "pipeline" ? false : true,
    });
  }
};

console.log(
  `[driver] K=${K} writers=${WRITERS} idleMode=${IDLE_MODE} wsDelay=${WS_DELAY} fixture=${FIXTURE}`,
);

const mk = (label: string) =>
  WS_DELAY > 0 ? { label, wsDelayMs: WS_DELAY } : label;
const harness = await MultiRuntimeHarness.create({
  programPath: PROGRAM_PATH,
  rootPath: ROOT_PATH,
  sessions: [mk("drv-alice"), mk("drv-bob"), mk("drv-observer")],
  // Records every refused commit, which the refusal summary below reads.
  recordRejections: true,
});
const [alice, bob, observer] = harness.sessions;
await harness.settle();

// Record the messages doc address up-front (all sessions agree pre-storm).
const msgLink = await alice.link(["messages"]);
console.log(`[driver] messages link:`, msgLink);

// Open the refusal window here, so the summary covers the storm rather than
// the commits that started the harness and opened the piece.
await Promise.all(harness.sessions.map((session) => session.clearRejections()));

const writers = WRITERS === 1 ? [alice] : [alice, bob];
await Promise.all(writers.map((w, i) => storm(w, i === 0 ? "alice" : "bob")));
console.log(`[driver] storm done (${writers.length}×${K})`);

await harness.settle(20);

const views = {
  alice: summarize(await messages(alice)),
  bob: summarize(await messages(bob)),
  observer: summarize(await messages(observer)),
};
console.log(debugStr`[driver] result-path views: $quote,xlong${views}`);

// Raw replica reads at the messages address — bypass schema/link resolution.
// Stored doc trees root at ["value", …]; link() reports the logical path.
const findLinkIds = (v: unknown, out: Set<string>): void => {
  if (v === null || typeof v !== "object") return;
  const rec = v as Record<string, unknown>;
  const id = (rec["id"] ?? (rec["/"] as Record<string, unknown> | undefined)
    ?.["id"]) as string | undefined;
  if (typeof id === "string" && id.startsWith("of:")) out.add(id);
  for (const child of Object.values(rec)) findLinkIds(child, out);
};
const elementDocIds = new Set<string>();
for (
  const [name, s] of [["alice", alice], ["bob", bob], [
    "observer",
    observer,
  ]] as const
) {
  const raw = await s.rawRead({
    id: msgLink.id,
    space: msgLink.space,
    path: ["value", ...msgLink.path],
    scope: msgLink.scope,
  });
  const v = raw.value;
  const len = Array.isArray(v)
    ? v.length
    : v === undefined
    ? "undef"
    : typeof v;
  if (Array.isArray(v)) findLinkIds(v, elementDocIds);
  console.log(
    `[driver] rawRead[array] ${name}: ok=${raw.ok} len=${len}` +
      (raw.error ? ` error=${raw.error}` : "") +
      (Array.isArray(v) && v.length > 0
        ? debugStr` first=$quote,long${v[0]}`
        : ""),
  );
}
// Chase up to 3 element-doc ids raw in every session: is the LINKED DOC there?
const chase = [...elementDocIds].slice(0, 3);
for (
  const [name, s] of [["alice", alice], ["bob", bob], [
    "observer",
    observer,
  ]] as const
) {
  for (const id of chase) {
    const raw = await s.rawRead({
      id,
      space: msgLink.space,
      path: ["value"],
      scope: "space",
    });
    const v = raw.value === undefined
      ? "ABSENT"
      : debugStr`$quote,long${raw.value}`;
    console.log(`[driver] rawRead[doc] ${name} ${id.slice(-8)}: ${v}`);
  }
}

// Failure-surface probes: how deep does the schema-aware read work for a
// non-authoring session, and what does the stored element link look like?
if (chase.length > 0) {
  const fullDoc = await observer.rawRead({
    id: chase[0],
    space: msgLink.space,
    path: ["value"],
    scope: "space",
  });
  console.log(
    `[driver] stored element doc (observer, full): ` +
      debugStr`$quote,xlong${fullDoc.value}`,
  );
}
const probePaths: [string, (string | number)[]][] = [
  ["messages", ["messages"]],
  ["messages[0]", ["messages", 0]],
  ["messages[0].author", ["messages", 0, "author"]],
  ["messages[0].body", ["messages", 0, "body"]],
];
for (const [label, path] of probePaths) {
  try {
    const v = await observer.read(path);
    console.log(
      debugStr`[driver] observer read ${label}: $quote,long${v}`,
    );
  } catch (error) {
    console.log(
      `[driver] observer read ${label}: THREW ${
        (error as Error).message.slice(0, 160)
      }`,
    );
  }
}

// Refusal attribution: what each refused commit was refused OVER, and what it
// had written. A count says a fixture cost something; this says which document
// the sessions contended for and whether the refusals are contention at all.
// The message's leading clause names the kind: a "stale ... read" of a named
// document is a root conflict, while a "pending dependency ..." is a commit
// dropped because one it stacked on was dropped.
const staleOver = (message: string): string | undefined =>
  message.match(/^stale [a-z]+ read: (\S+) /)?.[1];
const classifyWrite = (id: string): string =>
  id === msgLink.id ? "list" : id.startsWith("computed:") ? "computed" : "doc";
for (
  const [name, s] of [["alice", alice], ["bob", bob], [
    "observer",
    observer,
  ]] as const
) {
  const refusals = await s.rejections();
  const kinds: Record<string, number> = {};
  const wrote: Record<string, number> = {};
  const over: Record<string, number> = {};
  for (const refusal of refusals) {
    const stale = staleOver(refusal.message);
    kinds[stale === undefined ? "cascade" : "root"] =
      (kinds[stale === undefined ? "cascade" : "root"] ?? 0) + 1;
    if (stale !== undefined) {
      // Whether the document that went stale is one this commit also writes,
      // which separates contending over an input from contending over an
      // output.
      const alsoWrote = refusal.writes.includes(stale) ? "alsoWrote-" : "";
      const key = `${alsoWrote}${classifyWrite(stale)}:${stale.slice(-8)}`;
      over[key] = (over[key] ?? 0) + 1;
    }
    for (const id of new Set(refusal.writes.map(classifyWrite))) {
      wrote[id] = (wrote[id] ?? 0) + 1;
    }
  }
  const show = (counts: Record<string, number>) =>
    Object.entries(counts)
      .sort((left, right) => right[1] - left[1])
      .map(([key, count]) => `${key}=${count}`)
      .join(" ") || "(none)";
  console.log(
    `[driver] refusals ${name}: ${refusals.length} ` +
      `kind[${show(kinds)}] wrote[${show(wrote)}] staleOver[${show(over)}]`,
  );
}

// Logger-count signal: which categories differ across sessions.
for (
  const [name, s] of [["alice", alice], ["bob", bob], [
    "observer",
    observer,
  ]] as const
) {
  const counts = await s.loggerCounts() as Record<string, unknown> & {
    total?: number;
  };
  const interesting: string[] = [];
  for (const [logger, keys] of Object.entries(counts)) {
    if (typeof keys !== "object" || keys === null) continue;
    for (
      const [key, v] of Object.entries(
        keys as Record<string, { total?: number }>,
      )
    ) {
      const total = (v as { total?: number })?.total ?? 0;
      if (
        total > 0 &&
        /conflict|stale|drop|revert|reject|fail|retry|preempt/i.test(key)
      ) {
        interesting.push(`${logger}.${key}=${total}`);
      }
    }
  }
  console.log(
    `[driver] loggerCounts ${name}: ${interesting.join(" ") || "(none)"}`,
  );
}

await harness.dispose();
console.log("[driver] done");
