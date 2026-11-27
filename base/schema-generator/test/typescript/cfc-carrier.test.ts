import { expect } from "@std/expect";
import ts from "typescript";

import {
  carrierStamps,
  isCfcCarrierMember,
} from "../../src/typescript/cfc-carrier.ts";
import { createTestProgram } from "../utils.ts";
import { describe, it } from "@commonfabric/test-support/test";

const DECLARATIONS = `
  type CfcStamp<T, Meta> = { readonly meta?: Meta; readonly of?: T };
  type CfcTag<T, Meta, Stamp = CfcStamp<T, Meta>> = [T] extends [unknown]
    ? { readonly __ct_cfc__?: Stamp } | Extract<T, null | undefined>
    : { readonly __ct_cfc__?: Stamp } | Extract<T, null | undefined>;
  type OtherTag<T> = [T] extends [unknown] ? { readonly other?: T } : never;
  namespace Authored {
    // An author's alias of the tag's name whose branch carries a payload
    // field beside the carrier member.
    export type CfcTag<T> = [T] extends [unknown]
      ? { readonly __ct_cfc__?: unknown; readonly payload: T }
      : { readonly __ct_cfc__?: unknown; readonly payload: T };
  }
  namespace Bare {
    // An author's alias of the tag's name whose branch holds the payload
    // itself beside the carrier member.
    export type CfcTag<T> = [T] extends [unknown]
      ? { readonly __ct_cfc__?: unknown } | T
      : { readonly __ct_cfc__?: unknown } | T;
  }
  interface Probes<T, S extends { readonly meta?: "secret" } = never> {
    bare: Bare.CfcTag<T>;
    constrained: S;
    label: "secret";
    labels: "secret" | "public";
    stamp: { readonly meta?: "secret"; readonly of?: number };
    deferred: CfcTag<T, { confidentiality: ["x"] }>;
    other: OtherTag<T>;
    authored: Authored.CfcTag<T>;
    carrier: { readonly __ct_cfc__?: { readonly meta?: ["x"] } };
    beside: { readonly __ct_cfc__?: unknown; readonly name: string };
  }
`;

/**
 * The type of each member of `Probes<T, S>`, read while `T` and `S` are
 * parameters.
 */
async function probes(): Promise<Map<string, ts.Type>> {
  return (await probesAndChecker()).types;
}

/** `probes()`, and the checker the types belong to. */
async function probesAndChecker() {
  const { checker, sourceFile } = await createTestProgram(DECLARATIONS);
  const probe = sourceFile.statements.find((statement) =>
    ts.isInterfaceDeclaration(statement) && statement.name.text === "Probes"
  ) as ts.InterfaceDeclaration;
  const types = new Map(
    probe.members.filter(ts.isPropertySignature).map((member) => [
      (member.name as ts.Identifier).text,
      checker.getTypeFromTypeNode(member.type!),
    ]),
  );
  return { checker, types };
}

describe("cfc-carrier", () => {
  describe("isCfcCarrierMember", () => {
    it("returns `true` for the carrier member and for the `CfcTag` the checker defers", async () => {
      const types = await probes();

      expect(isCfcCarrierMember(types.get("carrier")!)).toBe(true);
      expect(isCfcCarrierMember(types.get("deferred")!)).toBe(true);
    });

    it("returns `false` for another deferred conditional and for an object holding more than the carrier", async () => {
      const types = await probes();

      expect(isCfcCarrierMember(types.get("other")!)).toBe(false);
      expect(isCfcCarrierMember(types.get("beside")!)).toBe(false);
    });

    it("returns `false` for an alias of the tag's name whose branch holds a payload field", async () => {
      expect(isCfcCarrierMember((await probes()).get("authored")!)).toBe(
        false,
      );
    });

    it("returns `false` for an alias of the tag's name whose branch holds the payload beside the carrier", async () => {
      expect(isCfcCarrierMember((await probes()).get("bare")!)).toBe(false);
    });
  });

  describe("carrierStamps", () => {
    // A stamp holds checker types, which `expect` takes too long to print in
    // a failure, so the cases compare them by identity as booleans.

    it("returns a label that is no object as a policy's metadata, with no payload", async () => {
      const { checker, types } = await probesAndChecker();
      const label = types.get("label")!;
      const labels = types.get("labels")!;

      for (const value of [label, labels]) {
        const stamps = carrierStamps(value, checker);

        expect(stamps.length).toBe(1);
        expect(stamps[0]!.meta === value).toBe(true);
        expect(stamps[0]!.of === undefined).toBe(true);
      }
    });

    it("returns a type parameter constrained to a stamp as a policy's metadata, whole", async () => {
      const { checker, types } = await probesAndChecker();
      const parameter = types.get("constrained")!;
      const stamps = carrierStamps(parameter, checker);

      expect(stamps.length).toBe(1);
      expect(stamps[0]!.meta === parameter).toBe(true);
      expect(stamps[0]!.of === undefined).toBe(true);
    });

    it("returns a stamp's metadata and payload apart", async () => {
      const { checker, types } = await probesAndChecker();
      const [stamp] = carrierStamps(types.get("stamp")!, checker);

      expect(checker.typeToString(stamp!.meta)).toBe('"secret"');
      expect(checker.typeToString(stamp!.of!)).toBe("number");
    });
  });
});
