/**
 * Browser harness for the memory compression envelope's stream lifetime.
 *
 * It runs one of several variants of the compression work many times and then
 * idles so an external tool can count the live `ReadableStream` objects in the
 * engine: `heap -s <WebContent pid>` for WebKit, a Chrome DevTools Protocol
 * `Runtime.queryObjects` for Chromium. The "module" variants call the real
 * exports of `message-compression.ts`; the others isolate one expression each
 * so the leaking one can be named. The script works both as a module Worker
 * and as a module imported by the page, selected by `index.html`.
 */

import {
  decodeCompressedMemoryMessage,
  encodeCompressedMemoryMessage,
  type EncodedMemoryMessage,
} from "../../v2/message-compression.ts";

/** One run request from the page. */
export type HarnessRequest = {
  mode: HarnessMode;
  iterations: number;
  payloadBytes: number;
  /** Megabytes of garbage to allocate after the loop, to provoke collections. */
  pressureMegabytes: number;
  /** Echo WebSocket URL for the `ws-*` modes. */
  echoUrl: string;
  /** URL returning `payloadBytes` of body for the `fetch-*` modes. */
  bytesUrl: string;
  /**
   * URL streaming delayed chunks, the shape of a streamed LLM reply; the page
   * sets the chunk count, the gap between chunks, and the gap between the
   * last chunk and the end of the body.
   */
  slowUrl: string;
};

/** Progress and completion reports from a run. */
export type HarnessReport =
  | { type: "progress"; completed: number }
  | {
    type: "done";
    mode: HarnessMode;
    iterations: number;
    elapsedMs: number;
    /** Whether a full collection ran through `$vm.gc()` after the loop. */
    collected: boolean;
  }
  | { type: "error"; message: string };

/** Variants the harness can run. */
export const HARNESS_MODES = [
  "module-roundtrip",
  "module-roundtrip-concurrent",
  "module-roundtrip-sizes",
  "module-encode",
  "module-decode",
  "module-decode-blob",
  "ws-roundtrip-arraybuffer",
  "ws-roundtrip-blob",
  "fetch-arraybuffer",
  "fetch-body-collect",
  "fetch-body-collect-release",
  "fetch-body-collect-cancel",
  "fetch-body-pipe-collect",
  "fetch-body-for-await",
  "fetch-gzip-body-pipe-collect",
  "fetch-slow-body-collect",
  "fetch-slow-decoder-collect",
  "fetch-slow-xhr-progress",
  "fetch-slow-body-then-text",
  "fetch-slow-text",
  "response-body-drop",
  "response-empty-body-collect",
  "response-pipe-noread",
  "response-body-collect",
  "response-pipe-collect",
  "response-pipe-collect-release",
  "response-pipe-collect-cancel",
  "response-pipe-arraybuffer",
  "response-arraybuffer-direct",
  "blob-pipe-collect",
  "js-source-collect",
  "js-source-pipe-collect",
  "writer-collect",
  "idle",
] as const;

/** One variant name. */
export type HarnessMode = (typeof HARNESS_MODES)[number];

const TEXT_ENCODER = new TextEncoder();

/** Builds a compressible memory-like text payload of about `bytes` UTF-8. */
export function buildPayload(bytes: number): string {
  const words = ["fvj1:", "session", "effect", "cell", "patch", "value"];
  const parts: string[] = [];
  let length = 0;
  let seed = 7;
  while (length < bytes) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const part = `${words[seed % words.length]}${seed % 977},`;
    parts.push(part);
    length += part.length;
  }
  return parts.join("");
}

/** Runs `request`, reporting progress through `report`. */
export async function runHarness(
  request: HarnessRequest,
  report: (report: HarnessReport) => void,
): Promise<void> {
  const payload = buildPayload(request.payloadBytes);
  const bytes = TEXT_ENCODER.encode(payload);
  const encoded = await encodeCompressedMemoryMessage(payload);
  const { step, cleanup } = await selectStep(request, payload, bytes, encoded);
  try {
    const start = performance.now();
    for (let completed = 0; completed < request.iterations; completed++) {
      await step();
      if ((completed + 1) % 100 === 0) {
        report({ type: "progress", completed: completed + 1 });
      }
    }
    const elapsedMs = performance.now() - start;
    allocatePressure(request.pressureMegabytes);
    report({
      type: "done",
      mode: request.mode,
      iterations: request.iterations,
      elapsedMs,
      collected: collectGarbage(),
    });
  } finally {
    cleanup?.();
  }
}

/** One variant: its per-iteration body, and what to release after the run. */
type Step = { step: () => Promise<void>; cleanup?: () => void };

/** The envelope the decode variants replay; needs a compressible payload. */
function requireEnvelope(
  encoded: EncodedMemoryMessage,
): Uint8Array<ArrayBuffer> {
  if (!(encoded instanceof Uint8Array)) {
    throw new Error(
      "the decode variants need a payload above the compression threshold",
    );
  }
  return encoded;
}

