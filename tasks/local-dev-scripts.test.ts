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

/** The ports a run of a script with stand-in servers gives its servers. */
interface FakeServerPorts {
  shell: number;
  toolshed: number;
  console: number;
  inspector: number;
}

/**
 * The command lines that start servers with one of the local dev scripts and
 * stop them again, and what they add to the environment of the stand-ins.
 */
interface ServerCommands {
  start: string[];
  stop: string[];
  env?: Record<string, string>;
}

function startLocalDevCommands(ports: FakeServerPorts): ServerCommands {
  const portArgs = [
    "--shell-port",
    String(ports.shell),
    "--toolshed-port",
    String(ports.toolshed),
  ];
  return {
    start: ["scripts/start-local-dev.sh", ...portArgs],
    stop: ["scripts/stop-local-dev.sh", "--cf-harness", ...portArgs],
  };
}

/**
 * The pattern a run of `share-pattern-via-tailscale.sh` shares. The stand-in
 * `cf` deploys it without reading it.
 */
const SHARED_PATTERN = "patterns/shared/main.tsx";

function shareCommands(ports: FakeServerPorts): ServerCommands {
  return {
    start: [
      "scripts/share-pattern-via-tailscale.sh",
      SHARED_PATTERN,
      "--toolshed-port",
      String(ports.toolshed),
      "--shell-port",
      String(ports.shell),
      "--inspect-port",
      String(ports.inspector),
    ],
    stop: ["scripts/share-pattern-via-tailscale.sh", "--down"],
    // The script stops each server's process group, which holds whatever
    // the server started.
    env: { FAKE_DEV_SERVER_CHILD: "1" },
  };
}

/**
 * Run one of the local dev scripts with a `deno` that starts the stand-in
 * servers in `fixtures/fake-dev-server.ts` on ports of their own, and a
 * `tailscale` that reports a name on the tailnet, appends each command line
 * it is given to the file `tailscaleCalls` names, and fails `tailscale serve`
 * when `FAKE_TAILSCALE_SERVE_FAILS` is set. `commands` gives the command
 * lines, `start-local-dev.sh` and `stop-local-dev.sh` unless named. The script
 * runs from a copy of `scripts/` in a temporary tree, which takes its logs and
 * holds the pattern `SHARED_PATTERN` names and a deploy identity, and leads a
 * session and a process group of its own, as it does when a command runner
 * starts it. `holding(count)` settles once `count` servers have started and
 * taken the lock, and fails if the script ends while it waits. `ended()` settles once
 * every server it started has exited, and `stop()` stops them with the stop
 * command line, as disposing of the run does before it removes the tree.
 * `printed` settles once the script has printed `awaitedLine` on its standard
 * output, `drained` with that output once it has ended, and `errors` with its
 * standard error.
 */
