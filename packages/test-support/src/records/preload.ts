/**
 * The module every `deno test` invocation loads through `--preload`. It
 * captures the test file each test belongs to and applies this
 * invocation's skip list; `./registration.ts` holds both.
 *
 * Deno resolves `--preload` as a path rather than through the import map,
 * so callers name this file's absolute path. `preloadModulePath` is where
 * that path is computed, so nothing spells it out.
 */

import { installRegistrationCapture } from "./registration.ts";

installRegistrationCapture();
