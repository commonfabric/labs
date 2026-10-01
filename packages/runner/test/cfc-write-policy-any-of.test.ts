import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { JSONSchema, JSONSchemaObj } from "../src/builder/types.ts";
import { mergeCfcSchemaEnvelopes } from "../src/cfc/schema-merge.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
  runtimeWritePolicyAuthorization,
} from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase("write-policy-any-of");

const MODULE = "test-module";

/** The writer claim naming `writer`, stamped with `MODULE` unless `unstamped`. */
function writerClaim(writer: string, unstamped = false) {
  return {
    __ctWriterIdentityOf: {
      file: "/main.tsx",
      path: [writer],
      ...(unstamped ? {} : { moduleIdentity: MODULE }),
    },
  };
}

/** The contract of a reviewed `action` on `ReviewedSurface`. */
function contract(action: string) {
  return {
    helper: "UiAction" as const,
    action,
    trustedPattern: "ReviewedSurface",
    requiredEventIntegrity: ["ReviewedSurface"],
  };
}

/** An alternative admitting `writer` through the reviewed `action`. */
function policy(writer: string, action: string, unstamped = false) {
  return {
    writeAuthorizedBy: writerClaim(writer, unstamped),
    uiContract: contract(action),
  };
}

/** `send` through `Send`, or `edit` through `Edit`. */
const SCHEMA: JSONSchemaObj = {
  type: "string",
  ifc: { writePolicyAnyOf: [policy("send", "Send"), policy("edit", "Edit")] },
};

/**
 * A runtime over an emulated store, and a way to write one protected cell as
 * a named writer of a module (`MODULE` unless named), with or without a
 * trusted event for a reviewed action, and with or without initialization
 * evidence.
 */
