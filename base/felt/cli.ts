import { exists } from "@std/fs/exists";
import { join } from "@std/path/join";

import { Command } from "@cliffy/command";
import { HelpCommand } from "@cliffy/command/help";

import { Felt } from "./felt.ts";
import { Config, FeltCommand, ResolvedConfig } from "./interface.ts";

const command = new Command()
  .name("felt")
  .description("Frontend lightweight tooling.")
  .version("0.0.1")
  .default("help")
  .command("help", new HelpCommand().global())
  .command("build", "Build project.")
  .usage("felt build .")
  .example(
    `felt build .`,
    "Builds the project in current directory.",
  )
  .arguments("[dir:string]")
  .action((_, dir?: string) => felt("build", dir))
  .command("serve", "Build and serves the project.")
  .usage("felt serve .")
  .example(
    `felt serve .`,
    "Build and serves the project in current directory.",
  )
  .arguments("[dir:string]")
  .action((_, dir?: string) => felt("serve", dir))
  .command("dev", "Serve the project, autoreloading when source changes.")
  .usage("felt dev .")
  .example(
    `felt dev .`,
    "Serve the project, autoreloading when source changes in current directory.",
  )
  .arguments("[dir:string]")
  .action((_, dir?: string) => felt("dev", dir));

async function getConfig(projectDir: string): Promise<Config> {
  const configTsPath = join(projectDir, "felt.config.ts");
  if (await exists(configTsPath, { isFile: true })) {
    try {
      return (await import(configTsPath)).default as Config;
    } catch (_) {
      console.error(`Unable to execute felt.config.ts`);
    }
  }
  throw new Error("No felt.config.ts to load.");
}

async function felt(
  command: FeltCommand,
  dir?: string,
) {
  const cwd = Deno.cwd();
  const root = dir ? join(cwd, dir) : cwd;
  const config = await getConfig(root);
  const resolved = new ResolvedConfig(config);
  await new Felt(command, resolved).process();
}

if (import.meta.main) {
  await command.parse(Deno.args);
}
