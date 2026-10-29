import type { Identity } from "@commonfabric/identity";
import { AppView, urlToAppView } from "@commonfabric/navigation";
import { DebugController } from "@commonfabric/ui";
import { LitElement } from "lit";

import { AppStateConfigKey, createAppState } from "../lib/app-state.ts";
import { API_URL } from "../lib/env.ts";

// Set to `true` to render outlines everytime a
// LitElement renders.
const DEBUG_RENDERER = false;

export const SHELL_COMMAND = "shell-command";

// The closed set of application-state changes a view may ask for. `XRootView`
// listens for `SHELL_COMMAND` and routes each arm to its matching method, so a
// new kind of state change means a new arm here and a new method there.
export type Command =
  | { type: "set-view"; view: AppView }
  | { type: "set-identity"; identity: Identity | undefined }
  | { type: "set-config"; key: AppStateConfigKey; value: boolean };

export class BaseView extends LitElement {
  #_debugController = DEBUG_RENDERER ? new DebugController(this) : null;
  command(command: Command) {
    this.dispatchEvent(
      new CustomEvent(SHELL_COMMAND, {
        detail: command,
        composed: true,
        bubbles: true,
      }),
    );
  }
}

export function createDefaultAppState() {
  return createAppState({
    apiUrl: API_URL,
    view: urlToAppView(new URL(globalThis.location.href)),
  });
}
