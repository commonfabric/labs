/**
 * Writes a V8 heap snapshot of the process behind an inspector port to a file,
 * after a full collection. It writes chunk by chunk, so the snapshot's size is
 * not limited by the longest string V8 can hold.
 *
 * The inspector reaches a process's main thread alone, so a serving loop has to
 * run there: start the server with `SERVER_EXECUTION_WORKER=false` and `--inspect`.
 *
 *   deno run --allow-net --allow-write heap-snapshot.ts <port> <out.heapsnapshot>
 */

const [port, outPath] = Deno.args;
if (port === undefined || outPath === undefined) {
  console.error("usage: heap-snapshot.ts <port> <out.heapsnapshot>");
  Deno.exit(2);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const file = await Deno.open(outPath, {
  create: true,
  write: true,
  truncate: true,
});
const encoder = new TextEncoder();
const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

let written = 0;
let writes = Promise.resolve();
let nextId = 1;
const pending = new Map<number, () => void>();
socket.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  if (message.method === "HeapProfiler.addHeapSnapshotChunk") {
    const bytes = encoder.encode(message.params.chunk);
    written += bytes.length;
    writes = writes.then(async () => {
      let at = 0;
      while (at < bytes.length) at += await file.write(bytes.subarray(at));
    });
  } else if (message.id !== undefined) {
    pending.get(message.id)?.();
    pending.delete(message.id);
  }
};
const send = (method: string, params: unknown = {}) =>
  new Promise<void>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });

await send("HeapProfiler.enable");
await send("HeapProfiler.collectGarbage");
await send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
await writes;
file.close();
socket.close();
console.error(`wrote ${(written / 1e6).toFixed(0)} MB to ${outPath}`);
