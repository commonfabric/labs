import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  declaresMemberPolicy,
  writePoliciesOf,
} from "../../src/compiled/result-policy.ts";

const claim = { __ctWriterIdentityOf: { file: "a.tsx", path: ["save"] } };

describe("result-policy", () => {
  describe("writePoliciesOf()", () => {
    it("returns `undefined` for a schema that declares no write policy", () => {
      expect(writePoliciesOf({
        type: "object",
        properties: {
          title: { type: "string", ifc: { confidentiality: ["secret"] } },
        },
      })).toBeUndefined();
    });

    it("keeps the writer claim, the UI contract and the added integrity of a node, and no other label", () => {
      const contract = { helper: "UiAction", action: "save" };
      const added = [{ kind: "authored-by", subject: "did:key:a" }];
      expect(writePoliciesOf({
        type: "object",
        properties: {
          title: {
            type: "string",
            ifc: {
              confidentiality: ["secret"],
              writeAuthorizedBy: claim,
              uiContract: contract,
              addIntegrity: added,
            },
          },
          plain: { type: "number" },
        },
      })).toEqual({
        schema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              ifc: {
                writeAuthorizedBy: claim,
                uiContract: contract,
                addIntegrity: added,
              },
            },
          },
        },
        claimed: [["title"]],
      });
    });

    it("lists a path that declares a UI contract alone, and no path below an array", () => {
      const policy = writePoliciesOf({
        type: "object",
        properties: {
          saved: {
            type: "string",
            ifc: { uiContract: { helper: "UiAction" } },
          },
          list: {
            type: "array",
            items: { type: "string", ifc: { writeAuthorizedBy: claim } },
          },
        },
      });
      expect(policy?.claimed).toEqual([["saved"]]);
      expect(policy?.schema).toMatchObject({
        properties: {
          list: { items: { ifc: { writeAuthorizedBy: claim } } },
        },
      });
    });

    it("follows a `$ref` into `$defs` of the schema", () => {
      expect(
        writePoliciesOf({
          $defs: { t0: { type: "string", ifc: { writeAuthorizedBy: claim } } },
          type: "object",
          properties: { note: { $ref: "#/$defs/t0" } },
        })?.claimed,
      ).toEqual([["note"]]);
    });
  });

  describe("declaresMemberPolicy()", () => {
    it("returns `true` for an array schema whose items declare added integrity", () => {
      expect(declaresMemberPolicy({
        type: "array",
        items: { ifc: { addIntegrity: [] } },
      })).toBe(true);
    });

    it("returns `false` for an array schema whose items declare a confidentiality alone, and for no schema", () => {
      expect(declaresMemberPolicy({
        type: "array",
        items: { ifc: { confidentiality: ["secret"] } },
      })).toBe(false);
      expect(declaresMemberPolicy(undefined)).toBe(false);
    });
  });
});
