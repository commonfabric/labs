/**
 * The module every `deno test` invocation loads through `--preload`. It
 * captures the test file each test belongs to and applies this
 * invocation's skip list, which `./registration.ts` holds, and marks when
 * the invocation's units began, which `./began.ts` holds. Deno runs it
 * once per test file, after type-checking every file it was handed and
 * before loading that file, so the earliest mark falls where the
 * invocation's own setup ends.
 *
 * Deno resolves `--preload` as a path rather than through the import map,
 * so callers name this file's absolute path. `preloadModulePath` is where
 * that path is computed, so nothing spells it out.
 */

import { markUnitsBegan } from "./began.ts";
import { installRegistrationCapture } from "./registration.ts";

installRegistrationCapture();
markUnitsBegan();
