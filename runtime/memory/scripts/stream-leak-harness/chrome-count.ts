/**
 * Counts live `ReadableStream` objects in a Chromium page and its dedicated
 * worker over the DevTools protocol, after a full garbage collection, so the
 * harness can be measured in Chromium the way `heap -s` measures it in
 * WebKit. Start Chrome with remote debugging on the harness page first:
 *
 *     "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *       --remote-debugging-port=9333 --user-data-dir=/tmp/stream-harness \
 *       --use-mock-keychain --password-store=basic --no-first-run \
 *       "http://localhost:8765/?mode=idle&iterations=1&autostart=1"
 *
 *     deno run --allow-net chrome-count.ts [9333]
 */

const port = Number(Deno.args[0] ?? "9333");

type Target = {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
};

const targets: Target[] = await (await fetch(`http://localhost:${port}/json`))
  .json();
const page = targets.find((target) =>
  target.type === "page" && target.url.includes(":8765")
);
if (!page) throw new Error("harness page not found among Chrome targets");

/** One protocol session multiplexed over the page's socket. */
class Session {
  #socket: WebSocket;
  #next = 1;
  #pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  #attached: Array<{ sessionId: string; type: string; url: string }> = [];

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) {
          pending?.reject(new Error(JSON.stringify(message.error)));
        } else {
          pending?.resolve(message.result);
        }
      } else if (message.method === "Target.attachedToTarget") {
        this.#attached.push({
          sessionId: message.params.sessionId,
          type: message.params.targetInfo.type,
          url: message.params.targetInfo.url,
        });
      }
    };
  }

  /** Sends one command, to the page or to an attached `sessionId`. */
  send(method: string, params: unknown = {}, sessionId?: string) {
    const id = this.#next++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (result) => resolve(result as Record<string, unknown>),
        reject,
      });
      this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  /** Targets attached so far. */
  get attached() {
    return this.#attached;
  }
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => socket.onopen = resolve);
const session = new Session(socket);
await session.send("Target.setAutoAttach", {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
});

/** Counts live `ReadableStream`s in one realm after a full collection. */
async function count(sessionId: string | undefined): Promise<number> {
  await session.send("Runtime.enable", {}, sessionId);
  await session.send("HeapProfiler.collectGarbage", {}, sessionId);
  const prototype = await session.send("Runtime.evaluate", {
    expression: "ReadableStream.prototype",
    objectGroup: "count",
  }, sessionId);
  const objects = await session.send("Runtime.queryObjects", {
    prototypeObjectId: (prototype.result as { objectId: string }).objectId,
    objectGroup: "count",
  }, sessionId);
  const length = await session.send("Runtime.callFunctionOn", {
    objectId: (objects.objects as { objectId: string }).objectId,
    functionDeclaration: "function() { return this.length; }",
    returnByValue: true,
  }, sessionId);
  await session.send(
    "Runtime.releaseObjectGroup",
    { objectGroup: "count" },
    sessionId,
  );
  return (length.result as { value: number }).value;
}

console.log(`page ReadableStream: ${await count(undefined)}`);
for (const target of session.attached) {
  if (target.type !== "worker") continue;
  console.log(`worker ReadableStream: ${await count(target.sessionId)}`);
}
socket.close();
