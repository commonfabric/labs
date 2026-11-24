/**
 * The module every `deno test` invocation loads through `--preload`. It
 * captures the test file each test belongs to and applies this
 * invocation's skip list, which `./registration.ts` holds.
 *
 * Deno resolves `--preload` against the working directory rather than
 * through the import map, so callers name this file's absolute URL.
 * `preloadArgument` is where that URL is computed, so nothing spells it
 * out.
 */

import { installRegistrationCapture } from "./registration.ts";

installRegistrationCapture();
