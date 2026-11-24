import { resolve, toFileUrl } from "@std/path";

import { Command } from "@cliffy/command";
import { HelpCommand } from "@cliffy/command/help";

import { felt } from "./felt.ts";
import { Config, FeltCommand, ResolvedConfig } from "./interface.ts";

/** The exit status when the server's port is already in use. */
export const PORT_IN_USE_EXIT = 3;

export const command = new Command()
  .name("felt")
  .description("Frontend lightweight tooling.")
  .version("0.0.1")
  .default("help")
  .command("help", new HelpCommand().global());

for (
  const [name, description, example] of [
    ["build", "Build project.", "Builds the project"],
    ["serve", "Build and serves the project.", "Build and serves the project"],
    [
      "dev",
      "Serve the project, autoreloading when source changes.",
      "Serve the project, autoreloading when source changes",
    ],
  ] as const
) {
  command.command(name, description)
    .usage(`felt ${name} .`)
    .example(`felt ${name} .`, `${example} in current directory.`)
    .arguments("[dir:string]")
    .action((_, dir?: string) => run(name, dir));
}

/**
 * Runs `command` on the project in `dir`, relative to the working directory,
 * configured by its `felt.config.ts`, until the build finishes or the server
 * stops.
 */
async function run(command: FeltCommand, dir = ".") {
  const root = resolve(dir);
  const config: Config =
    (await import(toFileUrl(resolve(root, "felt.config.ts")).href)).default;
  const resolved = new ResolvedConfig(config, root);
  try {
    await (await felt(command, resolved))?.finished;
  } catch (error) {
    if (!(error instanceof Deno.errors.AddrInUse)) throw error;
    // The dev-server scripts retry a port collision elsewhere on this status.
    console.error(`Port ${resolved.port} is already in use`);
    Deno.exitCode = PORT_IN_USE_EXIT;
  }
}

if (import.meta.main) {
  await command.parse(Deno.args);
}
