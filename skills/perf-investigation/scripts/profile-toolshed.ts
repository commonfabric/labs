#!/usr/bin/env -S deno run --allow-net --allow-run --allow-read --allow-write --allow-env
/**
 * Profile a toolshed over its inspector port while a command provokes it.
 *
 *   deno run --allow-net --allow-run --allow-read --allow-write --allow-env \
 *     skills/perf-investigation/scripts/profile-toolshed.ts <outPrefix> \
 *     [--interval=<us>] -- <command> [args...]
 *
 * The toolshed must be running under `--inspect` (`start-local-dev.sh
 * --inspect` does that); `INSPECT_URL` names its inspector (the default is
 * port offset 0's, `http://127.0.0.1:9229`) and `CF_API_URL` its API (for
 * the health-stats captures on either side of the command). The bracket is
 * the command's lifetime: the profiler starts before it is spawned and stops
 * when it exits, so the profile is the command's server-side work plus
 * whatever else the server did meanwhile.
 *
 * Writes `<outPrefix>.server.cpuprofile`, `.server.report.txt` (ranked by
 * self time), and `.server.delta.txt`: the timing rows whose count grew
 * during the command, differenced on the two additive fields, and the
 * slow-query entries the command added. `CF_SLOW_QUERY_THRESHOLD_MS=0` on
 * the toolshed makes that list every operation rather than the ones over
 * 100 ms.
 */
import { renderProfileReport } from "../../../runtime/integration/cdp-profiler.ts";

const args = [...Deno.args];
const out = args.shift();
if (out === undefined) {
  console.error(
    "usage: profile-toolshed.ts <outPrefix> [--interval=us] -- <command...>",
  );
  Deno.exit(2);
}
let interval = 500;
if (args[0]?.startsWith("--interval=")) {
  interval = Number(args.shift()!.slice("--interval=".length));
}
if (args[0] === "--") args.shift();
if (args.length === 0) {
  console.error("profile-toolshed.ts: no command given after --");
  Deno.exit(2);
}
const inspect = Deno.env.get("INSPECT_URL") ?? "http://127.0.0.1:9229";
const api = Deno.env.get("CF_API_URL") ?? "http://localhost:8000";

type Stats = {
  timingStats?: Record<
    string,
    Record<string, { count: number; totalTime: number }>
  >;
  slowQueries?: Record<string, unknown>[];
  documentCaches?: unknown;
};
const stats = async (): Promise<Stats> =>
  (await fetch(`${api}/api/health/stats`)).json();

// Both ends' server-execution posture, before anything is measured: a delta
// over a client on one arm and a server on the other describes a
// configuration nobody runs, and it looks like any other delta.
const meta = await (await fetch(`${api}/api/meta`)).json() as {
  gitSha?: string;
  experimental?: { serverExecution?: boolean };
};
const published = meta.experimental?.serverExecution;
if (typeof published !== "boolean") {
  console.error(
    "profile-toolshed.ts: the server publishes no serverExecution posture " +
      "on /api/meta, so a delta cannot say which arm it measured",
  );
  Deno.exit(2);
}
const serverPosture = published;
const clientOverride = Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION");
const adoptsServerFlags = Deno.env.get("CF_ADOPT_SERVER_FLAGS") !== "false";
// How a client that is not built beside its server resolves the flag
// (docs/development/EXPERIMENTAL_OPTIONS.md): exactly `true` or `false`
// wins, any other spelling is ignored, otherwise it adopts the server's,
// otherwise it stays off.
const clientPosture = clientOverride === "true"
  ? true
  : clientOverride === "false"
  ? false
  : adoptsServerFlags
  ? serverPosture
  : false;
if (clientPosture !== serverPosture) {
  console.error(
    `profile-toolshed.ts: mixed server-execution posture — server ` +
      `${serverPosture}, client ${clientPosture}; a delta over it measures ` +
      "neither arm. Align EXPERIMENTAL_SERVER_EXECUTION or CF_ADOPT_SERVER_FLAGS.",
  );
  Deno.exit(2);
}

