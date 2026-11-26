import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { describe, it } from "@commonfabric/test-support/test";

import type { JSONSchema } from "../src/builder/types.ts";
import type { CfcEnforcementMode } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../src/storage/extended-storage-transaction.ts";

const alice = await Identity.fromPassphrase(
  "runner-cfc-prepare-cov-link-principal-floor",
);
const space = alice.did();

const CURRENT_PRINCIPAL = { __ctCurrentPrincipal: true };

const UI_CONTRACT = {
  helper: "UiAction",
  action: "EditProfile",
  trustedPattern: "ProfileHome",
  requiredEventIntegrity: ["ProfileHome"],
};

// A profile whose `name` its owner attests through the runtime placeholder,
// written by one writer on one click.
const SOURCE_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      ifc: {
        addIntegrity: [{
          kind: "represents-principal",
          subject: CURRENT_PRINCIPAL,
        }],
        ownerPrincipal: CURRENT_PRINCIPAL,
        writeAuthorizedBy: {
          __ctWriterIdentityOf: { file: "/profile.tsx", path: ["writeName"] },
        },
        uiContract: UI_CONTRACT,
      },
    },
    nickname: { type: "string" },
  },
} as JSONSchema;

// A document whose `owner` slot takes only a value that represents Alice.
const TARGET_SCHEMA = {
  type: "object",
  properties: {
    owner: {
      type: "string",
      ifc: {
        requiredIntegrity: [{ kind: "represents-principal", subject: space }],
      },
    },
  },
  required: ["owner"],
} as JSONSchema;

describe("prepare", () => {
  // In one transaction, Alice's writer sets her profile to `profile`, on a
  // trusted click where `clicked` says so, and links its name into a floored
  // slot of another document, with the runtime at `mode` and the write floor
  // enforced. Returns the reasons the preparation refused it for.
  const linkPendingClaim = async (
    mode: CfcEnforcementMode,
    clicked: boolean,
    profile: Record<string, string> = { name: "Ada" },
  ) => {
    const storageManager = StorageManager.emulate({ as: alice });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: mode,
      cfcWriteFloor: "enforce",
    });
    try {
      const tx = runtime.edit();
      setCfcTrustSnapshot(tx, { id: `trust-${space}`, actingPrincipal: space });
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: "profile-module",
        sourceFile: "/profile.tsx",
        bindingPath: ["writeName"],
      });
      const source = runtime.getCell(space, "profile", SOURCE_SCHEMA, tx);
      source.set(profile as never);
      const sourceLink = source.getAsNormalizedFullLink();
      if (clicked) {
        tx.recordCfcWritePolicyInput({
          kind: "trusted-event",
          target: { ...sourceLink, path: ["name"] },
          eventId: "trusted-name-edit",
          provenance: {
            origin: "dom",
            trusted: true,
            ui: {
              pattern: "ProfileHome",
              eventIntegrity: ["ProfileHome"],
              uiContractDataset: { uiAction: "EditProfile" },
            },
          },
        });
      }
      runtime.getCell(space, "owned", TARGET_SCHEMA, tx).set(
        { owner: source.key("name") } as never,
      );
      tx.prepareCfc();
      const prepared = tx.getCfcState().prepare;
      tx.abort();
      return prepared.status === "invalidated" ? prepared.reasons : [];
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  };

  describe("a link to a source this transaction writes", () => {
    // The source's schema claims Alice represents its name. The claim
    // credits the floor only where the source's own schema check passes.

    it("credits a floor with the claim where the source's check passes under enforcement", async () => {
      expect(await linkPendingClaim("enforce-strict", true)).toEqual([]);
    });

    it("credits a floor with the claim where the source's check passes under `observe`", async () => {
      expect(await linkPendingClaim("observe", true)).toEqual([]);
    });

    it("credits no floor with the claim where the source's check fails under `observe`", async () => {
      expect(await linkPendingClaim("observe", false)).toEqual([
        expect.stringContaining("missing trusted-event policy input"),
        expect.stringContaining("write floor failed at /owner"),
      ]);
    });

    it("credits no floor with the claim where the source's write leaves the claimed field absent", async () => {
      expect(
        await linkPendingClaim("enforce-strict", true, { nickname: "A" }),
      ).toEqual([expect.stringContaining("write floor failed at /owner")]);
    });
  });
});
