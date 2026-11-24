import { parseArgs } from "@std/cli/parse-args";
import { resolve } from "@std/path";

export type GithubHostCliOptions =
  | { help: true }
  | {
    help: false;
    apiUrl: string;
    configPath: string;
    identityPath: string;
    once: boolean;
    space: string;
  };

export const GITHUB_HOST_USAGE = `github-host

Collects the authenticated user's open GitHub pull requests and publishes them
to a Common Fabric space.

Usage:
  deno task github-host --config <path> --api-url <url> \\
    --identity <key-file> --space <name-or-did> [--once]

Required options:
  --config <path>       JSONC host configuration
  --api-url <url>       Common Fabric API URL (or CF_API_URL)
  --identity <path>     PKCS#8 identity file (or CF_IDENTITY)
  --space <value>       Space name or DID (or CF_SPACE)

Authentication comes from GH_TOKEN, GITHUB_TOKEN, or gh auth token. Long-running
mode collects at startup, at the configured interval, and on SIGHUP.
`;

function required(value: unknown, option: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`missing required option: --${option}`);
  }
  return value.trim();
}

/** Parse GitHub host command-line arguments and shared Fabric environment. */
export function parseGithubHostCliOptions(
  argv: string[],
  readEnv: (key: string) => string | undefined = (key) => Deno.env.get(key),
): GithubHostCliOptions {
  const args = parseArgs(argv, {
    string: ["api-url", "config", "identity", "space"],
    boolean: ["help", "once"],
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
  const apiUrl = required(
    args["api-url"] ?? readEnv("CF_API_URL"),
    "api-url",
  );
  try {
    new URL(apiUrl);
  } catch {
    throw new Error("--api-url is not a valid URL");
  }
  return {
    help: false,
    apiUrl,
    configPath: resolve(required(args.config, "config")),
    identityPath: resolve(
      required(args.identity ?? readEnv("CF_IDENTITY"), "identity"),
    ),
    once: args.once,
    space: required(args.space ?? readEnv("CF_SPACE"), "space"),
  };
}
