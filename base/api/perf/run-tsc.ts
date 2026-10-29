#!/usr/bin/env -S deno run -A

import ts from "typescript";

const tscSpecifier = `npm:typescript@${ts.version}/bin/tsc`;

type TscCommandOptions = Omit<Deno.CommandOptions, "args">;

export function tscCommand(
  args: string[],
  options: TscCommandOptions = {},
): Deno.Command {
  return new Deno.Command(Deno.execPath(), {
    ...options,
    args: [
      "run",
      "--cached-only",
      "--frozen=true",
      "-A",
      tscSpecifier,
      ...args,
    ],
  });
}

if (import.meta.main) {
  const status = await tscCommand(Deno.args, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  Deno.exit(status.code);
}
