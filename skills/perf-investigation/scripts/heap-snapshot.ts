/**
 * Writes a V8 heap snapshot of the process behind an inspector port to a file,
 * after a full collection. It writes each chunk as it arrives, so the snapshot's
 * size is limited neither by the longest string V8 can hold nor by this process's
 * heap. A command the inspector refuses, or a connection that closes first, fails
 * the run rather than leaving a partial file behind a success.
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
const file = Deno.openSync(outPath, {
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
let nextId = 1;
const pending = new Map<number, PromiseWithResolvers<void>>();
const lost = (reason: string) => {
  for (const command of pending.values()) command.reject(new Error(reason));
  pending.clear();
  finished.reject(new Error(reason));
};
socket.onclose = () => lost("The inspector's connection closed");
socket.onerror = () => lost("The inspector's connection failed");

// The snapshot is a JSON object, whose last chunk closes it. V8 sends every chunk
// ahead of its response to the command, and this holds the run to that.
const finished = Promise.withResolvers<void>();
let responded = false;
let closed = false;
socket.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  if (message.method === "HeapProfiler.addHeapSnapshotChunk") {
    const chunk: string = message.params.chunk;
    const bytes = encoder.encode(chunk);
    written += bytes.length;
    let at = 0;
    while (at < bytes.length) at += file.writeSync(bytes.subarray(at));
    closed = chunk.trimEnd().endsWith("}");
    if (responded && closed) finished.resolve();
  } else if (message.id !== undefined) {
    const command = pending.get(message.id);
    pending.delete(message.id);
    if (message.error === undefined) command?.resolve();
    else command?.reject(new Error(JSON.stringify(message.error)));
  }
};
const send = (method: string, params: unknown = {}) => {
  const command = Promise.withResolvers<void>();
  const id = nextId++;
  pending.set(id, command);
  socket.send(JSON.stringify({ id, method, params }));
  return command.promise;
};

await send("HeapProfiler.enable");
await send("HeapProfiler.collectGarbage");
await send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
responded = true;
if (closed) finished.resolve();
await finished.promise;
socket.onclose = null;
socket.close();
file.close();
console.error(`wrote ${(written / 1e6).toFixed(0)} MB to ${outPath}`);
