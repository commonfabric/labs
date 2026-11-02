import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { copy } from "@std/fs";
import * as path from "@std/path";

import ports from "@commonfabric/ports" with { type: "json" };

const repoRoot = path.resolve(import.meta.dirname!, "..");

// `scripts/start-local-dev.sh` reports this when a port it was asked for is one
// clients refuse to connect to.
const PORT_UNREACHABLE_EXIT = 4;

// `scripts/start-local-dev.sh` exits with this when a server's port is already
// in use.
const PORT_IN_USE_EXIT = 3;

// The offset that puts the shell dev server on port 6000.
const UNREACHABLE_SHELL_OFFSET = 6000 - ports.shell;

// The offset that puts the inspector on port 10080, leaving the shell and the
// toolshed on ports every client will talk to.
const UNREACHABLE_INSPECTOR_OFFSET = 10080 - ports.inspector;

// An offset whose servers every client will talk to.
const REACHABLE_OFFSET = 850;

/**
 * Run one of the local dev scripts with a `deno` that exits immediately, so a
 * run that gets as far as launching a server starts nothing and leaves nothing
 * behind.
 */
async function runScript(
  script: string,
  offset: number,
  options: { args?: string[]; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const binDir = await Deno.makeTempDir();
  const stub = path.join(binDir, "deno");
  await Deno.writeTextFile(stub, "#!/bin/sh\nexit 1\n");
  await Deno.chmod(stub, 0o755);
  try {
    const { code, stdout, stderr } = await new Deno.Command("bash", {
      args: [
        `scripts/${script}`,
        ...(options.args ?? []),
        "--port-offset",
        String(offset),
      ],
      cwd: repoRoot,
      env: { ...options.env, PATH: `${binDir}:${Deno.env.get("PATH")}` },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const decoder = new TextDecoder();
    return {
      code,
      stdout: decoder.decode(stdout),
      stderr: decoder.decode(stderr),
    };
  } finally {
    await Deno.remove(binDir, { recursive: true });
  }
}

/** Distinct ports nothing listens on at the time of the call. */
function freePorts(count: number): number[] {
  const listeners = Array.from(
    { length: count },
    () => Deno.listen({ port: 0 }),
  );
  const chosen = listeners.map((listener) => listener.addr.port);
  for (const listener of listeners) listener.close();
  return chosen;
}

/** The variables of this process's environment that `names` lists. */
function inheritedEnv(names: string[]): Record<string, string> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = Deno.env.get(name);
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

/**
 * Run `start-local-dev.sh` with a `deno` that starts the stand-in servers in
 * `fixtures/fake-dev-server.ts` on ports of their own. The script runs from a
 * copy of `scripts/` in a temporary tree, which takes its logs, and leads a
 * session and a process group of its own, as it does when a command runner
 * starts it. `ended()` settles once every server it started has exited, and
 * `stop()` stops them with `stop-local-dev.sh`, as disposing of the run does
 * before it removes the tree.
 * `printed` settles once the script has printed `awaitedLine` on its standard
 * output, `drained` with that output once it has ended, and `errors` with its
 * standard error.
 */
async function startWithFakeServers(
  options: {
    args?: string[];
    env?: Record<string, string>;
    awaitedLine?: string;
    toolshedPort?: number;
  } = {},
) {
  const dir = await Deno.makeTempDir();
  await copy(path.join(repoRoot, "scripts"), path.join(dir, "scripts"));
  await Deno.copyFile(
    path.join(repoRoot, "ports.json"),
    path.join(dir, "ports.json"),
  );
  for (const server of ["shell", "toolshed", "cf-harness"]) {
    await Deno.mkdir(path.join(dir, "runtime", server), { recursive: true });
  }
  const binDir = path.join(dir, "bin");
  await Deno.mkdir(binDir);
  const fixture = path.join(
    import.meta.dirname!,
    "fixtures/fake-dev-server.ts",
  );
  await Deno.writeTextFile(
    path.join(binDir, "deno"),
    `#!/bin/sh\nexec '${Deno.execPath()}' run --no-config --no-lock -A ` +
      `'${fixture}' "$@"\n`,
  );
  await Deno.chmod(path.join(binDir, "deno"), 0o755);
  const lockFile = path.join(dir, "servers.lock");
  await Deno.writeTextFile(lockFile, "");

  const [shell, toolshed, consolePort] = freePorts(3);
  const ports = {
    shell,
    toolshed: options.toolshedPort ?? toolshed,
    console: consolePort,
  };
  const env = {
    ...inheritedEnv(["HOME", "DENO_DIR"]),
    ...options.env,
    CF_HARNESS_CONSOLE_PORT: String(ports.console),
    FAKE_DEV_SERVER_LOCK: lockFile,
    PATH: `${binDir}:${Deno.env.get("PATH")}`,
  };
  const portArgs = [
    "--shell-port",
    String(ports.shell),
    "--toolshed-port",
    String(ports.toolshed),
  ];
  const child = new Deno.Command("bash", {
    args: ["scripts/start-local-dev.sh", ...portArgs, ...(options.args ?? [])],
    cwd: dir,
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
    detached: true,
  }).spawn();
  const errors = new Response(child.stderr).text();

  const printed = Promise.withResolvers<void>();
  const drained = (async () => {
    let output = "";
    for await (
      const chunk of child.stdout.pipeThrough(new TextDecoderStream())
    ) {
      output += chunk;
      if (options.awaitedLine && output.includes(options.awaitedLine)) {
        printed.resolve();
      }
    }
    if (options.awaitedLine) {
      printed.reject(
        new Error(`the script ended without printing "${options.awaitedLine}"`),
      );
    }
    return output;
  })();

  return {
    child,
    ports,
    printed: printed.promise,
    drained,
    errors,
    async ended() {
      using file = await Deno.open(lockFile);
      await file.lock(true);
    },
    async stop() {
      await new Deno.Command("bash", {
        args: ["scripts/stop-local-dev.sh", "--cf-harness", ...portArgs],
        cwd: dir,
        env,
        clearEnv: true,
      }).output();
    },
    async [Symbol.asyncDispose]() {
      await this.stop();
      await Promise.all([drained, errors]);
      await Deno.remove(dir, { recursive: true });
    },
  };
}

/** Whether the server on `port` answers. */
async function answers(port: number): Promise<boolean> {
  const response = await fetch(`http://127.0.0.1:${port}/`);
  await response.body?.cancel();
  return response.ok;
}

/**
 * The console-launch arguments `start-local-dev.sh` builds for one fabric,
 * with `env` over the fixed values the rest of the launch needs.
 */
async function consoleLaunchArgs(
  env: Record<string, string>,
): Promise<string[]> {
  const { stdout } = await new Deno.Command("bash", {
    args: ["-c", "source scripts/common/console-args.sh\nconsole_launch_args"],
    cwd: repoRoot,
    env: {
      CONSOLE_PORT: "8135",
      TOOLSHED_API_URL: "http://localhost:8000",
      CONSOLE_STORE: "/store",
      ...env,
      PATH: Deno.env.get("PATH") ?? "",
    },
    clearEnv: true,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  return new TextDecoder().decode(stdout).trim().split("\n").filter((line) =>
    line !== ""
  );
}

/**
 * Run a bash snippet with the local dev scripts' shared port utilities
 * sourced, and return what it printed.
 */
async function runWithPortUtils(script: string): Promise<string> {
  const { stdout } = await new Deno.Command("bash", {
    args: ["-c", `source scripts/common/port-utils.sh\n${script}`],
    cwd: repoRoot,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  return new TextDecoder().decode(stdout).trim();
}

describe("local-dev-scripts", () => {
  describe("start-local-dev.sh", () => {
    it("names the server and the port an offset makes unreachable", async () => {
      const { code, stderr } = await runScript(
        "start-local-dev.sh",
        UNREACHABLE_SHELL_OFFSET,
      );
      expect(code).toBe(PORT_UNREACHABLE_EXIT);
      expect(stderr).toContain("shell port 6000");
    });

    it("reaches the server launch on a reachable offset", async () => {
      const { code, stderr } = await runScript(
        "start-local-dev.sh",
        REACHABLE_OFFSET,
      );
      expect(code).not.toBe(PORT_UNREACHABLE_EXIT);
      expect(stderr).toContain("shell exited before it became ready");
    });

    it("forwards `--allow-skill-scripts` to the console launch when named", async () => {
      // The launch site sits behind the toolshed and shell coming up, so a
      // test driving the whole script never reaches it. The arguments it
      // builds are asserted directly instead, which is what a deleted
      // forwarding line would otherwise slip past.
      const named = await consoleLaunchArgs({
        CF_HARNESS_ALLOW_SKILL_SCRIPTS_FLAG: "true",
      });
      expect(named).toContain("--allow-skill-scripts");

      const unnamed = await consoleLaunchArgs({});
      expect(unnamed).not.toContain("--allow-skill-scripts");
      // The rest of the launch is unchanged either way.
      expect(unnamed).toEqual([
        "--port",
        "8135",
        "--fabric-api-url",
        "http://localhost:8000",
        "--store",
        "/store",
      ]);
    });

    it("forwards `--allow-browser-host` to the console server when named", async () => {
      const named = await consoleLaunchArgs({
        CF_HARNESS_ALLOW_BROWSER_HOST_FLAG: "true",
        DB_PATH: "/space.sqlite",
      });
      // A server flag, so after the one `--`, beside `--space-db`.
      expect(named.slice(named.indexOf("--"))).toEqual([
        "--",
        "--allow-browser-host",
        "--space-db",
        "/space.sqlite",
      ]);
      expect(named.filter((argument) => argument === "--")).toHaveLength(1);

      const unnamed = await consoleLaunchArgs({ DB_PATH: "/space.sqlite" });
      expect(unnamed).not.toContain("--allow-browser-host");
      expect(unnamed.slice(unnamed.indexOf("--"))).toEqual([
        "--",
        "--space-db",
        "/space.sqlite",
      ]);
    });

    it("parses `--allow-skill-scripts` beside `--cf-harness`", async () => {
      // What this reaches is the argument loop: the flag is recognized rather
      // than falling into its catch-all, and the run still ends at the port
      // check. It does NOT reach the console-launch invocation, so it says
      // nothing about the flag being forwarded — that block sits behind the
      // toolshed and shell coming up, which a stubbed `deno` never does.
      const { code, stderr } = await runScript(
        "start-local-dev.sh",
        UNREACHABLE_SHELL_OFFSET,
        { args: ["--cf-harness", "--allow-skill-scripts"] },
      );

      expect(code).toBe(PORT_UNREACHABLE_EXIT);
      expect(stderr).not.toContain("--allow-skill-scripts");
    });

    it("answers from the recorded list, not from the environment", async () => {
      const { code, stderr } = await runScript(
        "start-local-dev.sh",
        UNREACHABLE_SHELL_OFFSET,
        { env: { BLOCKED_PORTS: "1" } },
      );
      expect(code).toBe(PORT_UNREACHABLE_EXIT);
      expect(stderr).toContain("shell port 6000");
    });

    it("leaves its servers serving after its process group ends, until stop-local-dev.sh stops them", async () => {
      // A command runner that ends what a command leaves in its process
      // group, once the command returns, ends the group this way.

      await using run = await startWithFakeServers({ args: ["--cf-harness"] });
      expect((await run.child.status).code).toBe(0);
      expect(await run.drained).toContain("Console:  http://");
      expect(() => Deno.kill(-run.child.pid, "SIGKILL")).toThrow(
        Deno.errors.NotFound,
      );
      for (const port of Object.values(run.ports)) {
        expect(await answers(port)).toBe(true);
      }

      await run.stop();
      await run.ended();
    });

    it("ends its servers and exits 3 when a server's port is already in use", async () => {
      const occupant = Deno.listen({ port: 0 });
      await using run = await startWithFakeServers({
        toolshedPort: occupant.addr.port,
      });
      // Declared after the run so that it closes first: `stop-local-dev.sh`
      // stops every `deno` listening on the run's ports, and this one is the
      // process running the test.
      using _occupant = occupant;
      expect((await run.child.status).code).toBe(PORT_IN_USE_EXIT);
      expect(await run.errors).toContain(
        "toolshed could not bind its port; it is already in use",
      );
      await run.ended();
    });

    it("ends its servers when Ctrl-C interrupts it before they are ready", async () => {
      // Ctrl-C sends SIGINT to the terminal's foreground process group,
      // which holds the script and not the servers.

      await using run = await startWithFakeServers({
        env: { FAKE_DEV_SERVER_SILENT: "toolshed" },
        awaitedLine: "Waiting for toolshed to bind its port",
      });
      await run.printed;
      Deno.kill(-run.child.pid, "SIGINT");
      expect((await run.child.status).signal).toBe("SIGINT");
      await run.ended();
    });

    for (const signal of ["SIGHUP", "SIGTERM"] as const) {
      it(`ends its servers when it alone is sent ${signal} before they are ready`, async () => {
        await using run = await startWithFakeServers({
          env: { FAKE_DEV_SERVER_SILENT: "toolshed" },
          awaitedLine: "Waiting for toolshed to bind its port",
        });
        await run.printed;
        Deno.kill(run.child.pid, signal);
        expect((await run.child.status).signal).toBe(signal);
        await run.ended();
      });
    }

    it("ends its servers with its process group when it stays attached for Codex", async () => {
      // SIGKILL leaves the script no chance to stop them, so they end only
      // if they share its group.

      await using run = await startWithFakeServers({
        env: { CODEX_SANDBOX: "1" },
        awaitedLine: "Stop this command or run",
      });
      await run.printed;
      Deno.kill(-run.child.pid, "SIGKILL");
      await run.child.status;
      await run.ended();
    });
  });

  describe("restart-local-dev.sh", () => {
    it("refuses an unreachable offset before it stops a server", async () => {
      const { code, stdout, stderr } = await runScript(
        "restart-local-dev.sh",
        UNREACHABLE_SHELL_OFFSET,
      );
      expect(code).toBe(PORT_UNREACHABLE_EXIT);
      expect(stderr).toContain("shell port 6000");
      // The stop, and the cache and space clearing behind its flags, all
      // follow this line.
      expect(stdout).not.toContain("Stopping local dev servers");
    });

    it("refuses an inspector port an --inspect run would bind", async () => {
      const { code, stdout, stderr } = await runScript(
        "restart-local-dev.sh",
        UNREACHABLE_INSPECTOR_OFFSET,
        { args: ["--inspect"] },
      );
      expect(code).toBe(PORT_UNREACHABLE_EXIT);
      expect(stderr).toContain("inspector port 10080");
      expect(stdout).not.toContain("Stopping local dev servers");
    });
  });

  describe("port-utils.sh", () => {
    describe("foreign_port_holder()", () => {
      // Each case listens on a port here, so the pid the utility has to find
      // is one the test already knows: this process.

      it("returns nothing for a port the given pid listens on", async () => {
        const listener = Deno.listen({ port: 0 });
        try {
          expect(
            await runWithPortUtils(
              `foreign_port_holder ${listener.addr.port} ${Deno.pid}`,
            ),
          ).toBe("");
        } finally {
          listener.close();
        }
      });

      it("returns nothing for a port a descendant of the given pid listens on", async () => {
        // `Deno.ppid` is the process that spawned this one, so the
        // listener below is a descendant of it rather than the pid itself.
        const listener = Deno.listen({ port: 0 });
        try {
          expect(
            await runWithPortUtils(
              `foreign_port_holder ${listener.addr.port} ${Deno.ppid}`,
            ),
          ).toBe("");
        } finally {
          listener.close();
        }
      });

      it("returns the listening pid for a port held outside the given pid's tree", async () => {
        // `$$` is the bash the snippet runs in, a child of this process and so
        // an ancestor of nothing that listens here.
        const listener = Deno.listen({ port: 0 });
        try {
          expect(
            await runWithPortUtils(
              `foreign_port_holder ${listener.addr.port} $$`,
            ),
          ).toBe(String(Deno.pid));
        } finally {
          listener.close();
        }
      });
    });
  });
});
