const STORAGE_KEY = "cf-theme-preference";

export type ThemePreference = "light" | "dark" | "auto";

/** Read the stored theme preference, defaulting to "auto" (follow system). */
export function getThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage unavailable
  }
  return "auto";
}

/** Resolve the effective theme (always "light" or "dark"). */
export function getEffectiveTheme(): "light" | "dark" {
  const pref = getThemePreference();
  if (pref !== "auto") return pref;
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * Persist the user's theme preference and apply the `data-theme` attribute
 * on `<html>` so CSS can respond immediately.
 * Dispatches a `theme-preference-changed` event on `document`.
 */
export function setThemePreference(pref: ThemePreference): void {
  try {
    if (pref === "auto") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, pref);
    }
  } catch {
    // localStorage unavailable
  }

  if (pref === "auto") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", pref);
  }

  document.dispatchEvent(
    new CustomEvent("theme-preference-changed", { detail: pref }),
  );
}

/** Toggle between light and dark. Returns the new preference. */
export function toggleTheme(): ThemePreference {
  const effective = getEffectiveTheme();
  const next: ThemePreference = effective === "light" ? "dark" : "light";
  setThemePreference(next);
  return next;
}
