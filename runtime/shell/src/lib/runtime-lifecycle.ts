import type { AppState } from "./app-state.ts";

/**
 * One runtime per (identity, host): only those changes recreate it. A
 * view/space change is pure view state — the same runtime serves every
 * space (space is part of the address, nothing special about it).
 */
export function shouldRecreateRuntime(
  previous: Pick<AppState, "apiUrl" | "identity">,
  current: Pick<AppState, "apiUrl" | "identity">,
): boolean {
  return previous.apiUrl !== current.apiUrl ||
    previous.identity !== current.identity;
}
