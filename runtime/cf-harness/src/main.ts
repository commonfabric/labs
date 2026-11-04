import { runCfHarnessCli } from "./cli.ts";

if (import.meta.main) {
  const exitCode = await runCfHarnessCli(Deno.args);
  Deno.exit(exitCode);
}
