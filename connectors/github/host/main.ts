#!/usr/bin/env -S deno run -A

import { runGithubHostCli } from "./src/cli.ts";

if (import.meta.main) Deno.exit(await runGithubHostCli());
