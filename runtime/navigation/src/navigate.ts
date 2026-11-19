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

// How long `openInNewTabWhenReady` waits for its target before it reserves a
// tab, where reserving is turned on. A browser lets a page open a tab only
// within a short time of a user's gesture (about five seconds in Chrome and
// Firefox), and opening one uses that up.
export const NEW_TAB_RESERVE_AFTER_MS = 1000;

// Whether `openInNewTabWhenReady` may reserve a tab for a slow target. Off
// unless the host turns it on. Only a host whose new tabs open through the
// default `globalThis.open` path, the shell, gains from a reservation. A host
// that takes `cf-open-external` itself may open no tab at all (Loom's pattern
// panes navigate in place), and a tab reserved under it would only get in its
// way: a blank tab that flashes, or, where a host routes `window.open` into
// the pane, a blank page loaded in the pane.
let newTabReservation = false;

// Turn reserving a tab for a slow target on or off. A host whose new tabs
// open through the default path, as the shell's do, turns it on.
export function setNewTabReservation(enabled: boolean): void {
  newTabReservation = enabled;
}

// Whether reserving a tab for a slow target is turned on.
export function newTabReservationEnabled(): boolean {
  return newTabReservation;
}

// A `cf-open-external` event dispatched for a tab reserved in advance. A host
// that takes the event and wants a tab of its own calls `claimReservedTab()`
// and points the tab it returns at its own URL: the gesture that could have
// opened a new one has been spent on the reservation. A host that cancels the
// event without claiming the tab leaves it to be closed.
export type OpenExternalEvent = CustomEvent<NavigationCommand> & {
  claimReservedTab?: () => Window;
};

// Open in a new tab a navigation target that is still being found, from the
// click that asked for it.
// - With reserving off (`reserve`, default `newTabReservationEnabled()`), the
//   target is opened as `openInNewTab` opens it once it lands.
// - With it on, a target that arrives within `reserveAfterMs` (default
//   `NEW_TAB_RESERVE_AFTER_MS`) opens the same way, while the gesture still
//   allows a host or the default to open a tab. Past that, a tab is reserved,
//   while the gesture still allows it, and pointed at the target once it
//   lands. The `cf-open-external` event then dispatched offers the reserved
//   tab to a host (`claimReservedTab()`).
// - A target of `undefined`, or a rejection, closes a reserved tab. So does
//   a host that cancels the event without claiming it.
// Where the browser opens no tab for the reservation, the target is handed to
// `openInNewTab` once it is known.
export async function openInNewTabWhenReady(
  target: Promise<NavigationCommand | undefined>,
  options: { reserveAfterMs?: number; reserve?: boolean } = {},
): Promise<void> {
  if (!(options.reserve ?? newTabReservation)) {
    const command = await target;
    if (command !== undefined) openInNewTab(command);
    return;
  }
  let reserved: Window | null = null;
  let settled = false;
  const reservation = setTimeout(() => {
    if (!settled) reserved = globalThis.open?.("", "_blank") ?? null;
  }, options.reserveAfterMs ?? NEW_TAB_RESERVE_AFTER_MS);
  let command: NavigationCommand | undefined;
  try {
    command = await target;
  } catch (error) {
    (reserved as Window | null)?.close();
    throw error;
  } finally {
    settled = true;
    clearTimeout(reservation);
  }
  const tab = reserved as Window | null;
  if (command === undefined) {
    tab?.close();
    return;
  }
  if (tab === null) return openInNewTab(command);
  let claimed = false;
  const event: OpenExternalEvent = Object.assign(
    new CustomEvent(OPEN_EXTERNAL_EVENT, {
      detail: command,
      cancelable: true,
    }),
    {
      claimReservedTab: () => {
        claimed = true;
        // Cut from this page before the host has it, as `noopener` would
        // have cut a tab opened for it.
        tab.opener = null;
        return tab;
      },
    },
  );
  const proceed = globalThis.dispatchEvent(event);
  if (claimed) return;
  if (!proceed) {
    tab.close();
    return;
  }
  // `noopener` cannot be asked for on a tab whose handle is kept, so the
  // reserved tab is cut from this page before it navigates.
  tab.opener = null;
  tab.location.href = fabricUrlOf(command);
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
