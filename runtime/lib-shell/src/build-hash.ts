/**
 * The worker bundle hash named by the build manifest this page's origin
 * serves, read afresh. `undefined` where there is no page location, or when
 * the manifest is missing, unreadable, or names no worker bundle hash, which
 * disables the compilation cache.
 */
export async function readBuildHash(): Promise<string | undefined> {
  try {
    const resp = await fetch(
      new URL("/build-manifest.json", globalThis.location.origin),
      { cache: "no-store" },
    );
    if (resp.ok) {
      const manifest = await resp.json();
      // Key must match the worker entry's `out` path in felt.config.ts.
      const hash: unknown = manifest["scripts/worker-runtime.js"];
      return typeof hash === "string" ? hash : undefined;
    }
  } catch {
    // Manifest not available.
  }
  return undefined;
}