/**
 * Runs a full collection when the engine exposes one: JavaScriptCore's `$vm`
 * (a WebContent process started with `JSC_useDollarVM=1`) or V8's `gc`
 * (Chromium started with `--js-flags=--expose-gc`).
 */
function collectGarbage(): boolean {
  const scope = globalThis as {
    $vm?: { gc(): void };
    gc?: () => void;
  };
  if (scope.$vm) {
    scope.$vm.gc();
    return true;
  }
  if (scope.gc) {
    scope.gc();
    return true;
  }
  return false;
}

/**
 * Allocates `megabytes` of buffers, holds them so the heap grows past the
 * engine's full-collection threshold, then drops them. Buffer memory counts
 * as extra memory in JavaScriptCore, which is what makes the collector run
 * full collections rather than eden ones.
 */
function allocatePressure(megabytes: number): void {
  const held: ArrayBuffer[] = [];
  for (let allocated = 0; allocated < megabytes; allocated++) {
    held.push(new ArrayBuffer(1_024 * 1_024));
    if (held.length === 64) held.length = 0;
  }
  if (held.length < 0) throw new Error("unreachable");
}

/** Returns the per-iteration body of `request.mode` and its cleanup. */
async function selectStep(
  request: HarnessRequest,
  payload: string,
  bytes: Uint8Array<ArrayBuffer>,
  encoded: EncodedMemoryMessage,
): Promise<Step> {
  const gzip = () => new CompressionStream("gzip");
  const only = (step: () => Promise<void>): Step => ({ step });
  switch (request.mode) {
    case "module-roundtrip":
      return only(async () => {
        const frame = await encodeCompressedMemoryMessage(payload);
        await decodeCompressedMemoryMessage(frame);
      });
    case "module-roundtrip-concurrent":
      return only(async () => {
        await Promise.all(Array.from({ length: 20 }, async () => {
          const frame = await encodeCompressedMemoryMessage(payload);
          await decodeCompressedMemoryMessage(frame);
        }));
      });
    case "module-roundtrip-sizes": {
      const payloads = [
        1_100,
        4_000,
        16_000,
        64_000,
        256_000,
        1_000_000,
        4_000_000,
      ]
        .map(buildPayload);
      let turn = 0;
      return only(async () => {
        const frame = await encodeCompressedMemoryMessage(
          payloads[turn++ % payloads.length],
        );
        await decodeCompressedMemoryMessage(frame);
      });
    }
    case "module-encode":
      return only(async () => {
        await encodeCompressedMemoryMessage(payload);
      });
    case "module-decode": {
      const envelope = requireEnvelope(encoded);
      return only(async () => {
        await decodeCompressedMemoryMessage(envelope);
      });
    }
    case "module-decode-blob": {
      const envelope = requireEnvelope(encoded);
      return only(async () => {
        await decodeCompressedMemoryMessage(new Blob([envelope]));
      });
    }
    case "ws-roundtrip-arraybuffer":
    case "ws-roundtrip-blob": {
      const socket = await openEcho(
        request.echoUrl,
        request.mode === "ws-roundtrip-blob" ? "blob" : "arraybuffer",
      );
      return {
        step: async () => {
          const frame = await encodeCompressedMemoryMessage(payload);
          const echoed = new Promise<MessageEvent>((resolve) => {
            socket.addEventListener("message", resolve, { once: true });
          });
          socket.send(frame);
          const message = await echoed;
          await decodeCompressedMemoryMessage(message.data);
        },
        cleanup: () => socket.close(),
      };
    }
    case "fetch-arraybuffer":
      return only(async () => {
        await (await fetch(request.bytesUrl)).arrayBuffer();
      });
    case "fetch-body-collect":
      return only(async () => {
        await collectReadable((await fetch(request.bytesUrl)).body!);
      });
    case "fetch-body-collect-release":
      return only(async () => {
        await collectReadable((await fetch(request.bytesUrl)).body!, "release");
      });
    case "fetch-body-collect-cancel":
      return only(async () => {
        await collectReadable((await fetch(request.bytesUrl)).body!, "cancel");
      });
    case "fetch-body-pipe-collect":
      return only(async () => {
        await collectReadable(
          (await fetch(request.bytesUrl)).body!.pipeThrough(gzip()),
        );
      });
    case "fetch-body-for-await":
      return only(async () => {
        for await (const chunk of (await fetch(request.bytesUrl)).body!) {
          void chunk;
        }
      });
    case "fetch-gzip-body-pipe-collect":
      return only(async () => {
        await collectReadable(
          (await fetch(`${request.bytesUrl}&gzip=1`)).body!.pipeThrough(
            new DecompressionStream("gzip"),
          ),
        );
      });
    case "fetch-slow-body-collect":
      return only(async () => {
        await collectReadable((await fetch(request.slowUrl)).body!);
      });
    case "fetch-slow-decoder-collect":
      return only(async () => {
        await collectText(
          (await fetch(request.slowUrl)).body!.pipeThrough(
            new TextDecoderStream(),
          ),
        );
      });
    case "fetch-slow-xhr-progress":
      return only(async () => {
        await loadWithProgressEvents(request.slowUrl);
      });
    case "fetch-slow-body-then-text":
      return only(async () => {
        const response = await fetch(request.slowUrl);
        // The getter alone: in WebKit it is what creates the body's stream.
        void response.body;
        await response.text();
      });
    case "fetch-slow-text":
      return only(async () => {
        await (await fetch(request.slowUrl)).text();
      });
    case "response-body-drop":
      return only(() => {
        void new Response(bytes).body;
        return Promise.resolve();
      });
    case "response-empty-body-collect":
      return only(async () => {
        await collectReadable(new Response(new Uint8Array(0)).body!);
      });
    case "response-pipe-noread":
      return only(() => {
        void new Response(bytes).body!.pipeThrough(gzip());
        return Promise.resolve();
      });
    case "response-body-collect":
      return only(async () => {
        await collectReadable(new Response(bytes).body!);
      });
    case "response-pipe-collect":
      return only(async () => {
        await collectReadable(new Response(bytes).body!.pipeThrough(gzip()));
      });
    case "response-pipe-collect-release":
      return only(async () => {
        await collectReadable(
          new Response(bytes).body!.pipeThrough(gzip()),
          "release",
        );
      });
    case "response-pipe-collect-cancel":
      return only(async () => {
        await collectReadable(
          new Response(bytes).body!.pipeThrough(gzip()),
          "cancel",
        );
      });
    case "response-pipe-arraybuffer":
      return only(async () => {
        await new Response(new Response(bytes).body!.pipeThrough(gzip()))
          .arrayBuffer();
      });
    case "response-arraybuffer-direct":
      return only(async () => {
        await new Response(bytes).arrayBuffer();
      });
    case "blob-pipe-collect":
      return only(async () => {
        await collectReadable(new Blob([bytes]).stream().pipeThrough(gzip()));
      });
    case "js-source-collect":
      return only(async () => {
        await collectReadable(singleChunkStream(bytes));
      });
    case "js-source-pipe-collect":
      return only(async () => {
        await collectReadable(singleChunkStream(bytes).pipeThrough(gzip()));
      });
    case "writer-collect":
      return only(async () => {
        const stream = gzip();
        const writer = stream.writable.getWriter();
        const written = writer.write(bytes).then(() => writer.close());
        await collectReadable(stream.readable);
        await written;
      });
    case "idle":
      return only(() => Promise.resolve());
  }
}

