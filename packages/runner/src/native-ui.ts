/** Host-only controls for trusted gestures from a native renderer. */
import type { Cell } from "./cell.ts";
import { markRendererTrustedEvent } from "./cfc/ui-contract.ts";

/** The reviewed surface and action drawn by one native control. */
export interface NativeUiControl {
  surface: string;
  action: string;
}

/**
 * Binds a native control to one room writer and one reviewed action. The host
 * calls the returned function only from that control's real user-input path,
 * passing exactly the values it displayed. Keep the function inaccessible to
 * patterns, loaded content, automation, and generic IPC. The runtime still
 * checks the writer identity, surface, action, actor, and space access.
 */
export function bindNativeUiControl<T extends Record<string, unknown>>(
  stream: Pick<Cell<unknown>, "send">,
  control: NativeUiControl,
): (payload: T) => ReturnType<Cell<unknown>["send"]> {
  const { surface, action } = control;
  if (!surface.trim() || !action.trim()) {
    throw new Error("A native UI control requires a surface and action.");
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
    return stream.send(event);
  };
}
