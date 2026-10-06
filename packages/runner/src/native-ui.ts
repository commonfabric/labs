/**
 * The sanctioned way for a native host to send a reviewed action from one of
 * its own controls. A browser surface gets its renderer-trusted events from
 * the renderer's dispatch; a host drawing a control natively has no such
 * dispatch, and binds the control here instead of building provenance and
 * calling `markRendererTrustedEvent()` itself. Host code only: pattern source
 * cannot import this module.
 */

import type { Cell } from "./cell.ts";
import { markRendererTrustedEvent } from "./cfc/ui-contract.ts";

/** The reviewed surface and action one native control draws. */
export interface NativeUiControl {
  /**
   * The trusted surface, matched against a UI contract's `trustedPattern` and
   * `requiredEventIntegrity`.
   */
  surface: string;

  /** The action, matched against a `UiAction` contract's `action`. */
  action: string;
}

/**
 * Binds a native control to one stream and one reviewed surface and action,
 * and returns the function the control's real user-input path calls with the
 * values it displayed. Each call sends a fresh event holding the payload's
 * fields, with `native` provenance for the bound surface and action, carrying
 * the renderer-trust mark.
 *
 * The surface and action are read once, here; changing `control` afterward
 * changes nothing the returned function sends. A `provenance` field in a
 * payload is replaced. The runtime still applies its ordinary checks to the
 * write the event leads to: the writer the contract names, the surface and
 * action, the actor, and the space's access list. The event satisfies a
 * write's UI contract and nothing more, since `isTrustedGesture()` admits
 * only events of `dom` origin.
 *
 * The returned function mints trusted events, so the host keeps it away from
 * pattern code, loaded content, automation and agent interfaces, generic IPC,
 * URL handlers, and restored state. A host that cannot hold that boundary
 * renders the pattern's reviewed surface instead.
 *
 * @throws If `control` names a blank surface or action.
 */
export function bindNativeUiControl<T extends object>(
  stream: Pick<Cell<unknown>, "send">,
  control: NativeUiControl,
): (payload: T) => void {
  const { surface, action } = control;
  if (!surface.trim() || !action.trim()) {
    throw new Error("A native UI control requires a surface and an action.");
  }

  return (payload) => {
    const event = {
      ...payload,
      provenance: {
        origin: "native",
        trusted: true,
        ui: {
          pattern: surface,
          eventIntegrity: [surface],
          uiContractDataset: { uiAction: action },
        },
      },
    };
    markRendererTrustedEvent(event);
    stream.send(event);
  };
}
