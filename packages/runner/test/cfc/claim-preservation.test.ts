import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { internSchema } from "@commonfabric/data-model-schema";

import type { JSONSchema } from "../../src/builder/types.ts";
import { droppedStoredClaim } from "../../src/cfc/claim-preservation.ts";
import { mergeCfcSchemaEnvelopes } from "../../src/cfc/schema-merge.ts";
import {
  acquireSchemaRegistryLease,
  registerSchemaDocument,
} from "../../src/schema-registry.ts";

const CONTRACT = { helper: "UiAction", action: "PinNote" } as const;
const PIN = { type: "string", ifc: { uiContract: CONTRACT } } as const;
const LABELED = {
  type: "string",
  ifc: { confidentiality: ["writer-clause"] },
} as const;

describe("droppedStoredClaim()", () => {
  it("returns `undefined` for a merge that keeps every claim and adds a label", () => {
    const stored = { type: "object", properties: { pin: PIN } } as const;
    const candidate = { type: "object", properties: { pin: LABELED } } as const;
    expect(
      droppedStoredClaim(stored, mergeCfcSchemaEnvelopes(stored, candidate)),
    ).toBeUndefined();
  });

  it("returns the claim and path a merged schema no longer declares", () => {
    const stored = { type: "object", properties: { pin: PIN } } as const;
    const merged = { type: "object", properties: { pin: LABELED } } as const;
    expect(droppedStoredClaim(stored, merged)).toBe(
      "the merged schema drops the stored uiContract at /pin",
    );
  });

  it("returns a claim a recursive definition loses below the level where it first recurs", () => {
    // The merged schema keeps the claim at `/node/pin` and swaps in a
    // definition without it from `/node/child` down.

    const stored = {
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: {
        Node: {
          type: "object",
          properties: { pin: PIN, child: { $ref: "#/$defs/Node" } },
        },
      },
    } as const;
    const merged = {
      type: "object",
      properties: {
        node: {
          type: "object",
          properties: { pin: PIN, child: { $ref: "#/$defs/Other" } },
        },
      },
      $defs: {
        Other: {
          type: "object",
          properties: { pin: LABELED, child: { $ref: "#/$defs/Other" } },
        },
      },
    } as const;
    expect(droppedStoredClaim(stored, merged)).toBe(
      "the merged schema drops the stored uiContract at /node/child/pin",
    );
    expect(droppedStoredClaim(stored, stored)).toBeUndefined();
  });

  it("returns a claim held in one arm of a stored `anyOf` the merged arms do not keep", () => {
    const stored = {
      type: "object",
      properties: {
        pin: { anyOf: [{ $ref: "#/$defs/Pin" }, { type: "null" }] },
      },
      $defs: { Pin: PIN },
    } as const;
    const merged = {
      type: "object",
      properties: { pin: { anyOf: [LABELED, { type: "null" }] } },
    } as const;
    expect(droppedStoredClaim(stored, merged)).toBe(
      "the merged schema drops the stored uiContract at /pin",
    );
  });

  it("returns a claim held in a `oneOf` arm beside an `anyOf` that the merged node drops", () => {
    const stored = {
      type: "object",
      properties: {
        pin: {
          anyOf: [{ type: "string" }, { type: "null" }],
          oneOf: [PIN, { type: "null" }],
        },
      },
    } as const;
    const merged = {
      type: "object",
      properties: {
        pin: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    } as const;
    expect(droppedStoredClaim(stored, merged)).toBe(
      "the merged schema drops the stored uiContract at /pin",
    );
    expect(droppedStoredClaim(stored, stored)).toBeUndefined();
  });

  it("returns a claim behind a `cid:` reference that the merged position replaces", () => {
    const release = acquireSchemaRegistryLease();
    try {
      const document = { $defs: { Pin: PIN } } as const;
      const hash = internSchema(document, true).taggedHashString;
      registerSchemaDocument(hash, document);
      const stored = {
        type: "object",
        properties: { pin: { $ref: `cid:${hash}#/$defs/Pin` } },
      } as JSONSchema;
      expect(
        droppedStoredClaim(stored, {
          type: "object",
          properties: { pin: LABELED },
        }),
      ).toBe("the merged schema drops the stored uiContract at /pin");
      expect(
        droppedStoredClaim(
          stored,
          mergeCfcSchemaEnvelopes(stored, {
            type: "object",
            properties: { pin: LABELED },
          }),
        ),
      ).toBeUndefined();
    } finally {
      release();
    }
  });

  it("returns a dropped claim for a stored reference that does not resolve", () => {
    expect(
      droppedStoredClaim({
        type: "object",
        properties: { pin: { $ref: "#/$defs/Missing" } },
      }, { type: "object", properties: { pin: PIN } }),
    ).toBe("a stored schema reference does not resolve at /pin");
  });

  describe("writer claims", () => {
    const binding = (extra: Record<string, unknown> = {}) => ({
      __ctWriterIdentityOf: { file: "/main.tsx", path: ["pin"], ...extra },
    });
    const at = (claim: unknown): JSONSchema => ({
      type: "object",
      properties: {
        pin: { type: "string", ifc: { writeAuthorizedBy: claim } },
      },
    } as JSONSchema);

    it("returns `undefined` for a binding the merge stamps for the first time or respells", () => {
      expect(
        droppedStoredClaim(
          at(binding()),
          at(binding({ file: "main.tsx", moduleIdentity: "m1" })),
        ),
      ).toBeUndefined();
    });

    it("returns the claim for a stamp the merge replaces", () => {
      expect(
        droppedStoredClaim(
          at(binding({ moduleIdentity: "m1" })),
          at(binding({ moduleIdentity: "m2" })),
        ),
      ).toBe("the merged schema drops the stored writeAuthorizedBy at /pin");
    });

    it("returns `undefined` for a builtin list that narrows and the claim for one that grows", () => {
      expect(droppedStoredClaim(at(["a", "b"]), at(["a"]))).toBeUndefined();
      expect(droppedStoredClaim(at(["a"]), at(["a", "c"]))).toBe(
        "the merged schema drops the stored writeAuthorizedBy at /pin",
      );
    });
  });

  it("returns the floor a merge lowers and `undefined` for one it raises", () => {
    const floor = (atoms: string[]): JSONSchema => ({
      type: "object",
      properties: {
        out: { type: "string", ifc: { requiredIntegrity: atoms } },
      },
    } as JSONSchema);
    expect(droppedStoredClaim(floor(["x"]), floor(["x", "y"])))
      .toBeUndefined();
    expect(droppedStoredClaim(floor(["x", "y"]), floor(["x"]))).toBe(
      "the merged schema drops the stored requiredIntegrity at /out",
    );
  });
});