/** A stream yielding `bytes` as one chunk from a JavaScript source. */
function singleChunkStream(
  bytes: Uint8Array<ArrayBuffer>,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Opens an echo WebSocket delivering binary frames as `binaryType`. */
function openEcho(url: string, binaryType: BinaryType): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = binaryType;
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("echo failed")), {
      once: true,
    });
  });
}

/**
 * Collects `readable` the way `message-compression.ts` does, optionally
 * releasing the reader or cancelling the stream once it reports completion.
 */
async function collectReadable(
  readable: ReadableStream<Uint8Array>,
  after: "release" | "cancel" | "none" = "none",
): Promise<Uint8Array> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(value);
  }
  if (after === "release") reader.releaseLock();
  if (after === "cancel") {
    reader.releaseLock();
    await readable.cancel();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Reads a stream of strings to its end, the way a decoded reply is read. */
async function collectText(readable: ReadableStream<string>): Promise<string> {
  const reader = readable.getReader();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += value;
  }
}

/**
 * Loads `url` through `XMLHttpRequest`, taking the text received so far at
 * each progress event: partial delivery without a `ReadableStream`.
 */
function loadWithProgressEvents(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let delivered = "";
    request.open("GET", url);
    request.onprogress = () => {
      delivered += request.responseText.slice(delivered.length);
    };
    request.onload = () => resolve(request.responseText);
    request.onerror = () => reject(new Error(`XMLHttpRequest failed: ${url}`));
    request.send();
  });
}

/** The worker global, when this module runs as a dedicated worker. */
const workerScope = (globalThis as {
  DedicatedWorkerGlobalScope?: abstract new () => unknown;
}).DedicatedWorkerGlobalScope;
if (workerScope && globalThis instanceof workerScope) {
  const worker = globalThis as unknown as {
    onmessage: ((event: MessageEvent<HarnessRequest>) => void) | null;
    postMessage(message: HarnessReport): void;
  };
  worker.onmessage = (event) => {
    runHarness(event.data, (report) => worker.postMessage(report)).catch(
      (error) => {
        worker.postMessage({ type: "error", message: String(error) });
      },
    );
  };
}