function fixture() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: "enforce-explicit",
  });
  return {
    async write(
      writer: string,
      action?: string,
      options: {
        schema?: JSONSchema;
        module?: string;
        initialization?: "setup" | "default" | "seed";
        value?: string;
        recordedValue?: string;
      } = {},
    ) {
      const schema = options.schema ?? SCHEMA;
      const value = options.value ?? writer;
      const tx = runtime.edit();
      setCfcTrustSnapshot(tx, {
        id: "test-trust",
        actingPrincipal: signer.did(),
      });
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: options.module ?? MODULE,
        sourceFile: "/main.tsx",
        bindingPath: [writer],
      });
      const cell = runtime.getCell(
        signer.did(),
        "protected-value",
        schema,
        tx,
      );
      cell.set(value);
      const target = cell.getAsNormalizedFullLink();
      if (options.initialization === "setup") {
        tx.recordCfcWritePolicyInput({
          kind: "structural-provenance",
          claim: CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
          target: { ...target, id: "of:setup-result" },
          sources: [target],
        }, runtimeWritePolicyAuthorization);
      } else if (options.initialization !== undefined) {
        tx.recordCfcWritePolicyInput({
          kind: "initialization",
          mode: options.initialization,
          target,
          value: options.recordedValue ?? value,
        }, runtimeWritePolicyAuthorization);
      }
      if (action !== undefined) {
        tx.recordCfcWritePolicyInput({
          kind: "trusted-event",
          target,
          eventId: "test-event",
          provenance: {
            origin: "dom",
            trusted: true,
            ui: {
              pattern: "ReviewedSurface",
              eventIntegrity: ["ReviewedSurface"],
              uiContractDataset: { uiAction: action },
            },
          },
        });
      }
      tx.prepareCfc();
      return (await tx.commit()).error?.message;
    },
    async dispose() {
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

/** Runs `body` against a fresh fixture, disposing of it after. */
async function withFixture(
  body: (f: ReturnType<typeof fixture>) => Promise<void>,
): Promise<void> {
  const f = fixture();
  try {
    await body(f);
  } finally {
    await f.dispose();
  }
}

describe("cfc-write-policy-any-of", () => {
  describe("enforcement", () => {
    it("admits each writer through its own reviewed action, in turn", async () => {
      await withFixture(async (f) => {
        expect(await f.write("send", "Send")).toBeUndefined();
        expect(await f.write("edit", "Edit")).toBeUndefined();
        expect(await f.write("send", "Send")).toBeUndefined();
      });
    });

    for (
      const [writer, action] of [
        ["rogue", "Send"],
        ["send", "Edit"],
        ["edit", "Send"],
        ["send", undefined],
      ] as const
    ) {
      it(`refuses writer \`${writer}\` with action \`${action ?? "none"}\``, async () => {
        await withFixture(async (f) => {
          expect(await f.write(writer, action)).toContain(
            "writePolicyAnyOf failed",
          );
        });
      });
    }

    it("admits a writer whose alternative names no gesture, without an event", async () => {
      const schema: JSONSchemaObj = {
        type: "string",
        ifc: {
          writePolicyAnyOf: [policy("send", "Send"), {
            writeAuthorizedBy: writerClaim("tidy"),
          }],
        },
      };
      await withFixture(async (f) => {
        expect(await f.write("tidy", undefined, { schema })).toBeUndefined();
        expect(await f.write("send", undefined, { schema })).toContain(
          "writePolicyAnyOf failed",
        );
      });
    });

    it("enforces the stored policy on a write through a plain schema", async () => {
      await withFixture(async (f) => {
        expect(await f.write("send", "Send")).toBeUndefined();
        expect(await f.write("rogue", "Send", { schema: { type: "string" } }))
          .toContain("writePolicyAnyOf failed");
      });
    });

    it("does not waive a reviewed action for a pattern setup source", async () => {
      await withFixture(async (f) => {
        expect(await f.write("rogue", undefined, { initialization: "setup" }))
          .toContain("writePolicyAnyOf failed");
      });
    });

    it("admits an exact runtime seed, then enforces later writes", async () => {
      await withFixture(async (f) => {
        expect(
          await f.write("rogue", undefined, {
            initialization: "seed",
            value: "initial",
          }),
        ).toBeUndefined();
        expect(
          await f.write("rogue", undefined, {
            initialization: "seed",
            value: "replacement",
          }),
        ).toContain("writePolicyAnyOf failed");
        expect(await f.write("send", "Send")).toBeUndefined();
      });
    });

    it("refuses a seed whose final value differs from its evidence", async () => {
      await withFixture(async (f) => {
        expect(
          await f.write("rogue", undefined, {
            initialization: "seed",
            value: "changed",
            recordedValue: "initial",
          }),
        ).toContain("writePolicyAnyOf failed");
      });
    });
  });

  describe("module identity", () => {
    it("refuses a listed binding written from another module", async () => {
      await withFixture(async (f) => {
        expect(await f.write("send", "Send")).toBeUndefined();
        expect(await f.write("edit", "Edit", { module: "other-module" }))
          .toContain("writePolicyAnyOf failed");
        expect(
          await f.write("edit", "Edit", {
            module: "other-module",
            schema: { type: "string" },
          }),
        ).toContain("writePolicyAnyOf failed");
      });
    });

    describe("members that arrive unstamped", () => {
      const unstamped: JSONSchemaObj = {
        type: "string",
        ifc: {
          writePolicyAnyOf: [
            policy("send", "Send", true),
            policy("edit", "Edit", true),
          ],
        },
      };

      it("admits no second writer, as the stored member has no stamp", async () => {
        await withFixture(async (f) => {
          expect(await f.write("send", "Send", { schema: unstamped }))
            .toBeUndefined();
          expect(await f.write("edit", "Edit", { schema: unstamped }))
            .toContain("writePolicyAnyOf failed");
        });
      });

      it("admits no other module under an unstamped stored member", async () => {
        await withFixture(async (f) => {
          expect(await f.write("send", "Send", { schema: unstamped }))
            .toBeUndefined();
          for (const schema of [unstamped, { type: "string" } as const]) {
            expect(
              await f.write("edit", "Edit", { module: "other-module", schema }),
            ).toContain("writePolicyAnyOf failed");
          }
        });
      });

      it("stamps no member for a writer none of them names", async () => {
        await withFixture(async (f) => {
          expect(await f.write("rogue", "Send", { schema: unstamped }))
            .toContain("writePolicyAnyOf failed");
        });
      });
    });
  });

  describe("malformed declarations", () => {
    for (
      const [name, ifc] of [
        ["an empty list", { writePolicyAnyOf: [] }],
        ["an alternative with no writer", {
          writePolicyAnyOf: [{ uiContract: contract("Send") }],
        }],
        ["an alternative with another key", {
          writePolicyAnyOf: [{
            ...policy("send", "Send"),
            requiredIntegrity: [],
          }],
        }],
        ["an alternative whose contract does not parse", {
          writePolicyAnyOf: [{
            writeAuthorizedBy: writerClaim("send"),
            uiContract: { helper: "UiAction" },
          }],
        }],
        ["a writer beside the list", {
          writeAuthorizedBy: writerClaim("send"),
          writePolicyAnyOf: [policy("send", "Send")],
        }],
        ["a contract beside the list", {
          uiContract: contract("Send"),
          writePolicyAnyOf: [policy("send", "Send")],
        }],
      ] as const
    ) {
      it(`refuses a write under ${name}`, async () => {
        await withFixture(async (f) => {
          expect(
            await f.write("send", "Send", {
              schema: { type: "string", ifc } as JSONSchemaObj,
            }),
          ).toContain("malformed writePolicyAnyOf");
        });
      });
    }
  });

  describe("current-principal integrity", () => {
    const authoredBy = {
      kind: "authored-by",
      subject: { __ctCurrentPrincipal: true },
    };

    it("admits an authored-by label when every alternative names a gesture", async () => {
      const schema: JSONSchemaObj = {
        type: "string",
        ifc: { ...SCHEMA.ifc, addIntegrity: [authoredBy] },
      };
      await withFixture(async (f) => {
        expect(await f.write("edit", "Edit", { schema })).toBeUndefined();
      });
    });

    it("admits an authored-by label when an alternative names no gesture, and holds the others to theirs", async () => {
      const schema: JSONSchemaObj = {
        type: "string",
        ifc: {
          addIntegrity: [authoredBy],
          writePolicyAnyOf: [policy("send", "Send"), {
            writeAuthorizedBy: writerClaim("tidy"),
          }],
        },
      };
      await withFixture(async (f) => {
        expect(await f.write("tidy", undefined, { schema })).toBeUndefined();
        expect(await f.write("send", "Send", { schema })).toBeUndefined();
        expect(await f.write("send", undefined, { schema })).toContain(
          "writePolicyAnyOf failed",
        );
      });
    });
  });

  describe("moving between a lone writer and a list", () => {
    const lone: JSONSchemaObj = {
      type: "string",
      ifc: {
        writeAuthorizedBy: writerClaim("send"),
        uiContract: contract("Send"),
      },
    };

    it("refuses the move, and leaves the lone writer able to write", async () => {
      await withFixture(async (f) => {
        expect(await f.write("send", "Send", { schema: lone })).toBeUndefined();
        expect(await f.write("send", "Send")).toContain(
          "writePolicyAnyOf cannot join",
        );
        expect(await f.write("send", "Send", { schema: lone })).toBeUndefined();
      });
    });

    it("refuses the move back, and leaves the list's writers able to write", async () => {
      await withFixture(async (f) => {
        expect(await f.write("send", "Send")).toBeUndefined();
        expect(await f.write("send", "Send", { schema: lone })).toContain(
          "writePolicyAnyOf cannot join",
        );
        expect(await f.write("edit", "Edit")).toBeUndefined();
      });
    });
  });

  describe("merging", () => {
    it("throws when one side names a lone writer and the other a list", () => {
      expect(() =>
        mergeCfcSchemaEnvelopes(
          { type: "string", ifc: { writeAuthorizedBy: writerClaim("send") } },
          SCHEMA,
        )
      ).toThrow("writePolicyAnyOf cannot join");
    });

    it("throws when a later schema adds an alternative", () => {
      expect(() =>
        mergeCfcSchemaEnvelopes(SCHEMA, {
          type: "string",
          ifc: {
            writePolicyAnyOf: [
              ...SCHEMA.ifc!.writePolicyAnyOf!,
              policy("rogue", "Send"),
            ],
          },
        })
      ).toThrow("writePolicyAnyOf must remain stable");
    });

    it("throws when a later schema changes one writer's action", () => {
      expect(() =>
        mergeCfcSchemaEnvelopes(SCHEMA, {
          type: "string",
          ifc: {
            writePolicyAnyOf: [policy("send", "Edit"), policy("edit", "Edit")],
          },
        })
      ).toThrow("writePolicyAnyOf must remain stable");
    });

    it("returns each alternative with the stamp either side carries", () => {
      const merged = mergeCfcSchemaEnvelopes(
        {
          type: "string",
          ifc: {
            writePolicyAnyOf: [
              policy("send", "Send"),
              policy("edit", "Edit", true),
            ],
          },
        },
        {
          type: "string",
          ifc: {
            writePolicyAnyOf: [
              policy("send", "Send", true),
              policy("edit", "Edit"),
            ],
          },
        },
      ) as JSONSchemaObj;
      expect(merged.ifc?.writePolicyAnyOf).toEqual([
        policy("send", "Send"),
        policy("edit", "Edit"),
      ]);
    });
  });
});
