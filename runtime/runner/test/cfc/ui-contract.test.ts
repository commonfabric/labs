import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { dataUriFromValue } from "@commonfabric/data-model/codec-data-uri";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../../src/builder/types.ts";
import {
  markRendererTrustedEvent,
  recordTrustedEventPolicyInputs,
  trustedEventMatchesUiContract,
  uiContractFromSchema,
} from "../../src/cfc/ui-contract.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import { Runtime } from "../../src/runtime.ts";
import { LINK_V1_TAG } from "../../src/sigil-types.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

/** A `data:` URI of the fabric's media type whose payload does not decode. */
const malformedDataUri = (() => {
  const valid = dataUriFromValue({});
  return `${valid.slice(0, valid.indexOf(",") + 1)}%%%`;
})();

const signer = await Identity.fromPassphrase("cfc ui contract coverage");
const space = signer.did();

/** A schema declaring `uiContract` as its only label. */
const declaring = (uiContract: Record<string, unknown>): JSONSchema => ({
  type: "string",
  ifc: { uiContract },
});

/** `event`, carrying the renderer-trust mark. */
const marked = <T extends object>(event: T): T => {
  markRendererTrustedEvent(event);
  return event;
};

/** A click on a trusted DOM surface whose dataset is `dataset`. */
const click = (ui: Record<string, unknown>) => ({
  type: "click",
  provenance: { origin: "dom", trusted: true, ui },
});

describe("ui-contract", () => {
  describe("uiContractFromSchema()", () => {
    it("returns a `UiPromptSlot` contract with its surface, and its role where the schema names one", () => {
      expect(
        uiContractFromSchema(
          declaring({ helper: "UiPromptSlot", surface: "chat", role: "user" }),
        ),
      ).toEqual({ helper: "UiPromptSlot", surface: "chat", role: "user" });
      expect(
        uiContractFromSchema(
          declaring({ helper: "UiPromptSlot", surface: "chat", role: 7 }),
        ),
      ).toEqual({ helper: "UiPromptSlot", surface: "chat" });
    });

    it("returns `undefined` for a `UiPromptSlot` contract naming no surface", () => {
      expect(uiContractFromSchema(declaring({ helper: "UiPromptSlot" })))
        .toBeUndefined();
    });

    it("returns `undefined` for a helper it does not know", () => {
      expect(
        uiContractFromSchema(
          declaring({ helper: "UiSomethingElse", action: "Submit" }),
        ),
      ).toBeUndefined();
    });
  });

  describe("trustedEventMatchesUiContract()", () => {
    it("returns `true` for a `UiPromptSlot` contract only on its surface and role", () => {
      const contract = uiContractFromSchema(
        declaring({ helper: "UiPromptSlot", surface: "chat", role: "user" }),
      );
      const slot = (dataset: Record<string, unknown>) =>
        marked(click({ uiContractDataset: dataset }));
      expect(
        trustedEventMatchesUiContract(
          slot({ uiSurface: "chat", uiRole: "user" }),
          contract,
        ),
      ).toBe(true);
      expect(
        trustedEventMatchesUiContract(
          slot({ uiSurface: "chat", uiRole: "assistant" }),
          contract,
        ),
      ).toBe(false);
      expect(
        trustedEventMatchesUiContract(
          slot({ uiSurface: "search", uiRole: "user" }),
          contract,
        ),
      ).toBe(false);
    });

    it("returns `true` for a `UiPromptSlot` contract with no role on any role of its surface", () => {
      const contract = uiContractFromSchema(
        declaring({ helper: "UiPromptSlot", surface: "chat" }),
      );
      expect(
        trustedEventMatchesUiContract(
          marked(click({ uiContractDataset: { uiSurface: "chat" } })),
          contract,
        ),
      ).toBe(true);
    });

    it("returns `true` for a `UiDisclosure` contract only on its kind", () => {
      const contract = uiContractFromSchema(
        declaring({ helper: "UiDisclosure", kind: "risk" }),
      );
      expect(
        trustedEventMatchesUiContract(
          marked(click({ uiContractDataset: { uiDisclosureKind: "risk" } })),
          contract,
        ),
      ).toBe(true);
      expect(
        trustedEventMatchesUiContract(
          marked(click({ uiContractDataset: { uiDisclosureKind: "other" } })),
          contract,
        ),
      ).toBe(false);
    });

    it("returns `false` for a contract requiring event integrity on an event that lists none", () => {
      const contract = uiContractFromSchema(
        declaring({
          helper: "UiAction",
          action: "Submit",
          trustedPattern: "Surface",
          requiredEventIntegrity: ["Surface"],
        }),
      );
      const event = (ui: Record<string, unknown>) =>
        marked(click({ ...ui, uiContractDataset: { uiAction: "Submit" } }));
      expect(
        trustedEventMatchesUiContract(
          event({ pattern: "Surface", eventIntegrity: ["Surface"] }),
          contract,
        ),
      ).toBe(true);
      expect(
        trustedEventMatchesUiContract(event({ pattern: "Surface" }), contract),
      ).toBe(false);
    });

    it("returns `false` for an event without the renderer-trust mark", () => {
      const contract = uiContractFromSchema(
        declaring({ helper: "UiAction", action: "Submit" }),
      );
      const event = click({ uiContractDataset: { uiAction: "Submit" } });
      expect(trustedEventMatchesUiContract(event, contract)).toBe(false);
      expect(trustedEventMatchesUiContract(marked(event), contract)).toBe(true);
    });
  });

  describe("recordTrustedEventPolicyInputs()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
    });

    afterEach(async () => {
      await runtime.dispose();
      await storageManager.close();
    });

    const write: NormalizedFullLink = {
      space,
      id: "of:cfc-ui-contract-coverage",
      scope: "space",
      path: [],
      schema: declaring({ helper: "UiAction", action: "Submit" }),
    };

    /** The trusted-event records `event` leaves for `write`. */
    const recorded = (event: unknown) => {
      const tx = runtime.edit();
      try {
        recordTrustedEventPolicyInputs(tx, [write], event, () => undefined);
        return tx.getCfcState().writePolicyInputs.filter((input) =>
          input.kind === "trusted-event"
        );
      } finally {
        tx.abort();
      }
    };

    it("records the trusted event a marked envelope carries as `$event`", () => {
      const inner = click({ uiContractDataset: { uiAction: "Submit" } });
      expect(recorded(marked({ $event: inner }))).toEqual([{
        kind: "trusted-event",
        target: { space, id: write.id, scope: "space", path: [] },
        eventId: `trusted-event:click:${write.id}:`,
        provenance: inner.provenance,
      }]);
      expect(recorded({ $event: { ...inner } })).toEqual([]);
    });

    it("records nothing for an event that is not an object", () => {
      expect(recorded("click")).toEqual([]);
    });

    it("records nothing for an event linking to a malformed data URI", () => {
      expect(recorded(marked({
        "/": {
          [LINK_V1_TAG]: {
            id: malformedDataUri,
            path: [],
            space,
          },
        },
      }))).toEqual([]);
    });
  });
});
