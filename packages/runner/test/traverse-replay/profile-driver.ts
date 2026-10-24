/**
 * CPU-profiles a traverse replay via the V8 inspector protocol — no external
 * tooling. Spawns profile-target.ts with --inspect, attaches over CDP,
 * samples between the PROFILE_START/PROFILE_DONE console markers, and writes
 * both the raw .cpuprofile and a ranked self-time report.
 *
 *   deno run --allow-all test/traverse-replay/profile-driver.ts \
 *     [fixture-name] [rounds] [out-prefix]
 */

import { fromFileUrl } from "@std/path";

const fixtureName = Deno.args[0] ?? "notebook-test";
const rounds = Deno.args[1] ?? "2";
const outPrefix = Deno.args[2] ?? `/tmp/traverse-${fixtureName}`;

/** Optional: forwarded to profile-target to replay a single invocation. */
const onlyInvocation = Deno.args[3];

const INSPECT_PORT = 9911;

const target = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    `--inspect=127.0.0.1:${INSPECT_PORT}`,
    "--allow-read",
    "--allow-env",
    fromFileUrl(new URL("./profile-target.ts", import.meta.url)),
    fixtureName,
    rounds,
    ...(onlyInvocation !== undefined ? [onlyInvocation] : []),
  ],
  stdout: "piped",
  stderr: "null",
}).spawn();

// Wait for the inspector endpoint, then fetch the websocket URL.
let wsUrl: string | undefined;
for (let i = 0; i < 50 && wsUrl === undefined; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`);
    const targets = await res.json();
    wsUrl = targets[0]?.webSocketDebuggerUrl;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
if (wsUrl === undefined) {
  console.error("could not reach inspector");
  target.kill();
  Deno.exit(1);
}

const ws = new WebSocket(wsUrl);
let nextId = 1;
const pending = new Map<number, (result: unknown) => void>();
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<unknown>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await new Promise((resolve) => ws.onopen = resolve);

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data as string);
  if (msg.id !== undefined) {
    pending.get(msg.id)?.(msg.result);
    pending.delete(msg.id);
  }
};

await send("Runtime.enable");
await send("Profiler.enable");
await send("Profiler.setSamplingInterval", { interval: 100 });
await send("Runtime.runIfWaitingForDebugger");

// Watch stdout for the start/done markers.
const decoder = new TextDecoder();
const reader = target.stdout.getReader();
let buffer = "";
let started = false;
let doneLine = "";
while (doneLine === "") {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value);
  if (!started && buffer.includes("PROFILE_START")) {
    await send("Profiler.start");
    started = true;
  }
  const match = buffer.match(/PROFILE_DONE.*$/m);
  if (started && match !== null) doneLine = match[0];
}

const { profile } = await send("Profiler.stop") as {
  profile: CPUProfile;
};
target.kill();

type CPUProfile = {
  nodes: Array<{
    id: number;
    hitCount?: number;
    callFrame: {
      functionName: string;
      url: string;
      lineNumber: number;
    };
    children?: number[];
  }>;
  samples?: number[];
  timeDeltas?: number[];
  startTime: number;
  endTime: number;
};

Deno.writeTextFileSync(`${outPrefix}.cpuprofile`, JSON.stringify(profile));

//
// self-time report
//
// Attribute sampled time per node via timeDeltas (more accurate than
// hitCount * interval), then aggregate by frame and by file.
//
const nodeTime = new Map<number, number>();
if (profile.samples && profile.timeDeltas) {
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i];
    nodeTime.set(id, (nodeTime.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
  }
}
const totalUs = [...nodeTime.values()].reduce((a, b) => a + b, 0);

const byFrame = new Map<string, number>();
const byFile = new Map<string, number>();
for (const node of profile.nodes) {
  const us = nodeTime.get(node.id) ?? 0;
  if (us === 0) continue;
  const { functionName, url, lineNumber } = node.callFrame;
  const file = url.split("/packages/")[1] ?? url.split("/").pop() ?? url;
  const frame = `${functionName || "(anonymous)"} @ ${file}:${lineNumber + 1}`;
  byFrame.set(frame, (byFrame.get(frame) ?? 0) + us);
  byFile.set(file || "(internal)", (byFile.get(file) ?? 0) + us);
}

const fmt = (us: number) =>
  `${(us / 1000).toFixed(0).padStart(7)}ms ${
    ((us / totalUs) * 100).toFixed(1).padStart(5)
  }%`;

let report = `# CPU profile: ${fixtureName} x${rounds} (${doneLine})\n`;
report += `total sampled: ${(totalUs / 1000).toFixed(0)}ms\n\n`;
report += `## Top frames by self time\n`;
for (
  const [frame, us] of [...byFrame.entries()].sort((a, b) => b[1] - a[1])
    .slice(0, 45)
) {
  report += `${fmt(us)}  ${frame}\n`;
}
report += `\n## By file\n`;
for (
  const [file, us] of [...byFile.entries()].sort((a, b) => b[1] - a[1])
    .slice(0, 25)
) {
  report += `${fmt(us)}  ${file}\n`;
}

Deno.writeTextFileSync(`${outPrefix}.report.txt`, report);
console.log(report);
Deno.exit(0);
