import { isDeno } from "@commonfabric/platform/env";
import { StaticCache } from "./cache.ts";

// What a test fetches when it needs an asset and does not care which one. Any
// entry in `assets` serves, under two constraints: `TEST_ASSET_CONTENT` has to
// be a string the chosen file contains, and a test showing that two assets
// differ has to hold this one against a different entry.
export const TEST_ASSET = "types/dom.d.ts";

// A string `TEST_ASSET` contains, for checking that its bytes arrived. It names
// a generated file, so a compiler roll can change the contents and leave this
// needing an update.
export const TEST_ASSET_CONTENT = "interface AddEventListenerOptions";

/**
 * Creates a cache for a test that targets both Deno and the browser, as the
 * tests run under deno-web-test do. It reads assets from the file system when
 * `scope` is Deno, and from `/static` on the page origin of `scope` otherwise.
 */
export function createTestStaticCache(
  scope: { location: { origin: string } } = globalThis,
): StaticCache {
  if (isDeno(scope)) {
    return StaticCache.fromFileSystem();
  }
  const url = new URL(scope.location.origin);
  url.pathname = "static";
  return new StaticCache(url);
}
