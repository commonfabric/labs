import { navigate, type NavigationCommand } from "@commonfabric/navigation";
import type { ReactiveController, ReactiveControllerHost } from "lit";

import type { BaseView } from "../views/BaseView.ts";
import type { AppState } from "./app-state.ts";

// Reactive controller host is XAppView, define some interfaces
// to avoid a recursive dependency.
type ReactiveAppHost = ReactiveControllerHost & BaseView & { app: AppState };

/**
 * The shell's global keyboard shortcuts:
 *
 * - Alt+W navigates to the space the current view addresses.
 *
 * Shortcuts are ignored while the key event is aimed at a text-entry element,
 * while the key is auto-repeating, and once something upstream has called
 * `preventDefault()`.
 */
export class GlobalShortcutsController implements ReactiveController {
  #host: ReactiveAppHost;

  /**
   * Whether the platform's primary shortcut modifier is Command rather than
   * Control. Read when the host connects, since it depends on `navigator`. No
   * current binding branches on it; a Cmd/Ctrl shortcut is what does.
   */
  #usesCommandKey = false;

  constructor(host: ReactiveAppHost) {
    this.#host = host;
    this.#host.addController(this);
  }

  hostConnected() {
    this.#usesCommandKey = navigator.platform.toLowerCase().includes("mac");
    document.addEventListener("keydown", this.#onKeyDown);
  }

  hostDisconnected() {
    document.removeEventListener("keydown", this.#onKeyDown);
  }

  #onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.repeat) return;
    if (targetsTextEntry(e)) return;

    if (
      e.code === "KeyW" && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
    ) {
      e.preventDefault();
      navigate(spaceOf(this.#host.app));
    }
  };
}

// The root of the space the view addresses, whether it addresses that space by
// name or by DID. A view that names no space at all is the built-in home view,
// which falls back to the common knowledge space.
function spaceOf(app: AppState): NavigationCommand {
  const view = app.view;
  if ("spaceName" in view) return { spaceName: view.spaceName };
  if ("spaceDid" in view) return { spaceDid: view.spaceDid };
  return { spaceName: "common-knowledge" };
}

// Whether the key event is aimed at somewhere the user is entering text. The
// shell's views render into shadow roots, and an event that crosses a shadow
// boundary reports the shadow host as its target, so the composed path is what
// names the element holding focus.
function targetsTextEntry(e: KeyboardEvent): boolean {
  for (const node of e.composedPath()) {
    const element = node as HTMLElement;
    if (typeof element.tagName !== "string") continue;
    if (element.isContentEditable) return true;
    switch (element.tagName.toLowerCase()) {
      case "input":
      case "textarea":
      case "select":
        return true;
    }
  }
  return false;
}
