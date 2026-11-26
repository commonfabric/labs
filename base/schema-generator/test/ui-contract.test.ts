import { expect } from "@std/expect";
import { describe, it } from "@commonfabric/test-support/test";
import { attachUiContract } from "../src/ui-contract.ts";
import type { UiContractHint } from "../src/interface.ts";

const HINT: UiContractHint = { helper: "UiAction", action: "send" };

describe("ui-contract", () => {
  describe("attachUiContract()", () => {
    it("returns a schema that rejects everything, carrying the contract, for a `false` schema", () => {
      expect(attachUiContract(false, HINT)).toEqual({
        not: true,
        ifc: { uiContract: { helper: "UiAction", action: "send" } },
      });
    });

    it("returns a schema that accepts everything, carrying the contract, for a `true` schema", () => {
      expect(attachUiContract(true, HINT)).toEqual({
        ifc: { uiContract: { helper: "UiAction", action: "send" } },
      });
    });

    it("returns a copy of the hint's integrity list, not the list itself", () => {
      const required = ["trusted-click"];
      const schema = attachUiContract({ type: "object", ifc: {} }, {
        ...HINT,
        requiredEventIntegrity: required,
      });

      const emitted = typeof schema === "object"
        ? schema.ifc?.uiContract?.requiredEventIntegrity
        : undefined;
      expect(emitted).toEqual(["trusted-click"]);
      expect(emitted).not.toBe(required);
    });
  });
});
