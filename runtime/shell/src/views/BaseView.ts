import type { Identity } from "@commonfabric/identity";
import { AppView, urlToAppView } from "@commonfabric/navigation";
import { DebugController } from "@commonfabric/ui";
import { LitElement } from "lit";

import { AppStateConfigKey, createAppState } from "../lib/app-state.ts";
import { API_URL } from "../lib/env.ts";
import type { PatternChange } from "../lib/runtime.ts";

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
  | { type: "set-config"; key: AppStateConfigKey; value: boolean }
  // Shows the viewed space as it stood at the point `seq` of its history, in
  // a fork that leaves the space itself alone.
  | { type: "open-history"; seq: number }
  // Returns from a fork to the space as it stands, discarding the fork.
  | { type: "close-history" }
  // Restores the viewed space to the state the open fork holds.
  | { type: "restore-history" }
  // Restores a piece's pattern code to an earlier source revision, keeping
  // the piece's data. `confirmationToken` is the one a warning that the
  // source does not fit the data came with, and confirms the restore.
  | {
    type: "restore-pattern";
    pieceId: string;
    revisionId: string;
    scope?: PatternChange["scope"];
    confirmationToken?: string;
  };

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
