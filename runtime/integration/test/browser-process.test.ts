/**
 * How a browser is stopped, which is what says when its profile directory can
 * go.
 *
 * The two exports covered here are the ones that can be driven without a
 * browser: a shell process tree stands in for Chrome's, and a shell script
 * stands in for a browser binary that never starts. What a real browser does
 * is covered by `browser.test.ts` here, and by the harness runs in
 * `deno-web-test`, each of which drives Chrome through `BrowserProcess`.
 */

import type { Browser as AstralBrowser } from "@astral/astral";
import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import {
  BOOT_FAILURE_MESSAGE,
  BrowserProcess,
  readToEnd,
  stopBrowserProcess,
} from "../browser-process.ts";

// What the tests below made, and what it takes to put each of it away. A test
// that fails partway through returns through `afterEach` rather than through
// its own last lines, so registering here is what keeps a directory, a
// listening socket, or a process from outliving a failure.
const madeByTest: (() => Promise<void>)[] = [];

// A shell that starts `cat` in the background, announces it, and exits. `cat`
// retains stderr until it is killed or its stdin reaches EOF. The redirection
// through file descriptor 3 is what gets that pipe to `cat`: a background
// job's standard input is /dev/null unless it is redirected explicitly.
const HOLDS_STANDARD_ERROR = "exec 3<&0; cat <&3 >/dev/null & echo started";

// Spawns a command in its own process group with stderr piped, and registers
// group termination and the closing of its standard input.
function spawn(
  binary: string,
  args: string[],
  streams: { stdin?: "piped" | "null"; stdout?: "piped" | "null" } = {},
): Deno.ChildProcess {
  const stdin = streams.stdin ?? "null";
  const child = new Deno.Command(binary, {
    args,
    detached: true,
    stdin,
    stdout: streams.stdout ?? "null",
    stderr: "piped",
  }).spawn();
  madeByTest.push(async () => {
    try {
      Deno.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone, which is where most of these tests leave it.
    }
    if (stdin === "piped") {
      await child.stdin.close().catch(() => {});
    }
    await child.status;
  });
  return child;
}

function shell(
  script: string,
  streams: { stdin?: "piped" | "null"; stdout?: "piped" | "null" } = {},
): Deno.ChildProcess {
  return spawn("sh", ["-c", script], streams);
}

// More than a pipe holds, so a stand-in that writes this much to its standard
// output blocks there unless the launch is reading it.
const OVERFLOWS_A_PIPE =
  "awk 'BEGIN { for (i = 0; i < 4000; i++) print \"................\" }'";

// Launch options naming a stand-in for a browser binary: a shell script that
// runs `first`, writes `printed` to its standard error, and exits with `code`,
// never naming an endpoint. The directory holding it is registered for
// removal.
async function fakeBrowser(
  printed: string,
  code: number,
  first = "true",
): Promise<{ path: string; args: string[] }> {
  const directory = await Deno.makeTempDir({
    prefix: "integration-fake-browser-",
  });
  madeByTest.push(() => Deno.remove(directory, { recursive: true }));
  const path = `${directory}/browser`;
  await Deno.writeTextFile(
    path,
    `#!/bin/sh\n${first}\nprintf '%s\\n' '${printed}' >&2\nexit ${code}\n`,
  );
  await Deno.chmod(path, 0o755);
  return { path, args: [`--user-data-dir=${directory}/profile`] };
}

// Sets `ASTRAL_BIN_PATH` to `value` for the rest of the test, and registers
// putting back what was there.
function astralBinaryPathIs(value: string): void {
  const had = Deno.env.get("ASTRAL_BIN_PATH");
  madeByTest.push(() => {
    if (had === undefined) {
      Deno.env.delete("ASTRAL_BIN_PATH");
    } else {
      Deno.env.set("ASTRAL_BIN_PATH", had);
    }
    return Promise.resolve();
  });
  Deno.env.set("ASTRAL_BIN_PATH", value);
}

// The port of a developer-tools endpoint that answers `/json/version` with
// `protocol` as the version it speaks. Astral reads that answer before it
// opens a websocket, so a version it does not speak is a connection that fails
// on the answer rather than one that waits for a socket that never opens.
function fakeEndpoint(protocol: string): number {
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    () =>
      Response.json({
        "Protocol-Version": protocol,
        webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/none",
      }),
  );
  madeByTest.push(() => server.shutdown());
  return (server.addr as Deno.NetAddr).port;
}

