/**
 * A stand-in for the servers `scripts/start-local-dev.sh` launches, for tests
 * of the script itself. A `deno` on `PATH` that runs this module with its own
 * arguments makes each launch start one of these in place of the real server.
 * It answers every request with 200 on the port the real server would take,
 * prints the line the script waits for, and exits with the real servers' code
 * 3 when that port is already in use.
 *
 * While it runs, it holds a shared lock on the file `FAKE_DEV_SERVER_LOCK`
 * names, so a test taking an exclusive lock on that file gets it once every
 * server has exited. `FAKE_DEV_SERVER_SILENT` names one server (`shell`,
 * `toolshed`, or `console`) that serves without printing its line, so that the
 * script waits on it until something stops the script.
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

const args = Deno.args;
const name = args.includes("dev-local")
  ? "shell"
  : args.includes("console:launch")
  ? "console"
  : "toolshed";
const port = name === "shell"
  ? Number(requiredEnv("SHELL_PORT"))
  : portArgument(args);
const readyLine = {
  shell: "Dev server listening on",
  toolshed: "Server running on",
  console: "Console listening on",
}[name];

// Never unlocked: the lock is released when this process exits.
const lock = await Deno.open(requiredEnv("FAKE_DEV_SERVER_LOCK"));
await lock.lock(false);

try {
  Deno.serve({
    port,
    onListen() {
      if (Deno.env.get("FAKE_DEV_SERVER_SILENT") !== name) {
        console.log(`${readyLine} port ${port}`);
      }
    },
  }, () => new Response("ok"));
} catch (error) {
  if (error instanceof Deno.errors.AddrInUse) Deno.exit(PORT_IN_USE_EXIT);
  throw error;
}
