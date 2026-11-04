import { basename } from "@std/path";

function normalizeCliName(
  name: string | undefined | null,
): "cf" | undefined {
  const normalized = name?.trim().toLowerCase();
  if (normalized === "cf" || normalized === "cf.exe") {
    return "cf";
  }
  return undefined;
}

export function cliName(
  options: { envName?: string | undefined; execPath?: string | undefined } = {},
): "cf" {
  const envName = normalizeCliName(
    options.envName ?? Deno.env.get("CF_CLI_NAME"),
  );
  if (envName) {
    return envName;
  }

  const execName = normalizeCliName(
    basename(options.execPath ?? Deno.execPath()),
  );
  if (execName) {
    return execName;
  }

  return "cf";
}

export function cliCommand(parts: Iterable<string>, name = cliName()): string {
  return [name, ...parts].join(" ");
}

export function cliText(text: string, name = cliName()): string {
  return text.replaceAll(/(^|[\s"'`(])cf(?=\s)/gm, `$1${name}`);
}
