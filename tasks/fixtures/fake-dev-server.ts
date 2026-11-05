/**
 * A stand-in for the servers `scripts/start-local-dev.sh` and
 * `scripts/share-pattern-via-tailscale.sh` launch, for tests of the scripts
 * themselves. A `deno` on `PATH` that runs this module with its own arguments
 * makes each launch start one of these in place of the real server.
 * It answers every request on the port the real server would take, prints the
 * line the script waits for, and exits with the real servers' code 3 when that
 * port is already in use.
 *
 * While it runs, it holds a shared lock on the file `FAKE_DEV_SERVER_LOCK`
 * names, so a test taking an exclusive lock on that file gets it once every
 * server has exited. Once it holds the lock, and before it serves, it connects
 * to the port `FAKE_DEV_SERVER_NOTICE_PORT` names on 127.0.0.1 and closes the
 * connection, so a test that accepts a connection there for each server knows
 * every server holds the lock. A server that answers a request therefore
 * holds the lock, and has started its child process if it starts one.
 * `FAKE_DEV_SERVER_SILENT` names one server (`shell`, `toolshed`, or
 * `console`) that serves without printing its line, so that the script waits
 * on it until something stops the script. That server also answers 503, so
 * that a script waiting for HTTP 200 waits too.
 *
 * With `FAKE_DEV_SERVER_CHILD` set, each server starts a process of its own
 * before it gives notice, as the shell dev server starts esbuild. That process
 * holds the lock too, and keeps running after the server that started it
 * exits.
 *
 * Every server stand-in, and every process one starts, connects to the port
 * `FAKE_DEV_SERVER_LIFELINE_PORT` names on 127.0.0.1, where the test listens
 * and accepts nothing, and exits once that connection breaks, which happens
 * when the test closes the port or ends.
 *
 * It also stands in for the `cf` CLI that `share-pattern-via-tailscale.sh`
 * runs. `cf piece new` prints the id of a piece, and every other `cf` command
 * fails. A `deno` command that is none of these throws.
 */

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
}

function portArgument(args: string[]): number {
  const index = args.findIndex((arg) => arg.startsWith("--port"));
  if (index < 0) throw new Error(`no --port in ${args.join(" ")}`);
  const value = args[index].startsWith("--port=")
    ? args[index].slice("--port=".length)
    : args[index + 1];
  return Number(value);
}

const PORT_IN_USE_EXIT = 3;

// The argument that runs this module as the process a server starts.
const CHILD_ARGUMENT = "--fake-dev-server-child";

const args = Deno.args;
function commandName(): "child" | "shell" | "console" | "toolshed" | "cf" {
  if (args[0] === CHILD_ARGUMENT) return "child";
  if (
    (args[0] === "task" && args[1] === "cf") ||
    args.includes("runtime/cli/mod.ts")
  ) return "cf";
  if (
    args.includes("dev-local") ||
    args.some((arg) => arg.endsWith("felt/cli.ts"))
  ) return "shell";
  if (args.includes("console:launch")) return "console";
  if (args.includes("index.ts")) return "toolshed";
  throw new Error(`no stand-in for deno ${args.join(" ")}`);
}

const name = commandName();
if (name === "cf") {
  if (args.includes("piece") && args.includes("new")) {
    console.log("Created piece fid1:stand-in-piece");
    Deno.exit(0);
  }
  Deno.exit(1);
}

// Never unlocked: the lock is released when this process exits.
const lock = await Deno.open(requiredEnv("FAKE_DEV_SERVER_LOCK"));
await lock.lock(false);

const lifeline = await Deno.connect({
  hostname: "127.0.0.1",
  port: Number(requiredEnv("FAKE_DEV_SERVER_LIFELINE_PORT")),
});
// Nothing is ever sent on the lifeline, so this settles once it breaks.
const lifelineBroken = lifeline.read(new Uint8Array(1)).catch(() => null);

if (name === "child") {
  console.log("locked");
  await lifelineBroken;
  Deno.exit(1);
}
lifelineBroken.then(() => Deno.exit(1));

/** Start the process a server starts, once it holds the lock. */
async function startChild(): Promise<void> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-config",
      "--no-lock",
      "-A",
      Deno.mainModule,
      CHILD_ARGUMENT,
    ],
    stdin: "null",
    stdout: "piped",
  }).spawn();
  const reader = child.stdout.pipeThrough(new TextDecoderStream())
    .getReader();
  const { value } = await reader.read();
  if (value !== "locked\n") {
    throw new Error(`the child process did not take the lock: ${value}`);
  }
}

const port = name === "shell"
  ? Number(requiredEnv("SHELL_PORT"))
  : portArgument(args);
const readyLine = {
  shell: "Dev server listening on",
  toolshed: "Server running on",
  console: "Console listening on",
}[name];

if (Deno.env.get("FAKE_DEV_SERVER_CHILD")) await startChild();
const notice = await Deno.connect({
  hostname: "127.0.0.1",
  port: Number(requiredEnv("FAKE_DEV_SERVER_NOTICE_PORT")),
});
notice.close();

const silent = Deno.env.get("FAKE_DEV_SERVER_SILENT") === name;
try {
  Deno.serve({
    port,
    onListen() {
      if (!silent) console.log(`${readyLine} port ${port}`);
    },
  }, () => new Response("ok", { status: silent ? 503 : 200 }));
} catch (error) {
  if (error instanceof Deno.errors.AddrInUse) Deno.exit(PORT_IN_USE_EXIT);
  throw error;
}
