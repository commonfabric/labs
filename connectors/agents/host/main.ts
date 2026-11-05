#!/usr/bin/env -S deno run -A

import { runAgentsHostCli } from "./src/cli.ts";

if (import.meta.main) {
  Deno.exit(await runAgentsHostCli());
}
