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
  if (!proceedToOpenExternally(command)) return;
  globalThis.open(fabricUrlOf(command), "_blank", "noopener");
}

// Open in a new tab a navigation target that is still being found, keeping
// the user activation of the click that asked for it. A browser opens a tab
// only within a short time of a user's gesture, so a target that takes longer
// to find than that would open nothing. A tab is reserved now, within the
// gesture, and pointed at the target once `target` settles:
// - the same cancellable `cf-open-external` event `openInNewTab` dispatches
//   is dispatched then, and a host that cancels it owns the navigation, so
//   the reserved tab is closed;
// - a target of `undefined`, or a rejection, closes the reserved tab.
// Where the browser opens no tab here (a blocked popup, or no window), the
// target is handed to `openInNewTab` once it is known.
export async function openInNewTabWhenReady(
  target: Promise<NavigationCommand | undefined>,
): Promise<void> {
  const reserved = globalThis.open?.("", "_blank") ?? null;
  let command: NavigationCommand | undefined;
  try {
    command = await target;
  } catch (error) {
    reserved?.close();
    throw error;
  }
  if (command === undefined) {
    reserved?.close();
    return;
  }
  if (reserved === null) return openInNewTab(command);
  if (!proceedToOpenExternally(command)) {
    reserved.close();
    return;
  }
  // `noopener` cannot be asked for on a tab whose handle is kept, so the
  // reserved tab is cut from this page before it navigates.
  reserved.opener = null;
  reserved.location.href = fabricUrlOf(command);
}

// Dispatch the cancellable `cf-open-external` event for `command`; false when
// a host cancelled it and so owns the new-tab navigation.
function proceedToOpenExternally(command: NavigationCommand): boolean {
  return globalThis.dispatchEvent(
    new CustomEvent(OPEN_EXTERNAL_EVENT, {
      detail: command,
      cancelable: true,
    }),
  );
}

// The fabric URL for `command`, built from the current location.
function fabricUrlOf(command: NavigationCommand): string {
  return appViewToUrlPath(
    preserveAppViewMode(
      urlToAppView(new URL(globalThis.location.href)),
      command,
    ),
  );
}
