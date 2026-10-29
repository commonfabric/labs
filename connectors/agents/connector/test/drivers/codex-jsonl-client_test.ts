import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { CodexJsonlClient } from "../../src/drivers/codex-jsonl-client.ts";

const DEFERRED_SERVER = String.raw`#!/usr/bin/env python3
import json, os, signal, sys

deferred_id = None
exit_marker = sys.argv[1] if len(sys.argv) > 1 else None
blocked_pid_marker = sys.argv[2] if len(sys.argv) > 2 else None
request_seen_marker = sys.argv[3] if len(sys.argv) > 3 else None
release_marker = sys.argv[4] if len(sys.argv) > 4 else None
exit_written = False
exit_reason = "exited"

def write_exit_marker():
    global exit_written
    if not exit_marker or exit_written:
        return
    with open(exit_marker, "w") as marker:
        marker.write(exit_reason + "\n")
    exit_written = True

def stop(_signum, _frame):
    global exit_reason
    exit_reason = "terminated"
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
try:
    for line in sys.stdin:
        message = json.loads(line)
        method = message.get("method")
        if "id" not in message:
            continue
        if method == "initialize":
            print(json.dumps({"id": message["id"], "result": {}}), flush=True)
            if blocked_pid_marker:
                with open(blocked_pid_marker, "w") as marker:
                    marker.write(str(os.getpid()) + "\n")
                sys.stdin.readline()
                sys.stdin.read(1)
                with open(request_seen_marker, "w") as marker:
                    marker.write("request seen\n")
                with open(release_marker, "r") as release:
                    release.read(1)
                exit_reason = "released"
                break
        elif method == "deferred":
            deferred_id = message["id"]
        elif method == "release":
            if deferred_id is not None:
                print(json.dumps({"id": deferred_id, "result": {"released": True}}), flush=True)
                deferred_id = None
            print(json.dumps({"id": message["id"], "result": {}}), flush=True)
        elif method == "notify":
            print(json.dumps({"id": message["id"], "result": {}}), flush=True)
            params = {"ready": True}
            params.update(message.get("params", {}))
            print(json.dumps({"method": "event/ready", "params": params}), flush=True)
        elif method == "notify-exit":
            print(json.dumps({"id": message["id"], "result": {}}), flush=True)
            print(json.dumps({"method": "event/ready", "params": {"ready": True}}), flush=True)
            break
        elif method == "exit":
            print(json.dumps({"id": message["id"], "result": {}}), flush=True)
            break
finally:
    write_exit_marker()
`;

const MALFORMED_SERVER = String.raw`#!/usr/bin/env python3
import json, sys

frame = sys.argv[1] if len(sys.argv) > 1 else "{not-json"
for line in sys.stdin:
    message = json.loads(line)
    if message.get("method") == "initialize":
        print(json.dumps({"id": message["id"], "result": {}}), flush=True)
    elif message.get("method") == "emit-malformed":
        print(frame, flush=True)
`;

const RETRY_SERVER = String.raw`#!/usr/bin/env python3
import json, os, sys

attempt_path = sys.argv[1]
attempt = 1
if os.path.exists(attempt_path):
    with open(attempt_path, "r") as source:
        attempt = int(source.read()) + 1
with open(attempt_path, "w") as target:
    target.write(str(attempt))

for line in sys.stdin:
    message = json.loads(line)
    if "id" not in message:
        continue
    if message.get("method") == "initialize" and attempt == 1:
        print(json.dumps({"id": message["id"], "error": {"message": "first startup failed"}}), flush=True)
    else:
        print(json.dumps({"id": message["id"], "result": {"attempt": attempt}}), flush=True)
`;

const PROTOCOL_SERVER = String.raw`#!/usr/bin/env python3
import json, sys

for line in sys.stdin:
    message = json.loads(line)
    if "id" not in message:
        continue
    method = message.get("method")
    if method == "initialize":
        print(json.dumps({"id": message["id"], "result": {}}), flush=True)
    elif method == "server-request":
        print(json.dumps({
            "jsonrpc": "2.0",
            "id": "server-request-id",
            "method": message.get("params", {}).get("method", "server/method"),
            "params": {"value": 42},
        }), flush=True)
        reply = json.loads(sys.stdin.readline())
        print(json.dumps({"id": message["id"], "result": reply}), flush=True)
    elif method == "unknown-response":
        print(json.dumps({"id": 999999, "result": {"ignored": True}}), flush=True)
        print(json.dumps({"id": message["id"], "result": {"complete": True}}), flush=True)
    elif method == "flood":
        print(json.dumps({"id": message["id"], "result": {}}), flush=True)
        for index in range(501):
            print(json.dumps({
                "method": "event/item",
                "params": {"index": index},
            }), flush=True)
`;

