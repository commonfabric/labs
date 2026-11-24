/**
 * Paints the dashboard message into its input as the message fades. This runs
 * in the browser, on the same tick that refreshes the rest of the page, and
 * yields to whoever is at the keyboard: a draft being typed or a save still in
 * flight is left exactly as it stands.
 */

import { dashboardMessageOpacity } from "./dashboard-message.ts";

export interface DashboardMessagePaintState {
  savedText: string;
  updatedAt: number | null;
  draftProtected: boolean;
}

/** Paints the saved message while preserving a draft or pending save. */
export function paintDashboardMessageInput(
  input: HTMLInputElement,
  state: DashboardMessagePaintState,
  now: number,
  visibleMs: number,
  fadeMs: number,
): void {
  if (state.draftProtected) {
    input.style.opacity = "1";
    return;
  }
  if (state.updatedAt === null || state.savedText === "") {
    input.style.opacity = "1";
    return;
  }
  const opacity = dashboardMessageOpacity(
    state.updatedAt,
    now,
    visibleMs,
    fadeMs,
  );
  if (opacity === 0) {
    state.savedText = "";
    state.updatedAt = null;
    input.value = "";
    input.style.opacity = "1";
    return;
  }
  input.style.opacity = String(opacity);
}