async function startWithFakeServers(
  options: {
    commands?: (ports: FakeServerPorts) => ServerCommands;
    args?: string[];
    env?: Record<string, string>;
    awaitedLine?: string;
    ports?: Partial<FakeServerPorts>;
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
  await Deno.mkdir(path.join(dir, path.dirname(SHARED_PATTERN)), {
    recursive: true,
  });
  await Deno.writeTextFile(path.join(dir, SHARED_PATTERN), "");
  await Deno.writeTextFile(path.join(dir, "cf.key"), "");
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
  const tailscaleCalls = path.join(dir, "tailscale-calls");
  await Deno.writeTextFile(
    path.join(binDir, "tailscale"),
    `#!/bin/sh\necho "$*" >> '${tailscaleCalls}'\n` +
      `[ "$1" = status ] && echo '{"Self": {"DNSName": "share.example.ts.net."}}'\n` +
      `[ "$1" = serve ] && [ -n "$FAKE_TAILSCALE_SERVE_FAILS" ] && exit 1\n` +
      `exit 0\n`,
  );
  await Deno.chmod(path.join(binDir, "tailscale"), 0o755);
  const lockFile = path.join(dir, "servers.lock");
  await Deno.writeTextFile(lockFile, "");
  // Where the stand-in servers give notice that they hold the lock, and where
  // every stand-in connects so as to end when the test does.
  const notices = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const lifelines = Deno.listen({ hostname: "127.0.0.1", port: 0 });

  const [shell, toolshed, consolePort, inspector] = freePorts(4);
  const ports = {
    shell,
    toolshed,
    console: consolePort,
    inspector,
    ...options.ports,
  };
  const commands = (options.commands ?? startLocalDevCommands)(ports);
  const env = {
    ...inheritedEnv(["HOME", "DENO_DIR"]),
    ...commands.env,
    ...options.env,
    CF_HARNESS_CONSOLE_PORT: String(ports.console),
    FAKE_DEV_SERVER_LOCK: lockFile,
    FAKE_DEV_SERVER_NOTICE_PORT: String(notices.addr.port),
    FAKE_DEV_SERVER_LIFELINE_PORT: String(lifelines.addr.port),
    PATH: `${binDir}:${Deno.env.get("PATH")}`,
  };
  const child = new Deno.Command("bash", {
    args: [...commands.start, ...(options.args ?? [])],
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
    dir,
    ports,
    tailscaleCalls,
    printed: printed.promise,
    drained,
    errors,
    async holding(count: number) {
      const exited = child.status.then(() => false);
      for (let i = 0; i < count; i++) {
        const notice = notices.accept().then((conn) => {
          conn.close();
          return true;
        }, () => false);
        if (!await Promise.race([notice, exited])) {
          throw new Error(`the script ended before ${count} servers started`);
        }
      }
    },
    async ended() {
      using file = await Deno.open(lockFile);
      await file.lock(true);
    },
    /** Run the start command line again in the tree, to its end. */
    again() {
      return new Deno.Command("bash", {
        args: commands.start,
        cwd: dir,
        env,
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      }).output();
    },
    /** `stopEnv` is added to the environment of the stop command line. */
    async stop(stopEnv: Record<string, string> = {}) {
      await new Deno.Command("bash", {
        args: commands.stop,
        cwd: dir,
        env: { ...env, ...stopEnv },
        clearEnv: true,
      }).output();
    },
    async [Symbol.asyncDispose]() {
      await this.stop();
      await Promise.all([drained, errors]);
      notices.close();
      lifelines.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

/**
 * Start a process in a group of its own, standing in for an unrelated process
 * given a recorded server's pid after the server exited. `record` is a line
 * for a share's record that names its pid with a start time it does not have.
 * `expectUntouched()` closes its standard input, which ends it with 0, and
 * checks that no signal ended it first.
 */
function startBystander() {
  const cat = new Deno.Command("cat", {
    stdin: "piped",
    stdout: "null",
    detached: true,
  }).spawn();
  return {
    record: `${cat.pid} Thu Jan 1 00:00:00 1970\n`,
    async expectUntouched() {
      await cat.stdin.close();
      expect((await cat.status).code).toBe(0);
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
      const { shell, toolshed, console: consolePort } = run.ports;
      for (const port of [shell, toolshed, consolePort]) {
        expect(await answers(port)).toBe(true);
      }

      await run.stop();
      await run.ended();
    });

    it("ends its servers and exits 3 when a server's port is already in use", async () => {
      const occupant = Deno.listen({ port: 0 });
      await using run = await startWithFakeServers({
        ports: { toolshed: occupant.addr.port },
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
      });
      await run.holding(2);
      Deno.kill(-run.child.pid, "SIGINT");
      expect((await run.child.status).signal).toBe("SIGINT");
      await run.ended();
    });

    for (const signal of ["SIGHUP", "SIGTERM"] as const) {
      it(`ends its servers when it alone is sent ${signal} before they are ready`, async () => {
        await using run = await startWithFakeServers({
          env: { FAKE_DEV_SERVER_SILENT: "toolshed" },
        });
        await run.holding(2);
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

  describe("share-pattern-via-tailscale.sh", () => {
    it("leaves its servers serving after its process group ends, until --down stops them", async () => {
      // A command runner that ends what a command leaves in its process
      // group, once the command returns, ends the group this way.

      await using run = await startWithFakeServers({ commands: shareCommands });
      expect((await run.child.status).code).toBe(0);
      expect(await run.drained).toContain(
        "https://share.example.ts.net/shared-demo/fid1:stand-in-piece",
      );
      expect(() => Deno.kill(-run.child.pid, "SIGKILL")).toThrow(
        Deno.errors.NotFound,
      );
      expect(await answers(run.ports.shell)).toBe(true);
      expect(await answers(run.ports.toolshed)).toBe(true);
      expect(await Deno.readTextFile(run.tailscaleCalls)).toContain(
        `serve --bg ${run.ports.toolshed}`,
      );

      await run.stop();
      await run.ended();
      expect(await Deno.readTextFile(run.tailscaleCalls)).toContain(
        "serve --https=443 off",
      );
    });

    it("stops its servers with --down run in another time zone", async () => {
      await using run = await startWithFakeServers({
        commands: shareCommands,
        env: { TZ: "XYZ+5" },
      });
      expect((await run.child.status).code).toBe(0);

      await run.stop({ TZ: "XYZ-9" });
      await run.ended();
    });

    it("ends its servers when Ctrl-C interrupts it before they are ready", async () => {
      // Ctrl-C sends SIGINT to the terminal's foreground process group,
      // which holds the script and not the servers.

      await using run = await startWithFakeServers({
        commands: shareCommands,
        env: { FAKE_DEV_SERVER_SILENT: "toolshed" },
      });
      await run.holding(2);
      Deno.kill(-run.child.pid, "SIGINT");
      expect((await run.child.status).signal).toBe("SIGINT");
      await run.ended();
    });

    for (const signal of ["SIGHUP", "SIGTERM"] as const) {
      it(`ends its servers when it alone is sent ${signal} before they are ready`, async () => {
        await using run = await startWithFakeServers({
          commands: shareCommands,
          env: { FAKE_DEV_SERVER_SILENT: "shell" },
        });
        await run.holding(2);
        Deno.kill(run.child.pid, signal);
        expect((await run.child.status).signal).toBe(signal);
        await run.ended();
      });
    }

    it("ends its servers and exits 1 when tailscale serve fails", async () => {
      await using run = await startWithFakeServers({
        commands: shareCommands,
        env: { FAKE_TAILSCALE_SERVE_FAILS: "1" },
      });
      expect((await run.child.status).code).toBe(1);
      expect(await run.errors).toContain("tailscale serve failed");
      expect(await run.drained).not.toContain("Shareable URL");
      await run.ended();
    });

    it("exits 1 and leaves the running share to --down when run again", async () => {
      await using run = await startWithFakeServers({ commands: shareCommands });
      expect((await run.child.status).code).toBe(0);

      const second = await run.again();
      expect(second.code).toBe(1);
      expect(new TextDecoder().decode(second.stderr)).toContain(
        "stop it with --down first",
      );
      expect(await answers(run.ports.toolshed)).toBe(true);

      await run.stop();
      await run.ended();
    });

    for (const server of ["toolshed", "shell", "inspector"] as const) {
      it(`exits 1 without starting a server when its ${server} port is in use`, async () => {
        // The occupant answers as a server would, so that a script that went
        // ahead would report success rather than wait on it.

        await using occupant = Deno.serve(
          { port: 0, onListen() {} },
          () => new Response("ok"),
        );
        await using run = await startWithFakeServers({
          commands: shareCommands,
          ports: { [server]: occupant.addr.port },
        });
        expect((await run.child.status).code).toBe(1);
        expect(await run.errors).toContain(
          `port ${occupant.addr.port} is already in use`,
        );
        expect(await run.drained).not.toContain("Starting toolshed");
      });
    }

    it("leaves the tailnet mapping alone at --down when it is not sharing", async () => {
      await using run = await startWithFakeServers({ commands: shareCommands });
      expect((await run.child.status).code).toBe(0);
      await run.stop();
      await run.ended();

      await run.stop();
      const offs = (await Deno.readTextFile(run.tailscaleCalls)).split("\n")
        .filter((line) => line === "serve --https=443 off");
      expect(offs).toHaveLength(1);
    });

    it("starts again when the servers it recorded have exited without --down", async () => {
      // A reboot, or servers that crash, leave the record of a share behind.

      await using run = await startWithFakeServers({ commands: shareCommands });
      expect((await run.child.status).code).toBe(0);
      const record = path.join(run.dir, "tmp/share-pattern-via-tailscale/pids");
      const bystander = startBystander();
      const stale = await Deno.readTextFile(record) + bystander.record;
      await run.stop();
      await run.ended();
      await Deno.writeTextFile(record, stale);

      const second = await run.again();
      expect(second.code).toBe(0);
      expect(await answers(run.ports.toolshed)).toBe(true);
      expect(await Deno.readTextFile(record)).not.toBe(stale);

      await run.stop();
      await run.ended();
      await bystander.expectUntouched();
    });

    it("leaves alone a recorded pid whose process has since been replaced", async () => {
      await using run = await startWithFakeServers({ commands: shareCommands });
      expect((await run.child.status).code).toBe(0);
      const bystander = startBystander();
      await Deno.writeTextFile(
        path.join(run.dir, "tmp/share-pattern-via-tailscale/pids"),
        bystander.record,
        { append: true },
      );

      await run.stop();
      await run.ended();
      await bystander.expectUntouched();
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