function outcome<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error: String(error) }),
  );
}

Deno.test("Codex client rejects invalid lifecycle operations", async () => {
  assertThrows(
    () => new CodexJsonlClient([]),
    Error,
    "Codex command must not be empty",
  );

  const client = new CodexJsonlClient(["unused"]);
  await assertRejects(
    () => client.call("before-start"),
    Error,
    "Codex App Server is not running",
  );
  await assertRejects(
    () => client.notify("before-start"),
    Error,
    "Codex App Server is not running",
  );
});

Deno.test("Codex client handles server requests and notification pressure", async () => {
  const directory = await Deno.makeTempDir();
  const server = `${directory}/protocol-server`;
  await Deno.writeTextFile(server, PROTOCOL_SERVER);
  await Deno.chmod(server, 0o755);
  try {
    const unsupported = new CodexJsonlClient([server]);
    await unsupported.start();
    await assertRejects(
      () => unsupported.start(),
      Error,
      "Codex App Server already started",
    );
    assertEquals(await unsupported.call("server-request"), {
      jsonrpc: "2.0",
      id: "server-request-id",
      error: {
        code: -32601,
        message: "Unsupported server request: server/method",
      },
    });
    assertEquals(await unsupported.call("unknown-response"), {
      complete: true,
    });
    const last = unsupported.waitForNotification((message) =>
      (message.params as { index?: number } | undefined)?.index === 500
    );
    await unsupported.call("flood");
    assertEquals(await last, {
      method: "event/item",
      params: { index: 500 },
    });
    await unsupported.stop();

    const handled = new CodexJsonlClient([server], undefined, {
      handleServerRequest: (method, params) => ({ method, params }),
    });
    await handled.start();
    assertEquals(await handled.call("server-request", { method: "handled" }), {
      jsonrpc: "2.0",
      id: "server-request-id",
      result: {
        method: "handled",
        params: { value: 42 },
      },
    });
    await handled.stop();

    const failed = new CodexJsonlClient([server], undefined, {
      handleServerRequest: () => {
        throw new Error("handler failed");
      },
    });
    await failed.start();
    assertEquals(await failed.call("server-request"), {
      jsonrpc: "2.0",
      id: "server-request-id",
      error: {
        code: -32603,
        message: "Error: handler failed",
      },
    });
    await failed.stop();
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Codex requests remain pending until the server responds", async () => {
  const dir = await Deno.makeTempDir();
  const server = `${dir}/deferred-codex`;
  await Deno.writeTextFile(server, DEFERRED_SERVER);
  await Deno.chmod(server, 0o755);
  const client = new CodexJsonlClient([server]);
  await client.start();
  using time = new FakeTime();
  try {
    const pending = outcome(client.call("deferred"));
    time.tick(30_001);
    await client.call("release");
    assertEquals(await pending, { ok: true, value: { released: true } });
  } finally {
    await client.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Codex notification waits remain pending until a match arrives", async () => {
  const dir = await Deno.makeTempDir();
  const server = `${dir}/deferred-codex`;
  await Deno.writeTextFile(server, DEFERRED_SERVER);
  await Deno.chmod(server, 0o755);
  const client = new CodexJsonlClient([server]);
  await client.start();
  using time = new FakeTime();
  try {
    const pending = outcome(
      client.waitForNotification((message) => message.method === "event/ready"),
    );
    time.tick(60 * 60 * 1000 + 1);
    await client.call("notify");
    assertEquals(await pending, {
      ok: true,
      value: { method: "event/ready", params: { ready: true } },
    });
  } finally {
    await client.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Codex restart discards buffered notifications", async () => {
  const dir = await Deno.makeTempDir();
  const server = `${dir}/deferred-codex`;
  await Deno.writeTextFile(server, DEFERRED_SERVER);
  await Deno.chmod(server, 0o755);
  const client = new CodexJsonlClient([server]);
  try {
    await client.start();
    await client.call("notify", { run: "old" });
    await client.stop();

    await client.start();
    const notification = client.waitForNotification((message) =>
      message.method === "event/ready"
    );
    await client.call("notify", { run: "new" });
    assertEquals(await notification, {
      method: "event/ready",
      params: { ready: true, run: "new" },
    });
  } finally {
    await client.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Codex waits for failed startup cleanup before retrying", async () => {
  const dir = await Deno.makeTempDir();
  const server = `${dir}/retry-codex`;
  const attempts = `${dir}/attempts`;
  await Deno.writeTextFile(server, RETRY_SERVER);
  await Deno.chmod(server, 0o755);
  const client = new CodexJsonlClient([server, attempts]);
  try {
    await assertRejects(() => client.start(), Error, "first startup failed");
    assertEquals(await client.start(), { attempt: 2 });
    assertEquals(await client.call("ping"), { attempt: 2 });
  } finally {
    await client.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stopping Codex twice at once settles both calls together", async () => {
  const dir = await Deno.makeTempDir();
  const server = `${dir}/deferred-codex`;
  await Deno.writeTextFile(server, DEFERRED_SERVER);
  await Deno.chmod(server, 0o755);
  const client = new CodexJsonlClient([server]);
  try {
    await client.start();
    const first = client.stop();
    const second = client.stop();
    // A second call while a stop is in flight settles no later than the
    // first does. That the two are one stop is not observable from here.
    let secondSettled = false;
    const observed = second.then(() => {
      secondSettled = true;
    });
    await first;
    assertEquals(secondSettled, true);
    await observed;
  } finally {
    await client.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stopping Codex rejects pending requests and notification waits", async () => {
  const dir = await Deno.makeTempDir();
  const server = `${dir}/deferred-codex`;
  await Deno.writeTextFile(server, DEFERRED_SERVER);
  await Deno.chmod(server, 0o755);
  const client = new CodexJsonlClient([server]);
  await client.start();
  try {
    const request = outcome(client.call("deferred"));
    const notification = outcome(
      client.waitForNotification((message) => message.method === "event/ready"),
    );
    await client.stop();
    assertEquals((await request).ok, false);
    assertEquals((await notification).ok, false);
    assertEquals(
      (await outcome(
        client.waitForNotification((message) =>
          message.method === "event/ready"
        ),
      )).ok,
      false,
    );
  } finally {
    await client.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("aborting the Codex owner stops the child and rejects pending work", async () => {
  const dir = await Deno.makeTempDir();
  const server = `${dir}/deferred-codex`;
  const exitMarker = `${dir}/child-exited`;
  const pidMarker = `${dir}/child-pid`;
  const requestSeenMarker = `${dir}/request-seen`;
  const releaseMarker = `${dir}/release-child`;
  await Deno.writeTextFile(server, DEFERRED_SERVER);
  await Deno.chmod(server, 0o755);
  const fifo = await new Deno.Command("mkfifo", {
    args: [exitMarker, pidMarker, requestSeenMarker, releaseMarker],
  }).output();
  assertEquals(fifo.success, true);
  const exitObserver = new Deno.Command("python3", {
    args: [
      "-c",
      "import sys; print(open(sys.argv[1]).read(), end='')",
      exitMarker,
    ],
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const exited = new Response(exitObserver.stdout).text();
  const pidObserver = new Deno.Command("python3", {
    args: [
      "-c",
      "import sys; print(open(sys.argv[1]).read(), end='')",
      pidMarker,
    ],
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const childPid = new Response(pidObserver.stdout).text();
  const requestSeenObserver = new Deno.Command("python3", {
    args: [
      "-c",
      "import sys; print(open(sys.argv[1]).read(), end='')",
      requestSeenMarker,
    ],
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const requestSeen = new Response(requestSeenObserver.stdout).text();
  const controller = new AbortController();
  const client = new CodexJsonlClient([
    server,
    exitMarker,
    pidMarker,
    requestSeenMarker,
    releaseMarker,
  ]);
  await client.start(controller.signal);
  let releaseWriter: Deno.ChildProcess | undefined;
  try {
    const pid = Number((await childPid).trim());
    assertEquals(Number.isInteger(pid), true);
    assertEquals((await pidObserver.status).success, true);
    Deno.kill(pid, "SIGSTOP");
    const request = outcome(
      client.call("release-on-read", { payload: "x".repeat(16 * 1024 * 1024) }),
    );
    const notification = outcome(
      client.waitForNotification((message) => message.method === "event/ready"),
    );
    controller.abort("owner stopped");
    Deno.kill(pid, "SIGCONT");
    const shutdown = await Promise.race([
      exited.then((value) => ({ kind: "exit" as const, value })),
      requestSeen.then((value) => ({ kind: "request" as const, value })),
    ]);
    let exitReason: string;
    if (shutdown.kind === "request") {
      assertEquals(shutdown.value, "request seen\n");
      assertEquals((await requestSeenObserver.status).success, true);
      releaseWriter = new Deno.Command("python3", {
        args: [
          "-c",
          "import sys; open(sys.argv[1], 'w').write('release\\n')",
          releaseMarker,
        ],
        stdout: "null",
        stderr: "null",
      }).spawn();
      assertEquals((await releaseWriter.status).success, true);
      exitReason = await exited;
    } else {
      exitReason = shutdown.value;
    }
    assertEquals((await request).ok, false);
    assertEquals((await notification).ok, false);
    if (shutdown.kind === "request") {
      assertEquals(
        exitReason === "terminated\n" || exitReason === "released\n",
        true,
      );
    } else {
      assertEquals(exitReason, "terminated\n");
    }
    assertEquals((await exitObserver.status).success, true);
  } finally {
    await client.stop();
    try {
      exitObserver.kill("SIGTERM");
    } catch {
      // The process has exited.
    }
    await exitObserver.status.catch(() => undefined);
    try {
      pidObserver.kill("SIGTERM");
    } catch {
      // The process has exited.
    }
    await pidObserver.status.catch(() => undefined);
    try {
      requestSeenObserver.kill("SIGTERM");
    } catch {
      // The process has exited.
    }
    await requestSeenObserver.status.catch(() => undefined);
    if (releaseWriter) {
      try {
        releaseWriter.kill("SIGTERM");
      } catch {
        // The process has exited.
      }
      await releaseWriter.status.catch(() => undefined);
    }
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Codex returns matching buffered notifications after child exit", async () => {
  const dir = await Deno.makeTempDir();
  const server = `${dir}/deferred-codex`;
  await Deno.writeTextFile(server, DEFERRED_SERVER);
  await Deno.chmod(server, 0o755);
  const client = new CodexJsonlClient([server]);
  await client.start();
  try {
    const exitObserved = outcome(
      client.waitForNotification((message) =>
        message.method === "event/unmatched"
      ),
    );
    await client.call("notify-exit");
    assertEquals((await exitObserved).ok, false);
    assertEquals(
      await client.waitForNotification((message) =>
        message.method === "event/ready"
      ),
      { method: "event/ready", params: { ready: true } },
    );
    assertEquals(
      (await outcome(
        client.waitForNotification((message) =>
          message.method === "event/unmatched"
        ),
      )).ok,
      false,
    );
  } finally {
    await client.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Codex rejects notification waits after the child exits", async () => {
  const dir = await Deno.makeTempDir();
  const server = `${dir}/deferred-codex`;
  await Deno.writeTextFile(server, DEFERRED_SERVER);
  await Deno.chmod(server, 0o755);
  const client = new CodexJsonlClient([server]);
  await client.start();
  try {
    const duringExit = outcome(
      client.waitForNotification((message) => message.method === "event/ready"),
    );
    await client.call("exit");
    assertEquals((await duringExit).ok, false);
    assertEquals(
      (await outcome(
        client.waitForNotification((message) =>
          message.method === "event/ready"
        ),
      )).ok,
      false,
    );
  } finally {
    await client.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Codex terminates a server that emits malformed JSON", async () => {
  const directory = await Deno.makeTempDir();
  const server = `${directory}/malformed-server`;
  await Deno.writeTextFile(server, MALFORMED_SERVER);
  await Deno.chmod(server, 0o755);
  try {
    const cases = [
      ["{not-json", "emitted invalid JSON"],
      ["[]", "emitted invalid JSON"],
      ["{}", "invalid JSON-RPC message"],
      ['{"id":2}', "invalid JSON-RPC response"],
      ['{"id":2,"result":{},"error":{}}', "invalid JSON-RPC response"],
      ['{"id":2,"error":"bad"}', "invalid JSON-RPC error"],
    ] as const;
    for (const [frame, expected] of cases) {
      const client = new CodexJsonlClient([server, frame]);
      try {
        await client.start();
        const notification = client.waitForNotification(() => true);
        await assertRejects(
          () => client.call("emit-malformed"),
          Error,
          expected,
        );
        await assertRejects(() => notification, Error);
      } finally {
        await client.stop();
      }
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
