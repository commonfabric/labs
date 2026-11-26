import { expect } from "@std/expect";

import { describeOrigin, sourceOperationLabel } from "@/piece-source-labels.ts";
import type {
  PieceOriginKind,
  PieceSourceRevisionOperation,
} from "@/protocol/types.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("piece-source-labels", () => {
  describe("describeOrigin()", () => {
    it("returns the detached label and what detachment means, given no origin", () => {
      expect(describeOrigin(undefined)).toEqual({
        label: "Detached",
        detail: "This piece records no origin, so nothing supplies new code " +
          "for it. It is the only durable reference to the source it runs.",
      });
    });

    it("returns a label and a detail of its own for each kind of origin", () => {
      const expected = {
        "system": {
          label: "Deployment pattern",
          detail: "A pattern this deployment serves; a new release of the " +
            "deployment can replace it.",
        },
        "fabric-piece": {
          label: "Fabric piece",
          detail: "A stable piece in the fabric; the origin names whichever " +
            "pattern that piece currently runs.",
        },
        "fabric-pattern": {
          label: "Exact pattern",
          detail: "Content-addressed source: this origin always resolves to " +
            "the same code.",
        },
      } satisfies Record<PieceOriginKind, { label: string; detail: string }>;

      for (const [kind, description] of Object.entries(expected)) {
        expect(
          describeOrigin({ url: "cf:origin", kind: kind as PieceOriginKind }),
        ).toEqual(description);
      }
    });
  });

  describe("sourceOperationLabel()", () => {
    it("returns what each operation is called", () => {
      const expected = {
        "baseline": "Baseline",
        "create": "Created from source",
        "edit": "Direct source edit",
        "origin-update": "Source update",
        "detach": "Stopped following source",
        "revert": "Restored source version",
        "follow": "Followed source",
        "repoint": "Followed earlier source",
      } satisfies Record<PieceSourceRevisionOperation, string>;

      for (const [operation, label] of Object.entries(expected)) {
        expect(
          sourceOperationLabel(operation as PieceSourceRevisionOperation),
        ).toBe(label);
      }
    });
  });
});
