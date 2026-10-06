import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("runner-cfc-exact-copy");

describe("CFC exact copy claims", () => {
  const createRuntime = () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    return { runtime, storageManager };
  };

  it("preserves labels when an exact copy claim is satisfied", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-exact-copy",
        {
          type: "object",
          properties: {
            emailAddress: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
            confirmedEmail: {
              type: "string",
              ifc: { exactCopyOf: ["emailAddress"] },
            },
          },
          required: ["emailAddress", "confirmedEmail"],
        },
        tx,
      );

      cell.set({
        emailAddress: "alice@example.com",
        confirmedEmail: "alice@example.com",
      });

      tx.prepareCfc();
      const result = await tx.commit().settled;
      expect(result.ok).toBeDefined();

      const persistedId = parseLink(cell.getAsLink()).id!;
      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          value?: unknown;
          cfc?: {
            labelMap?: {
              entries: Array<{
                path: string[];
                label: {
                  confidentiality?: string[];
                  integrity?: string[];
                };
              }>;
            };
          };
        } | undefined;
      };
      const persisted = replica.getDocument(persistedId);
      expect(persisted?.value).toEqual({
        emailAddress: "alice@example.com",
        confirmedEmail: "alice@example.com",
      });
      expect(persisted?.cfc?.labelMap?.entries).toContainEqual({
        path: ["confirmedEmail"],
        label: {
          confidentiality: ["secret"],
        },
        origin: "declared",
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects an exact copy claim when the copied value changes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-exact-copy-reject",
        {
          type: "object",
          properties: {
            emailAddress: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
            confirmedEmail: {
              type: "string",
              ifc: { exactCopyOf: ["emailAddress"] },
            },
          },
          required: ["emailAddress", "confirmedEmail"],
        },
        tx,
      );

      cell.set({
        emailAddress: "alice@example.com",
        confirmedEmail: "not-alice@example.com",
      });

      tx.prepareCfc();
      const result = await tx.commit().settled;
      expect(result.error?.message).toContain("exactCopyOf failed");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
