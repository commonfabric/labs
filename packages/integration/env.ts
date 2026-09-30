// Server URL. Defaults to `http://localhost:8000`
export const API_URL = ensureTrailing(
  Deno.env.get("API_URL") ?? "http://localhost:8000",
);

// Frontend URL. Defaults to `API_URL`.
// Only needs to differ from `API_URL` when running
// integration tests via a dev shell build
// e.g. `http://localhost:5173`.
export const FRONTEND_URL = ensureTrailing(
  Deno.env.get("FRONTEND_URL") ?? API_URL,
);

export const HEADLESS = envToBool(Deno.env.get("HEADLESS"));

// Pipe browser console output to the test runner's console.
export const PIPE_CONSOLE = envToBool(Deno.env.get("PIPE_CONSOLE"));

// A legacy space name, for a test meant to target a space that already exists
// rather than one it creates. A legacy name resolves to the DID the old
// name-based derivation produced, and opening it creates nothing, so the space
// must already exist. Unset by default: a test that wants a space of its own
// creates one with `createTestSpace`, and addresses it by DID.
export const SPACE_NAME: string | undefined = Deno.env.get("SPACE_NAME");

// Number of concurrent browser profiles for multi-browser CFC tests.
// Defaults to 2 (the minimum that exercises per-user isolation + shared-state
// liveness). Raise it — e.g. `CFC_BROWSER_PROFILE_COUNT=4` — to amplify
// cross-browser sync contention when reproducing dual-browser slowness.
export const CFC_BROWSER_PROFILE_COUNT = (() => {
  const raw = Number(Deno.env.get("CFC_BROWSER_PROFILE_COUNT"));
  return Number.isInteger(raw) && raw >= 2 ? raw : 2;
})();

function ensureTrailing(value: string): string {
  return value.substr(-1) === "/" ? value : `${value}/`;
}

function envToBool(value?: string): boolean {
  return value ? (value === "true" || value === "1") : false;
}
