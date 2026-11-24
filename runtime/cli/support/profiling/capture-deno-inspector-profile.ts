import { captureDenoInspectorProfile } from "./capture-deno-inspector-profile-lib.ts";
import { InspectorProtocolClient } from "./inspector-protocol-client.ts";

if (import.meta.main) {
  const exitCode = await captureDenoInspectorProfile(Deno.args, {
    addSignalListener: Deno.addSignalListener,
    createCelestial: (ws) => new InspectorProtocolClient(ws),
    createWebSocket: (url) => new WebSocket(url),
    removeSignalListener: Deno.removeSignalListener,
  });
  Deno.exit(exitCode);
}