// The inspector connection: every request settles — on its response, on the
// socket erroring or closing, or on a deadline — so an unreachable or
// vanished toolshed fails this script rather than hanging it.
const CDP_REQUEST_DEADLINE_MS = 30_000;
const targets = await (await fetch(`${inspect}/json`)).json();
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (value: { result: unknown }) => void; reject: (e: Error) => void }
>();
const failPending = (reason: string) => {
  for (const [id, waiter] of pending) {
    pending.delete(id);
    waiter.reject(new Error(reason));
  }
};
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = () => reject(new Error(`inspector at ${inspect} unreachable`));
  ws.onclose = () => reject(new Error(`inspector at ${inspect} closed`));
});
ws.onerror = () => failPending("inspector connection errored");
ws.onclose = () => failPending("inspector connection closed");
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const waiter = pending.get(message.id);
  if (waiter !== undefined) {
    pending.delete(message.id);
    if (message.error !== undefined) {
      waiter.reject(new Error(`CDP ${message.error.message ?? "error"}`));
    } else {
      waiter.resolve(message);
    }
  }
};
const send = (method: string, params: unknown = {}) =>
  new Promise<{ result: unknown }>((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        reject(
          new Error(
            `CDP ${method} did not answer within ${CDP_REQUEST_DEADLINE_MS}ms`,
          ),
        );
      }
    }, CDP_REQUEST_DEADLINE_MS);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

const before = await stats();
await send("Profiler.enable");
await send("Profiler.setSamplingInterval", { interval });
await send("Profiler.start");
const started = performance.now();
let status: Deno.CommandStatus | undefined;
let result: unknown;
try {
  const child = new Deno.Command(args[0], {
    args: args.slice(1),
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  status = await child.status;
} catch (error) {
  // A command that could not start is reported below, after the profiler
  // has been stopped, as the exit-2 case.
  console.error(
    `profile-toolshed.ts: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
} finally {
  // Whatever became of the command, the toolshed stops being sampled: a
  // profiler left running perturbs every later measurement on that server.
  result = (await send("Profiler.stop")).result;
}
const wall = performance.now() - started;
const after = await stats();
ws.close();
if (status === undefined) {
  console.error("profile-toolshed.ts: the command could not be run");
  Deno.exit(2);
}

const profile =
  (result as { profile: Parameters<typeof renderProfileReport>[0] }).profile;
await Deno.writeTextFile(`${out}.server.cpuprofile`, JSON.stringify(profile));
await Deno.writeTextFile(
  `${out}.server.report.txt`,
  renderProfileReport(profile, `${out} (server)`, {
    topFrames: 60,
    topFiles: 25,
  }),
);

// Only `count` and `totalTime` subtract; the percentiles describe the
// process's whole lifetime.
const rows: { key: string; count: number; totalMs: number }[] = [];
for (const [loggerName, ops] of Object.entries(after.timingStats ?? {})) {
  for (const [op, stat] of Object.entries(ops)) {
    const prior = before.timingStats?.[loggerName]?.[op];
    const count = stat.count - (prior?.count ?? 0);
    const totalMs = stat.totalTime - (prior?.totalTime ?? 0);
    if (count > 0) rows.push({ key: `${loggerName}/${op}`, count, totalMs });
  }
}
rows.sort((a, b) => b.totalMs - a.totalMs);
const priorSlow = new Set(
  (before.slowQueries ?? []).map((entry) => JSON.stringify(entry)),
);
const newSlow = (after.slowQueries ?? []).filter((entry) =>
  !priorSlow.has(JSON.stringify(entry))
);
let text =
  `# server timing delta (command wall ${
    wall.toFixed(0)
  }ms, exit ${status.code})\n` +
  `# server ${meta.gitSha ?? "?"} serverExecution=${serverPosture}, ` +
  `client serverExecution=${clientPosture}\n`;
for (const row of rows.slice(0, 40)) {
  text += `${row.totalMs.toFixed(0).padStart(8)}ms ${
    String(row.count).padStart(7)
  }x ${(row.totalMs / row.count).toFixed(2).padStart(9)}ms/call  ${row.key}\n`;
}
text += `\n# new slow queries (${newSlow.length})\n`;
for (const entry of newSlow) {
  const q = entry as Record<string, number | string | undefined>;
  text += `${Number(q.elapsed).toFixed(0).padStart(6)}ms ${q.operation} ` +
    `roots=${q.rootsVisited ?? "-"} reads=${q.managerReads ?? "-"} ` +
    `upserts=${q.upserts ?? "-"} watches=${q.watches ?? "-"} ` +
    `lockWait=${q.lockWaitMs ?? "-"}\n`;
}
await Deno.writeTextFile(`${out}.server.delta.txt`, text);
await Deno.writeTextFile(
  `${out}.server.stats.json`,
  JSON.stringify({
    wall,
    posture: { server: serverPosture, client: clientPosture },
    rows,
    newSlow,
    documentCaches: after.documentCaches,
  }),
);
console.error(
  `[profile-toolshed] wrote ${out}.server.* (command ${wall.toFixed(0)}ms)`,
);
Deno.exit(status.code);
