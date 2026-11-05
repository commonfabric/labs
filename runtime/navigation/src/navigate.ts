import {
  AppView,
  appViewToUrlPath,
  preserveAppViewMode,
  urlToAppView,
} from "./view.ts";

export type NavigationCommand = AppView;

// The names of the four navigation events. A component or a pattern dispatches
// one of these on `globalThis` to say where it wants to go; whichever host is
// running listens for them and decides what that means. `globalThis` rather
// than the DOM, so a target inside a shadow root or an iframe-hosted piece
// reaches the host without depending on the tree it happens to sit in.
export const NAVIGATE_EVENT = "cf-navigate";
export const REPLACE_NAVIGATION_EVENT = "cf-replace-navigation";
export const OPEN_EXTERNAL_EVENT = "cf-open-external";
export const UPDATE_PAGE_TITLE_EVENT = "cf-update-page-title";

// Ask the host to go to `command`, adding a history entry.
export function navigate(command: NavigationCommand) {
  globalThis.dispatchEvent(
    new CustomEvent(NAVIGATE_EVENT, { detail: command }),
  );
}

// Ask the host to go to `command`, replacing the current history entry.
export function replaceNavigation(command: NavigationCommand) {
  globalThis.dispatchEvent(
    new CustomEvent(REPLACE_NAVIGATION_EVENT, { detail: command }),
  );
}

// Ask the host to set the page title.
export function updatePageTitle(title: string) {
  globalThis.dispatchEvent(
    new CustomEvent(UPDATE_PAGE_TITLE_EVENT, { detail: title }),
  );
}

// Open a navigation target in a new tab. Dispatches a cancellable
// `cf-open-external` event first; a host that calls `preventDefault()` on it
// owns the new-tab navigation and can apply its own URL scheme. Otherwise the
// default builds a fabric URL from the current location and calls
// `globalThis.open`, so plain and modifier clicks are both interceptable from
// one well-known event surface.
export function openInNewTab(command: NavigationCommand) {
  const proceed = globalThis.dispatchEvent(
    new CustomEvent(OPEN_EXTERNAL_EVENT, {
      detail: command,
      cancelable: true,
    }),
  );
  if (!proceed) return;
  const url = appViewToUrlPath(
    preserveAppViewMode(
      urlToAppView(new URL(globalThis.location.href)),
      command,
    ),
  );
  globalThis.open(url, "_blank", "noopener");
}
