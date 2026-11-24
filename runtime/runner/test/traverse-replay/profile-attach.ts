/**
 * Attach the CDP sampling profiler to an ALREADY-RUNNING Deno process (e.g.
 * a local toolshed started with --inspect) and sample for a fixed window
 * while external load runs. Writes the same .cpuprofile + ranked reports as
 * profile-driver.ts.
 *
 *   deno run --allow-net --allow-write test/traverse-replay/profile-attach.ts \
 *     [inspector-host:port] [seconds] [out-prefix]
 */

const inspector = Deno.args[0] ?? "127.0.0.1:9229";
const seconds = Number(Deno.args[1] ?? "60");
const outPrefix = Deno.args[2] ?? "/tmp/attach-profile";

const res = await fetch(`http://${inspector}/json/list`);
const targets = await res.json();
const wsUrl: string | undefined = targets[0]?.webSocketDebuggerUrl;
if (wsUrl === undefined) {
  console.error(`no inspector target at ${inspector}`);
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

await send("Profiler.enable");
await send("Profiler.setSamplingInterval", { interval: 100 });
await send("Profiler.start");
console.log(`sampling ${inspector} for ${seconds}s ...`);
await new Promise((r) => setTimeout(r, seconds * 1000));

type CPUProfile = {
  nodes: Array<{
    id: number;
    hitCount?: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
    children?: number[];
  }>;
  samples?: number[];
  timeDeltas?: number[];
};

const { profile } = await send("Profiler.stop") as { profile: CPUProfile };
ws.close();

Deno.writeTextFileSync(`${outPrefix}.cpuprofile`, JSON.stringify(profile));

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
  const file = url.match(/\/((?:base|data-model|patterns|runtime|utils)\/.*)$/)
    ?.[1] ?? url.split("/").pop() ?? url;
  const frame = `${functionName || "(anonymous)"} @ ${file}:${lineNumber + 1}`;
  byFrame.set(frame, (byFrame.get(frame) ?? 0) + us);
  byFile.set(file || "(internal)", (byFile.get(file) ?? 0) + us);
}

const fmt = (us: number) =>
  `${(us / 1000).toFixed(0).padStart(7)}ms ${
    ((us / totalUs) * 100).toFixed(1).padStart(5)
  }%`;

let report = `# Attached CPU profile: ${inspector}, ${seconds}s window\n`;
report += `total sampled: ${(totalUs / 1000).toFixed(0)}ms\n\n`;
report += `## Top frames by self time\n`;
for (
  const [frame, us] of [...byFrame.entries()].sort((a, b) => b[1] - a[1])
    .slice(0, 50)
) {
  report += `${fmt(us)}  ${frame}\n`;
}
report += `\n## By file\n`;
for (
  const [file, us] of [...byFile.entries()].sort((a, b) => b[1] - a[1])
    .slice(0, 30)
) {
  report += `${fmt(us)}  ${file}\n`;
}

Deno.writeTextFileSync(`${outPrefix}.report.txt`, report);
console.log(report);
