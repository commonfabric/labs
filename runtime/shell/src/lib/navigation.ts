import {
  appViewToUrlPath,
  NAVIGATE_EVENT,
  type NavigationCommand,
  preserveAppViewMode,
  REPLACE_NAVIGATION_EVENT,
  UPDATE_PAGE_TITLE_EVENT,
  urlToAppView,
} from "@commonfabric/navigation";
import { getLogger } from "@commonfabric/utils/logger";

import type { ShellApp } from "./app-state.ts";

const logger = getLogger("shell.navigation", {
  enabled: false,
  level: "debug",
});

// Handles synchronizing of browser history state and application state.
//
// Navigation can occur in the following scenarios:
// * Browser back/forward buttons/shortcuts
// * A link or control calling `navigate()`
//
// On instantiation, parses the current URL and applies app state as needed.
export class Navigation {
  #app: ShellApp;
  constructor(app: ShellApp) {
    this.#app = app;

    globalThis.addEventListener(NAVIGATE_EVENT, this.#onNavigate);
    globalThis.addEventListener(
      REPLACE_NAVIGATION_EVENT,
      this.#onReplaceNavigate,
    );
    globalThis.addEventListener(
      UPDATE_PAGE_TITLE_EVENT,
      this.#onUpdatePageTitle,
    );
    globalThis.addEventListener("popstate", this.#onPopState);

    const thisUrl = new URL(globalThis.location.href);
    const init = urlToAppView(thisUrl);
    // Initial state is `null` -- reflect the state given
    // from the current URL.
    this.#replace(init);
    this.#apply(init);
  }

  /**
   * Stops listening, removing the four global listeners the constructor
   * added.
   */
  dispose() {
    globalThis.removeEventListener(NAVIGATE_EVENT, this.#onNavigate);
    globalThis.removeEventListener(
      REPLACE_NAVIGATION_EVENT,
      this.#onReplaceNavigate,
    );
    globalThis.removeEventListener(
      UPDATE_PAGE_TITLE_EVENT,
      this.#onUpdatePageTitle,
    );
    globalThis.removeEventListener("popstate", this.#onPopState);
  }

  #onUpdatePageTitle = (e: Event) => {
    const title = (e as CustomEvent<string>).detail;
    logger.log("SetTitle", title);
    // Thought this needed to interact with the history.
    // Maybe it doesn't.
    document.title = title;
  };

  #onPopState = (e: Event) => {
    const state = (e as PopStateEvent).state as NavigationCommand | null;
    logger.log("Pop", state);
    if (!state) {
      console.warn("No state from history!");
      return;
    }
    this.#apply(state);
  };

  #onNavigate = (e: Event) => {
    let command = (e as CustomEvent<NavigationCommand>).detail;
    logger.log("Navigate", command);
    command = mapNavigationView(this.#app, command);
    // A navigation to the address the page is already at rewrites the entry it
    // is standing on rather than adding one. Two entries for one address make
    // the first press of Back return to the page it was already on.
    //
    // The address is settled after the mapping, which writes a DID naming the
    // running space as that space's name and carries embed mode into a command
    // that omits it. It goes through `URL` to reach the percent-encoded form
    // `location.pathname` holds, a space name being free to hold a character a
    // path reserves. A view's `openPath` reaches no address, so an entry
    // rewritten from one that held it holds it no longer.
    const address = new URL(
      appViewToUrlPath(command),
      globalThis.location.href,
    );
    if (address.pathname === globalThis.location.pathname) {
      this.#replace(command);
    } else {
      this.#push(command);
    }
    this.#apply(command);
  };

  #onReplaceNavigate = (e: Event) => {
    let command = (e as CustomEvent<NavigationCommand>).detail;
    logger.log("ReplaceNavigate", command);
    command = mapNavigationView(this.#app, command);
    this.#replace(command);
    this.#apply(command);
  };

  /** Pushes a new command state to the browser's history. */
  #push(command: NavigationCommand) {
    logger.log("Push", command);
    globalThis.history.pushState(command, "", appViewToUrlPath(command));
  }

  /** Updates the current browser history state and page with a new title. */
  #replace(command: NavigationCommand, title?: string) {
    logger.log("Replace", command, title);
    globalThis.history.replaceState(
      command,
      title || "",
      appViewToUrlPath(command),
    );
  }

  /** Propagates the command state into the app. */
  #apply(command: NavigationCommand) {
    logger.log("Apply", command);
    this.#app.setView(command);
  }
}

// Navigation events from the DOM use cell references which contain
// a space DID, but no reference to space name. Map these navigation
// events to use a space name if it's the same as the active runtime
// to preserve space name in navigation/URL bar.
function mapNavigationView(
  app: ShellApp,
  view: NavigationCommand,
): NavigationCommand {
  const currentView = app.state().view;
  const currentSpaceName = "spaceName" in currentView
    ? currentView.spaceName
    : undefined;
  const currentSpaceDID = app.getRuntimeSpaceDID();
  if (
    "spaceDid" in view && view.spaceDid && currentSpaceName &&
    view.spaceDid === currentSpaceDID
  ) {
    // Only the space key is exchanged. Everything else the view holds is
    // carried by spreading what is left, so a field added to a view later
    // survives without this having to be taught about it.
    const { spaceDid: _replaced, ...rest } = view;
    view = { ...rest, spaceName: currentSpaceName };
  }
  return preserveAppViewMode(currentView, view);
}