describe("browser-process", () => {
  afterEach(async () => {
    const made = madeByTest.splice(0).reverse();
    for (const putAway of made) {
      await putAway();
    }
  });

  describe("stopBrowserProcess()", () => {
    it("ends a running process with `SIGKILL`", async () => {
      const child = shell("read line", { stdin: "piped" });

      await stopBrowserProcess(child, readToEnd(child.stderr));

      expect((await child.status).signal).toBe("SIGKILL");
    });

    it("ends a suspended process without resuming its event loop", async () => {
      const child = shell("read line", { stdin: "piped" });
      child.kill("SIGSTOP");

      try {
        await stopBrowserProcess(child, readToEnd(child.stderr));

        expect((await child.status).signal).toBe("SIGKILL");
      } finally {
        try {
          child.kill("SIGKILL");
        } catch {
          // A completed stop has already reaped this process.
        }
        await child.status;
      }
    });

    it("reaps the browser before reporting an output reader failure", async () => {
      const child = shell("read line", { stdin: "piped" });
      const readFailure = new Error("Could not read browser output");
      let exited = false;
      const status = child.status.then((status) => {
        exited = true;
        return status;
      });

      try {
        await expect(stopBrowserProcess({
          pid: child.pid,
          status,
        }, Promise.reject(readFailure))).rejects.toBe(readFailure);

        expect(exited).toBe(true);
      } finally {
        await status;
        await readToEnd(child.stderr);
      }
    });

    it("returns for a process that has already exited, leaving its exit status intact", async () => {
      const child = shell("exit 0");
      const closed = readToEnd(child.stderr);
      await child.status;

      await stopBrowserProcess(child, closed);

      expect((await child.status).code).toBe(0);
    });

    it("rethrows a kill failure that is not the process having gone", async () => {
      const child = shell("read line", { stdin: "piped" });
      const refused = new Error("Operation not permitted (os error 1)");
      using _kill = stub(Deno, "kill", () => {
        throw refused;
      });
      await expect(stopBrowserProcess(child, Promise.resolve())).rejects
        .toThrow("Operation not permitted");
    });

    it("stops descendants in the owned group after the root has exited", async () => {
      const child = shell(HOLDS_STANDARD_ERROR, {
        stdin: "piped",
        stdout: "piped",
      });
      const stdout = child.stdout.getReader();
      madeByTest.push(() => stdout.cancel());
      expect(new TextDecoder().decode((await stdout.read()).value)).toBe(
        "started\n",
      );
      expect((await child.status).code).toBe(0);

      await stopBrowserProcess(child, readToEnd(child.stderr));

      expect((await stdout.read()).done).toBe(true);
      expect((await child.status).code).toBe(0);
    });

    it("waits for inherited output held outside the owned process group", async () => {
      // This helper has no imports or workspace dependencies. Its separate
      // group models Crashpad's detached launch, and stdin EOF releases it.
      const child = spawn(Deno.execPath(), [
        "eval",
        "--no-config",
        "--no-lock",
        `const child = new Deno.Command(Deno.execPath(), {
          args: ["eval", "--no-config", "--no-lock",
            "await Deno.stdin.readable.pipeTo(new WritableStream());"],
          detached: true,
          stdin: "inherit",
          stdout: "null",
          stderr: "inherit",
        }).spawn();
        console.log(child.pid);
        await child.status;`,
      ], { stdin: "piped", stdout: "piped" });
      const closed = readToEnd(child.stderr);

      const stdout = child.stdout.getReader();
      madeByTest.push(() => stdout.cancel());
      const started = await stdout.read();
      const helperPid = Number(new TextDecoder().decode(started.value).trim());
      expect(Number.isSafeInteger(helperPid) && helperPid > 0).toBe(true);
      madeByTest.push(() => {
        try {
          Deno.kill(helperPid, "SIGKILL");
        } catch {
          // EOF has already released the detached helper on success.
        }
        return Promise.resolve();
      });

      // Each event reaches the list from the event loop, so a
      // stop that returned on the root's exit alone would record itself
      // between the other two rather than after them.
      const events: string[] = [];
      const stopping = stopBrowserProcess(child, closed).then(() => {
        events.push("stopped");
      });
      await child.status;
      events.push("root exited");
      expect((await stdout.read()).done).toBe(true);
      events.push("stdout ended");
      expect(events).toEqual(["root exited", "stdout ended"]);
      await child.stdin.close();
      events.push("released");
      await stopping;

      expect(events).toEqual([
        "root exited",
        "stdout ended",
        "released",
        "stopped",
      ]);
    });
  });

  describe("BrowserProcess", () => {
    describe("instance members", () => {
      describe("close()", () => {
        it("returns for a browser that no longer answers", async () => {
          const child = shell("read line", { stdin: "piped" });
          // A browser whose connection has gone takes every answer with it,
          // so nothing it is asked settles. The cast is what lets a stub of
          // the two members stand in for astral's whole `Browser`.
          let disconnected = false;
          const browser = {
            close: () => new Promise<void>(() => {}),
            disconnect: () => {
              disconnected = true;
              return Promise.resolve();
            },
          } as unknown as AstralBrowser;

          await new BrowserProcess(child, readToEnd(child.stderr), browser)
            .close();

          expect(disconnected).toBe(true);
          expect((await child.status).signal).toBe("SIGKILL");
        });
      });
    });

    describe("static members", () => {
      describe("start()", () => {
        it("rejects an unsupported platform before launching a browser", async () => {
          const build = Deno.build;
          Object.defineProperty(Deno, "build", {
            value: { ...build, os: "windows" },
          });
          try {
            await expect(BrowserProcess.start({ path: "unused-browser" }))
              .rejects.toThrow("Browser tests require macOS or Linux");
          } finally {
            Object.defineProperty(Deno, "build", { value: build });
          }
        });

        it("gives each browser its own process group", async () => {
          const options = await fakeBrowser(
            "no endpoint",
            1,
            'printf \'%s\\n\' "$$" > "$0.pid"; ps -p "$$" -o pgid= > "$0.group"',
          );

          await expect(BrowserProcess.start(options)).rejects.toThrow(
            BOOT_FAILURE_MESSAGE,
          );

          const pid = Number(await Deno.readTextFile(`${options.path}.pid`));
          const group = Number(
            await Deno.readTextFile(`${options.path}.group`),
          );
          expect(pid).toBeGreaterThan(0);
          expect(group).toBe(pid);
        });

        it("keeps Chrome launches from scheduling the installed updater", async () => {
          const options = await fakeBrowser(
            "no endpoint",
            1,
            'printf \'%s\\n\' "$@" > "$0.args"',
          );

          await expect(BrowserProcess.start(options)).rejects.toThrow(
            BOOT_FAILURE_MESSAGE,
          );

          const args = (await Deno.readTextFile(`${options.path}.args`))
            .trim().split("\n");
          expect(args).toContain("--disable-updater-scheduler");
          expect(args).toContain(options.args[0]);
        });

        it("leaves Firefox launches free of Chrome updater switches", async () => {
          const options = await fakeBrowser(
            "no endpoint",
            1,
            'printf \'%s\\n\' "$@" > "$0.args"',
          );

          await expect(BrowserProcess.start({ ...options, product: "firefox" }))
            .rejects.toThrow(BOOT_FAILURE_MESSAGE);

          const args = (await Deno.readTextFile(`${options.path}.args`))
            .trim().split("\n");
          expect(args).not.toContain("--disable-updater-scheduler");
        });

        it("throws when the browser exits without naming an endpoint", async () => {
          const options = await fakeBrowser("no endpoint", 1);

          await expect(BrowserProcess.start(options)).rejects.toThrow(
            BOOT_FAILURE_MESSAGE,
          );
        });

        it("names the missing dependencies a browser reports", async () => {
          const options = await fakeBrowser(
            "error while loading shared libraries: libnss3.so",
            127,
          );

          await expect(BrowserProcess.start(options)).rejects.toThrow(
            "missing system dependencies",
          );
        });

        it("stops a browser that starts and then cannot be connected to", async () => {
          const port = fakeEndpoint("0.0");
          const options = await fakeBrowser(
            `DevTools listening on ws://127.0.0.1:${port}/devtools/browser/x`,
            0,
          );

          await expect(BrowserProcess.start(options)).rejects.toThrow(
            "Differing protocol versions",
          );
        });

        it("reads a browser that writes more to its standard output than a pipe holds", async () => {
          const options = await fakeBrowser("no endpoint", 1, OVERFLOWS_A_PIPE);

          // A launch that left standard output unread would stop here, with
          // the stand-in blocked on a pipe nobody is emptying.
          await expect(BrowserProcess.start(options)).rejects.toThrow(
            BOOT_FAILURE_MESSAGE,
          );
        });

        it("takes the browser astral resolves when the options name none", async () => {
          const options = await fakeBrowser("no endpoint", 1);
          astralBinaryPathIs(options.path);

          await expect(BrowserProcess.start({ args: options.args })).rejects
            .toThrow(BOOT_FAILURE_MESSAGE);
        });

        it("throws when the launch names no `--user-data-dir`", async () => {
          const options = await fakeBrowser("no endpoint", 1);

          await expect(BrowserProcess.start({ ...options, args: [] })).rejects
            .toThrow("--user-data-dir");
        });
      });
    });
  });
});
