/**
 * Run with env access DENIED (no --allow-env): readEnv's Deno.env.get throws,
 * its catch swallows the denied read and reports the var unset, so librarySource
 * falls through to the release. Exercises readEnv's catch under real denial.
 */

import { librarySource } from "../../v2/sqlite/column-origin.ts";
console.log(JSON.stringify(librarySource()));
