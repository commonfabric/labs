import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { JSONSchema, JSONSchemaObj } from "../src/builder/types.ts";
import { droppedStoredClaim } from "../src/cfc/claim-preservation.ts";
import { CfcEnvelopeStabilityError } from "../src/cfc/envelope-stability-reason.ts";
import {
  mergeCfcSchemaEnvelopes,
  type WritePolicyRelease,
} from "../src/cfc/schema-merge.ts";
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
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { isEnvelopeStabilityRefusal } from "../src/storage/rejection.ts";

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

/** How a fixture's write is made, beyond the writer and its action. */
type WriteOptions = {
  schema?: JSONSchema;
  module?: string;
  initialization?: "setup" | "default" | "seed";
  value?: string;
  recordedValue?: string;
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

  /** Stages the write into `tx`. */
  const stage = (
    tx: IExtendedStorageTransaction,
    writer: string,
    action: string | undefined,
    options: WriteOptions,
  ) => {
    const schema = options.schema ?? SCHEMA;
    const value = options.value ?? writer;
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
  };

  return {
    runtime,
    async write(writer: string, action?: string, options: WriteOptions = {}) {
      const tx = runtime.edit();
      stage(tx, writer, action, options);
      tx.prepareCfc();
      return (await tx.commit().settled).error?.message;
    },

    /**
     * Makes the write through `editWithRetry`, and returns its error with
     * how many times the write was staged. `amend` sees each attempt's
     * transaction first.
     */
    async writeWithRetry(
      writer: string,
      action?: string,
      options: WriteOptions = {},
      amend?: (tx: IExtendedStorageTransaction) => void,
    ) {
      let runs = 0;
      const result = await runtime.editWithRetry((tx) => {
        runs++;
        amend?.(tx);
        stage(tx, writer, action, options);
      });
      return { runs, error: result.error };
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
        [
          "an alternative whose contract writes its event integrity as an object",
          {
            writePolicyAnyOf: [{
              writeAuthorizedBy: writerClaim("send"),
              uiContract: { ...contract("Send"), requiredEventIntegrity: {} },
            }],
          },
        ],
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

  describe("trust requirements a contract writes in a form it cannot match", () => {
    // A contract's `trustedPattern` is matched as a nonempty string, and its
    // `requiredEventIntegrity` atoms as strings, the form renderer-attested
    // event evidence takes. A requirement written otherwise refuses the
    // write, whatever the event carries, rather than being dropped.

    const UNSUPPORTED =
      "unsupported trust-sensitive claim uiContract.requiredEventIntegrity";
    const OBJECT_ATOM = {
      type: "https://commonfabric.org/cfc/atom/ConditionMatched",
      condition: "Other",
    };

    /** `contract("Send")`, with `change` applied. */
    const changed = (change: Record<string, unknown>) => ({
      ...contract("Send"),
      ...change,
    });

    for (
      const [name, change, loneRefusal, alternativeRefusal] of [
        [
          "an event-integrity atom that is not a string",
          { requiredEventIntegrity: [OBJECT_ATOM] },
          UNSUPPORTED,
          UNSUPPORTED,
        ],
        [
          "an event-integrity atom that is not a string, beside one the event carries",
          { requiredEventIntegrity: ["ReviewedSurface", OBJECT_ATOM] },
          UNSUPPORTED,
          UNSUPPORTED,
        ],
        [
          "a trusted pattern that is not a string",
          { trustedPattern: { name: "ReviewedSurface" } },
          "malformed uiContract.trustedPattern",
          "malformed writePolicyAnyOf",
        ],
        [
          "an empty trusted pattern",
          { trustedPattern: "" },
          "malformed uiContract.trustedPattern",
          "malformed writePolicyAnyOf",
        ],
      ] as const
    ) {
      it(`refuses a lone writer's write whose contract requires ${name}`, async () => {
        const schema = {
          type: "string",
          ifc: {
            writeAuthorizedBy: writerClaim("send"),
            uiContract: changed(change),
          },
        } as unknown as JSONSchemaObj;
        await withFixture(async (f) => {
          expect(await f.write("send", "Send", { schema })).toContain(
            loneRefusal,
          );
        });
      });

      it(`refuses an alternative's write whose contract requires ${name}`, async () => {
        const schema = {
          type: "string",
          ifc: {
            writePolicyAnyOf: [{
              writeAuthorizedBy: writerClaim("send"),
              uiContract: changed(change),
            }],
          },
        } as unknown as JSONSchemaObj;
        await withFixture(async (f) => {
          expect(await f.write("send", "Send", { schema })).toContain(
            alternativeRefusal,
          );
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

  describe("a candidate that changes the stored policy", () => {
    // `SCHEMA` with a third alternative, which the merge refuses over the two
    // the document stores.

    const widened: JSONSchemaObj = {
      type: "string",
      ifc: {
        writePolicyAnyOf: [
          ...SCHEMA.ifc!.writePolicyAnyOf!,
          policy("tidy", "Send"),
        ],
      },
    };

    it("is refused with `CfcCommitRefusalError` after one run of the write", async () => {
      await withFixture(async (f) => {
        expect(await f.write("send", "Send")).toBeUndefined();

        const { runs, error } = await f.writeWithRetry("send", "Send", {
          schema: widened,
        });

        expect(runs).toBe(1);
        expect(error?.name).toBe("CfcCommitRefusalError");
        expect(isEnvelopeStabilityRefusal(error)).toBe(true);
        // The token that classifies the refusal stays out of the message,
        // which is what a person sees, the source panel included.
        expect(error?.message).not.toContain("cfc-envelope-stability");
        expect(error?.message).toContain(
          "writePolicyAnyOf must remain stable",
        );
      });
    });

    it("is refused with `CfcCommitRefusalError` after one run where a candidate weakens a stored claim", async () => {
      // Not a writer policy, but the same refusal by the stored envelope: the
      // candidate's confidentiality drops the atom the stored one requires.

      const secret: JSONSchemaObj = {
        type: "string",
        ifc: { confidentiality: ["secret"] },
      };
      const other: JSONSchemaObj = {
        type: "string",
        ifc: { confidentiality: ["other"] },
      };
      await withFixture(async (f) => {
        expect(await f.write("send", undefined, { schema: secret }))
          .toBeUndefined();

        const { runs, error } = await f.writeWithRetry("send", undefined, {
          schema: other,
        });

        expect(runs).toBe(1);
        expect(error?.name).toBe("CfcCommitRefusalError");
        expect(isEnvelopeStabilityRefusal(error)).toBe(true);
        // The token that classifies the refusal stays out of the message,
        // which is what a person sees, the source panel included.
        expect(error?.message).not.toContain("cfc-envelope-stability");
        expect(error?.message).toContain("confidentiality cannot be weakened");
      });
    });

    it("is refused with the retryable name where the stored envelope does not read back", async () => {
      // The refusal is a verdict only where the stored envelope's document is
      // one the transaction holds, which the verdict confirms by reading the
      // envelope again. Each attempt here fails that read, as it fails for a
      // document absent from the transaction's view.

      await withFixture(async (f) => {
        expect(await f.write("send", "Send")).toBeUndefined();

        const { runs, error } = await f.writeWithRetry(
          "send",
          "Send",
          { schema: widened },
          (tx) => {
            const read = tx.read.bind(tx);
            tx.read = (address, options) =>
              address.path[0] === "cfc"
                ? { error: new Error("not held") } as ReturnType<typeof read>
                : read(address, options);
          },
        );

        expect(runs).toBeGreaterThan(1);
        expect(error?.name).toBe("StorageTransactionAborted");
        expect(isEnvelopeStabilityRefusal(error)).toBe(false);
        expect(error?.message).toContain(
          "writePolicyAnyOf must remain stable",
        );
      });
    });

    it("is refused with `CfcCommitRefusalError` after one run where a candidate names another lone writer", async () => {
      const lone = (writer: string): JSONSchemaObj => ({
        type: "string",
        ifc: {
          writeAuthorizedBy: writerClaim(writer),
          uiContract: contract("Send"),
        },
      });
      await withFixture(async (f) => {
        expect(await f.write("send", "Send", { schema: lone("send") }))
          .toBeUndefined();

        const { runs, error } = await f.writeWithRetry("edit", "Send", {
          schema: lone("edit"),
        });

        expect(runs).toBe(1);
        expect(error?.name).toBe("CfcCommitRefusalError");
        expect(isEnvelopeStabilityRefusal(error)).toBe(true);
        expect(error?.message).toContain(
          "writeAuthorizedBy must remain stable at /",
        );
      });
    });

    it("is not recognized as a stored envelope's refusal where the merge refuses on other grounds", async () => {
      // Moving between a lone writer and a list is refused by the merge too,
      // but not as a claim the stored envelope fixes.

      await withFixture(async (f) => {
        expect(
          await f.write("send", "Send", {
            schema: {
              type: "string",
              ifc: {
                writeAuthorizedBy: writerClaim("send"),
                uiContract: contract("Send"),
              },
            },
          }),
        ).toBeUndefined();

        const { error } = await f.writeWithRetry("send", "Send");

        expect(error?.message).toContain("writePolicyAnyOf cannot join");
        expect(isEnvelopeStabilityRefusal(error)).toBe(false);
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

    it("returns the stored alternatives in stored order for a candidate listing them in another order", () => {
      const merged = mergeCfcSchemaEnvelopes(SCHEMA, {
        type: "string",
        ifc: {
          writePolicyAnyOf: [policy("edit", "Edit"), policy("send", "Send")],
        },
      }) as JSONSchemaObj;

      expect(merged.ifc?.writePolicyAnyOf).toEqual([
        policy("send", "Send"),
        policy("edit", "Edit"),
      ]);
    });

    it("throws when a later schema drops an alternative", () => {
      expect(() =>
        mergeCfcSchemaEnvelopes(SCHEMA, {
          type: "string",
          ifc: { writePolicyAnyOf: [policy("send", "Send")] },
        })
      ).toThrow("writePolicyAnyOf must remain stable");
    });
  });

  describe("a write appending an alternative under a release marker", () => {
    // The stored policy names `send` and `edit`, of `MODULE`. Each case
    // writes under a schema appending `reply`, of the same module, through
    // `send`'s action, beside a release marker naming `MODULE`, and then has
    // `reply` write.

    const EXTENDED: JSONSchemaObj = {
      type: "string",
      ifc: {
        writePolicyAnyOf: [
          ...SCHEMA.ifc!.writePolicyAnyOf!,
          policy("reply", "Send"),
        ],
      },
    };

    /** Records the release marker over the protected cell's document. */
    const markRelease = (
      runtime: Runtime,
      tx: IExtendedStorageTransaction,
      authorized: boolean,
    ) => {
      const target = runtime.getCell(signer.did(), "protected-value")
        .getAsNormalizedFullLink();
      const input = {
        kind: "release-program" as const,
        target: {
          space: target.space,
          id: target.id,
          scope: target.scope,
          path: [],
        },
        modules: [MODULE],
      };
      if (authorized) {
        tx.recordCfcWritePolicyInput(input, runtimeWritePolicyAuthorization);
      } else {
        tx.recordCfcWritePolicyInput(input);
      }
    };

    it("stores the alternative when the runtime records the marker, and its writer then writes", async () => {
      await withFixture(async (f) => {
        expect(await f.write("send", "Send")).toBeUndefined();
        const { error } = await f.writeWithRetry(
          "send",
          "Send",
          { schema: EXTENDED },
          (tx) => markRelease(f.runtime, tx, true),
        );
        expect(error).toBeUndefined();

        expect(
          await f.write("reply", "Send", { schema: EXTENDED, value: "again" }),
        ).toBeUndefined();
      });
    });

    it("refuses the write when the marker is recorded without the runtime's authorization", async () => {
      await withFixture(async (f) => {
        expect(await f.write("send", "Send")).toBeUndefined();
        const { error } = await f.writeWithRetry(
          "send",
          "Send",
          { schema: EXTENDED },
          (tx) => markRelease(f.runtime, tx, false),
        );

        expect(error?.message).toContain(
          "writePolicyAnyOf must remain stable",
        );
        expect(await f.write("reply", "Send", { value: "again" })).toContain(
          "writePolicyAnyOf",
        );
      });
    });
  });

  describe("a release appending alternatives", () => {
    // The stored policy's writers are of the module `old`, which the release
    // succeeds with `new`, the module it installs. `other` is installed too,
    // and succeeds nothing.

    const RELEASE: WritePolicyRelease = {
      installs: (module) => module === "new" || module === "other",
      succeeds: (successor, predecessor) =>
        successor === "new" && predecessor === "old",
    };

    /** An alternative admitting `writer` of `module` through `action`. */
    function alternative(
      writer: string,
      action: string | undefined,
      module: string | undefined,
    ) {
      return {
        writeAuthorizedBy: {
          __ctWriterIdentityOf: {
            file: "/records.tsx",
            path: [writer],
            ...(module === undefined ? {} : { moduleIdentity: module }),
          },
        },
        ...(action === undefined ? {} : { uiContract: contract(action) }),
      };
    }

    /** A schema whose one position holds `alternatives`. */
    function schemaOf(alternatives: unknown[]): JSONSchemaObj {
      return {
        type: "string",
        ifc: { writePolicyAnyOf: alternatives },
      } as JSONSchemaObj;
    }

    const STORED = [
      alternative("send", "Send", "old"),
      alternative("edit", "Edit", "old"),
    ];

    /** The candidate restating the stored alternatives, then `added`. */
    function candidateAdding(...added: unknown[]): JSONSchemaObj {
      return schemaOf([
        alternative("edit", "Edit", "new"),
        ...added,
        alternative("send", "Send", "new"),
      ]);
    }

    /**
     * What merging `candidate` over the stored policy returns, as part of
     * `release`, or of no release where it is `null`.
     */
    function merge(
      candidate: JSONSchemaObj,
      release: WritePolicyRelease | null = RELEASE,
    ) {
      return mergeCfcSchemaEnvelopes(schemaOf(STORED), candidate, {
        ...(release === null ? {} : { writePolicyRelease: release }),
      }) as JSONSchemaObj;
    }

    /**
     * What the keep rule says of `merged` against the stored policy, as part
     * of `release`, or of no release where it is `null`.
     */
    function kept(
      merged: unknown[],
      release: WritePolicyRelease | null = RELEASE,
    ) {
      return droppedStoredClaim(
        schemaOf(STORED),
        schemaOf(merged),
        undefined,
        release ?? undefined,
      );
    }

    describe("the merge", () => {
      it("returns the stored alternatives as stored, in stored order, and the appended one after them", () => {
        const merged = merge(
          candidateAdding(alternative("reply", "Send", "new")),
        );

        expect(merged.ifc?.writePolicyAnyOf).toEqual([
          ...STORED,
          alternative("reply", "Send", "new"),
        ]);
      });

      it("returns an alternative appended from the stored alternatives' own module", () => {
        const merged = mergeCfcSchemaEnvelopes(
          schemaOf(STORED),
          schemaOf([...STORED, alternative("reply", "Send", "old")]),
          {
            writePolicyRelease: {
              installs: (module) => module === "old",
              succeeds: () => false,
            },
          },
        ) as JSONSchemaObj;

        expect(merged.ifc?.writePolicyAnyOf).toEqual([
          ...STORED,
          alternative("reply", "Send", "old"),
        ]);
      });

      it("throws for an appended alternative outside a release", () => {
        expect(() =>
          merge(candidateAdding(alternative("reply", "Send", "new")), null)
        ).toThrow(CfcEnvelopeStabilityError);
      });

      it("throws for an appended alternative of a module the release does not install", () => {
        expect(() =>
          merge(candidateAdding(alternative("reply", "Send", "new")), {
            ...RELEASE,
            installs: (module) => module === "other",
          })
        ).toThrow(CfcEnvelopeStabilityError);
      });

      it("throws for an appended alternative of an installed module no stored alternative's lineage includes", () => {
        expect(() =>
          merge(candidateAdding(alternative("reply", "Send", "other")))
        ).toThrow(CfcEnvelopeStabilityError);
      });

      it("throws for an appended alternative whose writer carries no stamp", () => {
        expect(() =>
          merge(candidateAdding(alternative("reply", "Send", undefined)))
        ).toThrow(CfcEnvelopeStabilityError);
      });

      it("throws for an appended alternative naming a contract no stored alternative names", () => {
        expect(() =>
          merge(candidateAdding(alternative("reply", "Delete", "new")))
        ).toThrow(CfcEnvelopeStabilityError);
      });

      it("throws for an appended alternative naming no contract beside stored alternatives that all name one", () => {
        expect(() =>
          merge(candidateAdding(alternative("reply", undefined, "new")))
        ).toThrow(CfcEnvelopeStabilityError);
      });

      it("throws for an appended alternative carrying a key no stored alternative carries", () => {
        expect(() =>
          merge(
            candidateAdding({
              ...alternative("reply", "Send", "new"),
              intent: "reply",
            }),
          )
        ).toThrow(CfcEnvelopeStabilityError);
      });

      it("throws for a candidate that drops a stored alternative while appending one", () => {
        expect(() =>
          merge(
            schemaOf([
              alternative("send", "Send", "new"),
              alternative("reply", "Send", "new"),
            ]),
          )
        ).toThrow("the candidate drops a stored alternative");
      });

      describe("an artifact pairing taken from two stored alternatives", () => {
        // `send` is of `a` and `edit` of `b`. The appended alternative is of
        // `a2`, which succeeds `a` alone, and names `edit`'s contract: its
        // artifact holds authority only on `Send`, and its contract only
        // `b`'s lineage pairs.

        const CROSSED_STORED = [
          alternative("send", "Send", "a"),
          alternative("edit", "Edit", "b"),
        ];

        /** What the release says when `a2` succeeds each of `predecessors`. */
        function releaseSucceeding(
          ...predecessors: string[]
        ): WritePolicyRelease {
          return {
            installs: (module) => module === "a2",
            succeeds: (successor, predecessor) =>
              successor === "a2" && predecessors.includes(predecessor),
          };
        }

        const CROSSED = schemaOf([
          ...CROSSED_STORED,
          alternative("amend", "Edit", "a2"),
        ]);

        it("throws", () => {
          expect(() =>
            mergeCfcSchemaEnvelopes(schemaOf(CROSSED_STORED), CROSSED, {
              writePolicyRelease: releaseSucceeding("a"),
            })
          ).toThrow(CfcEnvelopeStabilityError);
        });

        it("returns the appended alternative where its artifact succeeds the one the contract is paired with", () => {
          const merged = mergeCfcSchemaEnvelopes(
            schemaOf(CROSSED_STORED),
            CROSSED,
            { writePolicyRelease: releaseSucceeding("b") },
          ) as JSONSchemaObj;

          expect(merged.ifc?.writePolicyAnyOf).toEqual(
            CROSSED.ifc?.writePolicyAnyOf,
          );
        });

        it("refuses the same pairing in the keep rule", () => {
          expect(
            droppedStoredClaim(
              schemaOf(CROSSED_STORED),
              CROSSED,
              undefined,
              releaseSucceeding("a"),
            ),
          ).toContain("writePolicyAnyOf");
          expect(
            droppedStoredClaim(
              schemaOf(CROSSED_STORED),
              CROSSED,
              undefined,
              releaseSucceeding("b"),
            ),
          ).toBeUndefined();
        });
      });
    });

    describe("the keep rule", () => {
      it("returns `undefined` for the stored alternatives and one a stored alternative admits", () => {
        expect(kept([...STORED, alternative("reply", "Send", "new")]))
          .toBeUndefined();
      });

      it("returns `undefined` for the stored alternatives in another order", () => {
        expect(kept([STORED[1], STORED[0]], null)).toBeUndefined();
      });

      it("returns a refusal for an appended alternative outside a release", () => {
        expect(
          kept([...STORED, alternative("reply", "Send", "new")], null),
        ).toContain("writePolicyAnyOf");
      });

      it("returns a refusal for an appended alternative of a module the release does not install", () => {
        expect(
          kept([...STORED, alternative("reply", "Send", "new")], {
            ...RELEASE,
            installs: (module) => module === "other",
          }),
        ).toContain("writePolicyAnyOf");
      });

      it("returns a refusal for an appended alternative of an installed module no stored alternative's lineage includes", () => {
        expect(kept([...STORED, alternative("reply", "Send", "other")]))
          .toContain("writePolicyAnyOf");
      });

      it("returns a refusal for an appended alternative whose writer carries no stamp", () => {
        expect(kept([...STORED, alternative("reply", "Send", undefined)]))
          .toContain("writePolicyAnyOf");
      });

      it("returns a refusal for an appended alternative naming a contract no stored alternative names", () => {
        expect(kept([...STORED, alternative("reply", "Delete", "new")]))
          .toContain("writePolicyAnyOf");
      });

      it("returns a refusal for an appended alternative naming no contract beside stored alternatives that all name one", () => {
        expect(kept([...STORED, alternative("reply", undefined, "new")]))
          .toContain("writePolicyAnyOf");
      });

      it("returns a refusal for an appended alternative carrying a key no stored alternative carries", () => {
        expect(
          kept([
            ...STORED,
            { ...alternative("reply", "Send", "new"), intent: "reply" },
          ]),
        ).toContain("writePolicyAnyOf");
      });

      it("returns a refusal for a merged policy that drops a stored alternative", () => {
        expect(kept([STORED[0], alternative("reply", "Send", "new")]))
          .toContain("drops the stored writePolicyAnyOf");
      });
    });
  });
});
