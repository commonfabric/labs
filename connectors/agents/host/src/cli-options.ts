import { parseArgs } from "@std/cli/parse-args";
import { resolve } from "@std/path";
import { parseAgentFabricApiUrl } from "./target-state.ts";

export type EnvReader = (key: string) => string | undefined;

export type AgentsHostCliOptions =
  | { help: true }
  | {
    help: false;
    apiUrl: string;
    configPath: string;
    debugView: boolean;
    identityPath: string;
    once: boolean;
    space: string;
  };

export const AGENTS_HOST_USAGE = `agents-host

Hosts coding-agent sources and synchronizes their sessions with a Common Fabric
space. The debug view is deployed and registered in the space by default.

Usage:
  deno task agents-host --config <path> --api-url <url> \\
    --identity <key-file> --space <name-or-did> [options]

Required options:
  --config <path>       JSONC source configuration
  --api-url <url>       Common Fabric API URL (or CF_API_URL)
  --identity <path>     PKCS#8 identity file (or CF_IDENTITY)
  --space <value>       Space name or DID (or CF_SPACE)

Options:
  --once                Collect once, publish, and exit
  --no-debug-view       Do not deploy the built-in debug pattern
  -h, --help            Show this help

Long-running mode collects once at startup, accepts Fabric commands, collects
at the configured interval and on SIGHUP, and shuts down on SIGINT or SIGTERM.
`;

function required(value: unknown, option: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`missing required option: --${option}`);
  }
  return value.trim();
}

export function parseAgentsHostCliOptions(
  argv: string[],
  readEnv: EnvReader = (key) => Deno.env.get(key),
): AgentsHostCliOptions {
  const args = parseArgs(argv, {
    string: ["api-url", "config", "identity", "space"],
    boolean: ["debug-view", "help", "once"],
    negatable: ["debug-view"],
    default: { "debug-view": true },
    alias: { help: "h" },
    unknown: (argument, key) => {
      if (key !== undefined) throw new Error(`unknown option: ${argument}`);
      return true;
    },
  });

  if (args.help) return { help: true };
  if (args._.length > 0) {
    throw new Error(`unexpected positional argument: ${String(args._[0])}`);
  }

  const configPath = resolve(required(args.config, "config"));
  const apiUrl = required(args["api-url"] ?? readEnv("CF_API_URL"), "api-url");
  parseAgentFabricApiUrl(apiUrl, "--api-url is not a valid URL");
  const identityPath = resolve(
    required(args.identity ?? readEnv("CF_IDENTITY"), "identity"),
  );
  const space = required(args.space ?? readEnv("CF_SPACE"), "space");

  return {
    help: false,
    apiUrl,
    configPath,
    debugView: args["debug-view"] !== false,
    identityPath,
    once: args.once,
    space,
  };
}
