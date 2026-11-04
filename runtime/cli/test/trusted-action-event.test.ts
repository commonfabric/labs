import { assertEquals } from "@std/assert";
import { isRendererTrustedEvent } from "../../runner/src/cfc/ui-contract.ts";
import { buildActionEvent } from "../lib/trusted-action-event.ts";

Deno.test("trusted UI action without a payload synthesizes a click event", () => {
  const event = buildActionEvent(undefined, {
    surface: "pattern-id",
    action: "save",
  });
  assertEquals(event, {
    type: "click",
    provenance: {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: "pattern-id",
        eventIntegrity: ["pattern-id"],
        uiContractDataset: { uiAction: "save" },
      },
    },
  });
  assertEquals(isRendererTrustedEvent(event), true);
});
