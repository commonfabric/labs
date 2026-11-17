import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/api";
import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import type { JSONSchema, JSONSchemaObj } from "../src/builder/types.ts";
import { droppedStoredClaim } from "../src/cfc/claim-preservation.ts";
import { CfcEnvelopeStabilityError } from "../src/cfc/envelope-stability-reason.ts";
import {
  loadStoredCfcEnvelope,
  storedCfcEnvelopeMergeIssue,
} from "../src/cfc/prepare.ts";
import { cfcSchemaEntries } from "../src/cfc/schema-label-view.ts";
import {
  ifcDiffersOnlyByReleaseAppend,
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
  value?: FabricValue;
  recordedValue?: FabricValue;

  /**
   * Where `schema` applies: to the document itself, or to its `tag` field,
   * which the write then sets.
   */
  at?: "document" | "tag";

  /**
   * Whether the write puts a link to a document holding the value, rather than
   * the value itself.
   */
  link?: boolean;
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
    const cell = options.at === "tag"
      ? runtime.getCell<{ tag: unknown }>(
        signer.did(),
        "protected-value",
        { type: "object", properties: { tag: schema } },
        tx,
      ).key("tag")
      : runtime.getCell<unknown>(signer.did(), "protected-value", schema, tx);
    if (options.link === true) {
      const source = runtime.getCell<FabricValue>(
        signer.did(),
        "linked-value",
        { type: "string" },
        tx,
      );
      source.set(value);
      cell.set(source);
    } else {
      cell.set(value);
    }
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

/** A write-policy alternative: its writer claim, its contract, and the rest. */
type Alternative = {
  writeAuthorizedBy: { __ctWriterIdentityOf: Record<string, unknown> };
  [key: string]: unknown;
};

/** `alternative` with its writer's binding as `change` makes it. */
function rebound(
  alternative: Alternative,
  change: (binding: Record<string, unknown>) => Record<string, unknown>,
): Alternative {
  return {
    ...alternative,
    writeAuthorizedBy: {
      ...alternative.writeAuthorizedBy,
      __ctWriterIdentityOf: change({
        ...alternative.writeAuthorizedBy.__ctWriterIdentityOf,
      }),
    },
  };
}

/**
 * Ways an appended alternative can differ from the stored alternative it pairs
 * with, each made to an alternative that differs from that one only in the
 * symbol its writer binds, and whether a release may append the result. Only
 * the symbol and the file its stamped writer claim spells may differ.
 */
const APPENDED_VARIANTS: readonly {
  name: string;
  admitted: boolean;
  vary: (paired: Alternative) => Alternative;
}[] = [
  // The symbol is what makes the alternative an appended writer: refusing a
  // change to it would refuse every append.
  { name: "a writer binding another symbol", admitted: true, vary: (a) => a },
  // A stamped claim's file is a spelling, which depends on the resolver that
  // compiled the module, and the stamp already names the module by its
  // content. Two stamped claims reconcile whatever their files spell, as
  // `reconcileWriterClaimStamp()` in `schema-merge.ts` states, and a writer is
  // authorized by its module and binding path alone (`prepare.ts`).
  {
    name: "a writer naming another file",
    admitted: true,
    vary: (a) => rebound(a, (b) => ({ ...b, file: "/elsewhere.tsx" })),
  },
  {
    name: "a key beside the writer's binding's own",
    admitted: false,
    vary: (a) => rebound(a, (b) => ({ ...b, extra: true })),
  },
  {
    name: "a legacy stamp beside the writer's module identity",
    admitted: false,
    vary: (a) => rebound(a, (b) => ({ ...b, bundleId: "legacy" })),
  },
  {
    name: "a writer's binding without its file",
    admitted: false,
    vary: (a) => rebound(a, ({ file: _file, ...b }) => b),
  },
  {
    name: "a writer's file that is not a string",
    admitted: false,
    vary: (a) => rebound(a, (b) => ({ ...b, file: 7 })),
  },
  {
    name: "a writer's binding without its module identity",
    admitted: false,
    vary: (a) => rebound(a, ({ moduleIdentity: _module, ...b }) => b),
  },
  {
    name: "a writer's path that is not a list",
    admitted: false,
    vary: (a) => rebound(a, (b) => ({ ...b, path: "reply" })),
  },
  {
    name: "an empty writer's path",
    admitted: false,
    vary: (a) => rebound(a, (b) => ({ ...b, path: [] })),
  },
  {
    name: "a writer's path holding a name that is not a string",
    admitted: false,
    vary: (a) => rebound(a, (b) => ({ ...b, path: ["reply", 1] })),
  },
  {
    name: "a key beside the writer claim's binding",
    admitted: false,
    vary: (a) => ({
      ...a,
      writeAuthorizedBy: { ...a.writeAuthorizedBy, extra: true },
    }),
  },
  {
    name: "a key beside the alternative's own",
    admitted: false,
    vary: (a) => ({ ...a, intent: "reply" }),
  },
  {
    name: "a contract no stored alternative names",
    admitted: false,
    vary: (a) => ({ ...a, uiContract: contract("Archive") }),
  },
  {
    name: "no contract",
    admitted: false,
    vary: ({ uiContract: _contract, ...a }) => a as Alternative,
  },
];

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

/**
 * A document holding `send`'s `note` beside a `tag` whose write policy is
 * `alternatives`, so that a write of the note leaves the tag's position
 * untouched.
 */
function noteBesideTag(alternatives: readonly unknown[]): JSONSchemaObj {
  return {
    type: "object",
    properties: {
      note: { type: "string", ifc: { writeAuthorizedBy: writerClaim("send") } },
      tag: { type: "string", ifc: { writePolicyAnyOf: alternatives } },
    },
  } as JSONSchemaObj;
}

/**
 * The alternatives of the write policy the document `id` stores at the logical
 * path `path`, each as its writer and the action its contract names, joined by
 * a slash, and where `stamped`, the module its writer is stamped with after an
 * at sign, in stored order.
 */
function storedAlternatives(
  runtime: Runtime,
  id = "protected-value",
  path: readonly string[] = [],
  stamped = false,
): string[] {
  const tx = runtime.edit();
  try {
    const stored = loadStoredCfcEnvelope(
      tx,
      runtime.getCell(signer.did(), id).getAsNormalizedFullLink(),
    );
    if (stored.status !== "loaded") {
      throw new Error(`No stored envelope: ${stored.status}`);
    }
    const entry = cfcSchemaEntries(stored.schema).find((entry) =>
      entry.path.join("/") === path.join("/")
    );
    const alternatives =
      (entry?.schema as JSONSchemaObj | undefined)?.ifc?.writePolicyAnyOf ?? [];
    return (alternatives as Alternative[]).map((alternative) => {
      const binding = alternative.writeAuthorizedBy.__ctWriterIdentityOf;
      const name = `${(binding.path as string[]).join(".")}/${
        (alternative.uiContract as { action?: string })?.action
      }`;
      return stamped
        ? `${name}@${binding.moduleIdentity ?? "unstamped"}`
        : name;
    });
  } finally {
    tx.abort("stored policy read");
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

      it("commits a write omitting an unstamped alternative, which stays unstamped and admits no writer", async () => {
        await withFixture(async (f) => {
          expect(await f.write("send", "Send", { schema: unstamped }))
            .toBeUndefined();
          expect(
            storedAlternatives(f.runtime, "protected-value", [], true),
          ).toEqual(["send/Send@test-module", "edit/Edit@unstamped"]);

          expect(
            await f.write("send", "Send", {
              schema: {
                type: "string",
                ifc: { writePolicyAnyOf: [policy("send", "Send")] },
              },
              value: "again",
            }),
          ).toBeUndefined();
          expect(
            storedAlternatives(f.runtime, "protected-value", [], true),
          ).toEqual(["send/Send@test-module", "edit/Edit@unstamped"]);
          expect(await f.write("edit", "Edit")).toContain(
            "writePolicyAnyOf failed",
          );
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

  describe("an unstamped claim another writer's write restates stamped, outside a release", () => {
    // TODO(danfuzz): These pin an adoption the proposal refuses: outside a
    // release, only the writer a stamp names may bring that stamp over an
    // unstamped claim naming it, and here `send`'s write stamps `edit`'s
    // claim, as an alternative of a write policy and as a lone claim alike.
    // Each schema restates the claim in a shape the stored envelope does not
    // cover, so that the merge runs. Flip them when the merge adopts only as
    // the proposal allows (see the `TODO` in `reconcileWriterClaimStamp()`).

    it("adopts the stamp for an alternative, and its writer then writes", async () => {
      await withFixture(async (f) => {
        const unstamped: JSONSchemaObj = {
          type: "string",
          ifc: {
            writePolicyAnyOf: [
              policy("send", "Send", true),
              policy("edit", "Edit", true),
            ],
          },
        };
        expect(await f.write("send", "Send", { schema: unstamped }))
          .toBeUndefined();

        expect(
          await f.write("send", "Send", {
            schema: {
              type: "string",
              ifc: {
                writePolicyAnyOf: [
                  policy("edit", "Edit"),
                  policy("send", "Send"),
                ],
              },
            },
            value: "again",
          }),
        ).toBeUndefined();
        expect(
          storedAlternatives(f.runtime, "protected-value", [], true),
        ).toEqual(["send/Send@test-module", "edit/Edit@test-module"]);
        expect(await f.write("edit", "Edit", { value: "edited" }))
          .toBeUndefined();
      });
    });

    it("adopts the stamp for a lone claim", async () => {
      await withFixture(async (f) => {
        /** `send`'s `note` beside `edit`'s `tag`, described by `tagNote`. */
        const schema = (edit: unknown, tagNote?: string): JSONSchemaObj => ({
          type: "object",
          properties: {
            note: {
              type: "string",
              ifc: { writeAuthorizedBy: writerClaim("send") },
            },
            tag: {
              type: "string",
              ...(tagNote === undefined ? {} : { description: tagNote }),
              ifc: { writeAuthorizedBy: edit },
            },
          } as JSONSchemaObj["properties"],
        });
        const tagClaim = () => {
          const tx = f.runtime.edit();
          try {
            const stored = loadStoredCfcEnvelope(
              tx,
              f.runtime.getCell(signer.did(), "protected-value")
                .getAsNormalizedFullLink(),
            );
            if (stored.status !== "loaded") {
              throw new Error(`No stored envelope: ${stored.status}`);
            }
            return (cfcSchemaEntries(stored.schema).find((entry) =>
              entry.path.join("/") === "tag"
            )?.schema as JSONSchemaObj | undefined)?.ifc?.writeAuthorizedBy;
          } finally {
            tx.abort("stored claim read");
          }
        };
        expect(
          await f.write("send", undefined, {
            schema: schema(writerClaim("edit", true)),
            value: { note: "first" },
          }),
        ).toBeUndefined();
        expect(tagClaim()).toEqual(writerClaim("edit", true));

        expect(
          await f.write("send", undefined, {
            schema: schema(writerClaim("edit"), "restated"),
            value: { note: "again" },
          }),
        ).toBeUndefined();
        expect(tagClaim()).toEqual(writerClaim("edit"));
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

  describe("a write whose schema omits a stored alternative", () => {
    // The document stores `SCHEMA`'s two alternatives, `send` through `Send`
    // and `edit` through `Edit`, and each case writes under a schema that
    // lists fewer. The merge keeps every stored alternative, so none of these
    // writes can widen who may write; each case pins what commits and what
    // the document then stores.

    /** `send` through `Send` alone, which retires `edit`. */
    const NARROWED: JSONSchemaObj = {
      type: "string",
      ifc: { writePolicyAnyOf: [policy("send", "Send")] },
    };

    it("commits a listed writer's write, and stores both alternatives", async () => {
      await withFixture(async (f) => {
        expect(await f.write("send", "Send")).toBeUndefined();

        expect(
          await f.write("send", "Send", { schema: NARROWED, value: "again" }),
        ).toBeUndefined();
        expect(storedAlternatives(f.runtime)).toEqual([
          "send/Send",
          "edit/Edit",
        ]);
      });
    });

    it("leaves the omitted writer able to write, under a schema listing it", async () => {
      await withFixture(async (f) => {
        expect(await f.write("send", "Send")).toBeUndefined();
        expect(
          await f.write("send", "Send", { schema: NARROWED, value: "again" }),
        ).toBeUndefined();

        expect(await f.write("edit", "Edit", { value: "edited" }))
          .toBeUndefined();
      });
    });

    it("refuses the omitted writer's write under the schema omitting it", async () => {
      await withFixture(async (f) => {
        expect(await f.write("send", "Send")).toBeUndefined();

        expect(await f.write("edit", "Edit", { schema: NARROWED })).toContain(
          "writePolicyAnyOf failed at /",
        );
      });
    });

    it("refuses a write listing an alternative the document does not store", async () => {
      await withFixture(async (f) => {
        expect(await f.write("send", "Send")).toBeUndefined();

        expect(
          await f.write("send", "Send", {
            schema: {
              type: "string",
              ifc: {
                writePolicyAnyOf: [
                  policy("send", "Send"),
                  policy("tidy", "Send"),
                ],
              },
            },
          }),
        ).toContain("the candidate adds an alternative outside a release");
        expect(storedAlternatives(f.runtime)).toEqual([
          "send/Send",
          "edit/Edit",
        ]);
      });
    });

    it("refuses a write moving a listed writer onto the omitted writer's action", async () => {
      await withFixture(async (f) => {
        expect(await f.write("send", "Send")).toBeUndefined();

        expect(
          await f.write("send", "Edit", {
            schema: {
              type: "string",
              ifc: { writePolicyAnyOf: [policy("send", "Edit")] },
            },
          }),
        ).toContain("the candidate adds an alternative outside a release");
      });
    });

    it("refuses another module's write under the schema omitting it", async () => {
      await withFixture(async (f) => {
        expect(await f.write("send", "Send")).toBeUndefined();

        expect(
          await f.write("send", "Send", {
            schema: NARROWED,
            module: "other-module",
          }),
        ).toContain("writePolicyAnyOf failed at /");
      });
    });

    it("refuses a write re-listing the omitted alternative over a document created under the schema omitting it", async () => {
      await withFixture(async (f) => {
        expect(await f.write("send", "Send", { schema: NARROWED }))
          .toBeUndefined();
        expect(storedAlternatives(f.runtime)).toEqual(["send/Send"]);

        expect(await f.write("edit", "Edit", { value: "edited" })).toContain(
          "the candidate adds an alternative outside a release",
        );
      });
    });

    it("refuses a schema listing no alternatives", async () => {
      await withFixture(async (f) => {
        expect(await f.write("send", "Send")).toBeUndefined();

        expect(
          await f.write("send", "Send", {
            schema: { type: "string", ifc: { writePolicyAnyOf: [] } },
          }),
        ).toContain("the candidate lists no alternative");
      });
    });

    it("refuses a schema listing no alternatives at a position the write leaves untouched", async () => {
      await withFixture(async (f) => {
        expect(
          await f.write("send", undefined, {
            schema: noteBesideTag(SCHEMA.ifc!.writePolicyAnyOf!),
            value: { note: "first" },
          }),
        ).toBeUndefined();

        expect(
          await f.write("send", undefined, {
            schema: noteBesideTag([]),
            value: { note: "again" },
          }),
        ).toContain(
          "writePolicyAnyOf must remain stable at /tag: the candidate lists " +
            "no alternative",
        );
        expect(storedAlternatives(f.runtime, "protected-value", ["tag"]))
          .toEqual(["send/Send", "edit/Edit"]);
      });
    });

    describe("putting a link where the policy is declared", () => {
      // The document's `tag` field carries the policy, and each write sets it
      // to a link to a document holding the value, or to the value itself for
      // the cases' twins. A link answers to its writer's own schema as a
      // value does, so the two refuse the same writers.

      /** `SCHEMA`, with `edit` stamped by another module. */
      const RESTAMPED: JSONSchemaObj = {
        type: "string",
        ifc: {
          writePolicyAnyOf: [
            policy("send", "Send"),
            rebound(
              policy("edit", "Edit") as Alternative,
              (binding) => ({ ...binding, moduleIdentity: "module-2" }),
            ),
          ],
        },
      };

      /** Seeds the document through `send`, then returns `f`. */
      const seeded = async (f: ReturnType<typeof fixture>) => {
        expect(await f.write("send", "Send", { at: "tag" })).toBeUndefined();
        return f;
      };

      it("commits a listed writer's link under the schema omitting one, and stores both alternatives", async () => {
        await withFixture(async (f) => {
          await seeded(f);

          expect(
            await f.write("send", "Send", {
              at: "tag",
              schema: NARROWED,
              link: true,
            }),
          ).toBeUndefined();
          expect(storedAlternatives(f.runtime, "protected-value", ["tag"]))
            .toEqual(["send/Send", "edit/Edit"]);
        });
      });

      it("commits the omitted writer's link under a schema listing it", async () => {
        await withFixture(async (f) => {
          await seeded(f);

          expect(await f.write("edit", "Edit", { at: "tag", link: true }))
            .toBeUndefined();
        });
      });

      for (const [what, link] of [["link", true], ["value", false]] as const) {
        it(`refuses the omitted writer's ${what} under the schema omitting it`, async () => {
          await withFixture(async (f) => {
            await seeded(f);

            expect(
              await f.write("edit", "Edit", {
                at: "tag",
                schema: NARROWED,
                link,
              }),
            ).toContain("writePolicyAnyOf failed at /tag");
          });
        });

        it(`refuses a writer's ${what} under a schema stamping it with another module`, async () => {
          await withFixture(async (f) => {
            await seeded(f);

            expect(
              await f.write("edit", "Edit", {
                at: "tag",
                schema: RESTAMPED,
                link,
              }),
            ).toContain("writePolicyAnyOf failed at /tag");
          });
        });
      }
    });

    describe("through links", () => {
      // A strict runtime with its own store. A document holding links
      // stores the policy of what they name beneath them, which the
      // verification of a later link write reads back. A floor on a slot
      // holding a link has the link's write derive the evidence of the
      // document it names, which merges that document's stored envelope with
      // the schema the transaction writes it under where that schema names
      // its creator as a reader. Each case writes under a schema omitting
      // one stored alternative.

      /** A write policy's list of alternatives, as a schema declares one. */
      type Alternatives = NonNullable<
        NonNullable<JSONSchemaObj["ifc"]>["writePolicyAnyOf"]
      >;

      /** The schema of one message, whose tags `alternatives` may write. */
      const message = (alternatives: Alternatives): JSONSchemaObj => ({
        type: "object",
        properties: {
          body: { type: "string" },
          tags: {
            type: "array",
            items: { type: "string", ifc: { writePolicyAnyOf: alternatives } },
          },
        },
      });

      /** A confidentiality naming whoever creates the document. */
      const CREATOR_ONLY = [{
        type: "https://commonfabric.org/cfc/atom/User",
        subject: { __ctCurrentPrincipal: true },
      }];

      /**
       * The schema of a list of `message(alternatives)` documents. Its label
       * is what makes the list store an envelope of its own.
       */
      const list = (alternatives: Alternatives): JSONSchemaObj => ({
        type: "object",
        properties: {
          messages: { type: "array", items: message(alternatives) },
        },
        ifc: { confidentiality: CREATOR_ONLY },
      });

      /** Runs `body` against a strict runtime, disposing of it after. */
      const withStrictRuntime = async (
        body: (runtime: Runtime) => Promise<void>,
      ) => {
        const storageManager = StorageManager.emulate({ as: signer });
        const runtime = new Runtime({
          apiUrl: new URL("https://example.com"),
          storageManager,
          cfcEnforcementMode: "enforce-strict",
          cfcFlowLabels: "persist",
          cfcReadMaxConfidentiality: [cfcAtom.user(signer.did())],
          trustSnapshotProvider: () => ({
            id: signer.did(),
            actingPrincipal: signer.did(),
          }),
        });
        try {
          await body(runtime);
        } finally {
          await runtime.dispose();
          await storageManager.close();
        }
      };

      const BOTH = SCHEMA.ifc!.writePolicyAnyOf!;
      const SEND_ONLY: Alternatives = [policy("send", "Send")];

      it("commits a list's link write under a schema omitting one, and stores both alternatives beneath the links", async () => {
        // The list's writer is of a module no alternative names: the
        // policy beneath a link binds the writers of the document the link
        // names, which its own envelope holds them to, and not the writer of
        // the link.

        await withStrictRuntime(async (runtime) => {
          const seed = runtime.edit();
          setCfcImplementationIdentity(seed, {
            kind: "verified",
            moduleIdentity: "list-module",
            sourceFile: "/list.tsx",
            bindingPath: ["openList"],
          });
          const first = runtime.getCell(
            signer.did(),
            "message-1",
            message(BOTH),
            seed,
          );
          first.set({ body: "first" });
          runtime.getCell(signer.did(), "message-list", list(BOTH), seed)
            .set({ messages: [first] });
          runtime.prepareTxForCommit(seed);
          expect((await seed.commit().settled).error).toBeUndefined();

          const later = runtime.edit();
          setCfcImplementationIdentity(later, {
            kind: "verified",
            moduleIdentity: "list-module",
            sourceFile: "/list.tsx",
            bindingPath: ["openList"],
          });
          const second = runtime.getCell(
            signer.did(),
            "message-2",
            message(SEND_ONLY),
            later,
          );
          second.set({ body: "second" });
          runtime.getCell(signer.did(), "message-list", list(SEND_ONLY), later)
            .set({ messages: [first.withTx(later), second] });
          runtime.prepareTxForCommit(later);

          expect((await later.commit().settled).error?.message).toBeUndefined();
          expect(
            storedAlternatives(runtime, "message-list", [
              "messages",
              "*",
              "tags",
              "*",
            ]),
          ).toEqual(["send/Send", "edit/Edit"]);
        });
      });

      it("commits a held reference to a document written under a schema omitting one", async () => {
        await withStrictRuntime(async (runtime) => {
          const notes = (alternatives: Alternatives): JSONSchemaObj => ({
            type: "object",
            properties: {
              notes: { type: "array", items: { type: "string" } },
              tag: {
                type: "string",
                ifc: { writePolicyAnyOf: alternatives },
              },
            },
            ifc: { confidentiality: CREATOR_ONLY, integrity: ["endorsed"] },
          });
          const holder: JSONSchemaObj = {
            type: "object",
            properties: {
              notes: {
                asCell: ["readonly"],
                ifc: { requiredIntegrity: ["endorsed"] },
              },
            },
          };
          const seed = runtime.edit();
          runtime.getCell(signer.did(), "held-notes", notes(BOTH), seed)
            .set({ notes: ["first"] });
          runtime.prepareTxForCommit(seed);
          expect((await seed.commit().settled).error).toBeUndefined();

          const later = runtime.edit();
          const held = runtime.getCell(
            signer.did(),
            "held-notes",
            notes(SEND_ONLY),
            later,
          );
          held.set({ notes: ["first", "second"] });
          runtime.getCell(signer.did(), "notes-holder", holder, later)
            .set({ notes: held });
          runtime.prepareTxForCommit(later);

          expect((await later.commit().settled).error?.message).toBeUndefined();
          expect(storedAlternatives(runtime, "held-notes", ["tag"])).toEqual([
            "send/Send",
            "edit/Edit",
          ]);
        });
      });
    });

    it("commits a write under a schema declaring no policy at all, and stores both alternatives", async () => {
      await withFixture(async (f) => {
        expect(await f.write("send", "Send")).toBeUndefined();

        expect(
          await f.write("send", "Send", {
            schema: { type: "string" },
            value: "plain",
          }),
        ).toBeUndefined();
        expect(storedAlternatives(f.runtime)).toEqual([
          "send/Send",
          "edit/Edit",
        ]);
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

    it("throws when a later schema drops an alternative, where neither side is stored", () => {
      expect(() =>
        mergeCfcSchemaEnvelopes(SCHEMA, {
          type: "string",
          ifc: { writePolicyAnyOf: [policy("send", "Send")] },
        })
      ).toThrow(
        "writePolicyAnyOf must remain stable at /: the candidate lacks an " +
          "alternative the other schema lists",
      );
    });

    describe("with the stored side named", () => {
      // `SCHEMA` is the stored side, against `narrowed`, which lists one of
      // its two alternatives.

      const narrowed: JSONSchemaObj = {
        type: "string",
        ifc: { writePolicyAnyOf: [policy("send", "Send")] },
      };

      it("returns the stored alternatives, as stored, for a candidate omitting one", () => {
        const merged = mergeCfcSchemaEnvelopes(SCHEMA, narrowed, {
          storedSide: "existing",
        }) as JSONSchemaObj;

        expect(merged.ifc?.writePolicyAnyOf).toEqual(
          SCHEMA.ifc!.writePolicyAnyOf,
        );
      });

      it("returns the stored alternatives, as stored, where the stored side is the candidate", () => {
        const merged = mergeCfcSchemaEnvelopes(narrowed, SCHEMA, {
          storedSide: "candidate",
        }) as JSONSchemaObj;

        expect(merged.ifc?.writePolicyAnyOf).toEqual(
          SCHEMA.ifc!.writePolicyAnyOf,
        );
      });

      it("throws where the side that is not stored adds an alternative", () => {
        const widened: JSONSchemaObj = {
          type: "string",
          ifc: {
            writePolicyAnyOf: [
              ...SCHEMA.ifc!.writePolicyAnyOf!,
              policy("tidy", "Send"),
            ],
          },
        };

        expect(() =>
          mergeCfcSchemaEnvelopes(SCHEMA, widened, { storedSide: "existing" })
        ).toThrow("the candidate adds an alternative outside a release");
        expect(() =>
          mergeCfcSchemaEnvelopes(widened, SCHEMA, { storedSide: "candidate" })
        ).toThrow("the candidate adds an alternative outside a release");
      });

      it("returns the stored stamp where the stored side is the candidate, for an alternative and a lone writer claim alike", () => {
        const stamped = (module: string) =>
          rebound(
            policy("edit", "Edit") as Alternative,
            (binding) => ({ ...binding, moduleIdentity: module }),
          );
        const stampOf = (claim: unknown) =>
          (claim as Alternative["writeAuthorizedBy"]).__ctWriterIdentityOf
            .moduleIdentity;
        const list = (module: string): JSONSchemaObj => ({
          type: "string",
          ifc: { writePolicyAnyOf: [stamped(module)] },
        });
        const lone = (module: string): JSONSchemaObj => ({
          type: "string",
          ifc: { writeAuthorizedBy: stamped(module).writeAuthorizedBy },
        });

        const mergedList = mergeCfcSchemaEnvelopes(
          list("writer-module"),
          list("stored-module"),
          { storedSide: "candidate" },
        ) as JSONSchemaObj;
        const mergedLone = mergeCfcSchemaEnvelopes(
          lone("writer-module"),
          lone("stored-module"),
          { storedSide: "candidate" },
        ) as JSONSchemaObj;

        expect(
          stampOf(
            (mergedList.ifc?.writePolicyAnyOf as Alternative[])[0]
              .writeAuthorizedBy,
          ),
        ).toBe("stored-module");
        expect(stampOf(mergedLone.ifc?.writeAuthorizedBy)).toBe(
          "stored-module",
        );
      });

      it("returns no issue from the dry run of a write omitting one", () => {
        expect(storedCfcEnvelopeMergeIssue(SCHEMA, narrowed)).toBeUndefined();
      });

      it("throws for an empty list, and the dry run returns that issue", () => {
        const empty: JSONSchemaObj = {
          type: "string",
          ifc: { writePolicyAnyOf: [] },
        };

        expect(() =>
          mergeCfcSchemaEnvelopes(SCHEMA, empty, { storedSide: "existing" })
        ).toThrow("the candidate lists no alternative");
        expect(() =>
          mergeCfcSchemaEnvelopes(empty, SCHEMA, { storedSide: "candidate" })
        ).toThrow("the candidate lists no alternative");
        expect(storedCfcEnvelopeMergeIssue(SCHEMA, empty)?.message).toContain(
          "the candidate lists no alternative",
        );
      });
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

    describe("a release omitting a stored alternative", () => {
      // The release's schema leaves out `edit`. Each case checks what the
      // document stores afterwards, and that `edit` writes exactly as it
      // could before the release: through its own action, from its own
      // module, under a schema listing it.

      /** The release's schema: `send`, and `reply` appended in place of `edit`. */
      const RENAMED: JSONSchemaObj = {
        type: "string",
        ifc: {
          writePolicyAnyOf: [policy("send", "Send"), policy("reply", "Send")],
        },
      };

      /** Every alternative the document stores after `RENAMED`'s release. */
      const ALL: JSONSchemaObj = {
        type: "string",
        ifc: {
          writePolicyAnyOf: [
            ...SCHEMA.ifc!.writePolicyAnyOf!,
            policy("reply", "Send"),
          ],
        },
      };

      /** Writes `send`'s value under `schema` in a release, returning its error. */
      const released = async (
        f: ReturnType<typeof fixture>,
        schema: JSONSchemaObj,
      ) => {
        expect(await f.write("send", "Send")).toBeUndefined();
        const { error } = await f.writeWithRetry(
          "send",
          "Send",
          { schema, value: "released" },
          (tx) => markRelease(f.runtime, tx, true),
        );
        return error;
      };

      it("stores the stored alternatives, as stored, and the appended one after them", async () => {
        await withFixture(async (f) => {
          expect(await released(f, RENAMED)).toBeUndefined();

          expect(storedAlternatives(f.runtime)).toEqual([
            "send/Send",
            "edit/Edit",
            "reply/Send",
          ]);
        });
      });

      it("commits the appended writer's write through its own action", async () => {
        await withFixture(async (f) => {
          expect(await released(f, RENAMED)).toBeUndefined();

          expect(await f.write("reply", "Send", { schema: RENAMED }))
            .toBeUndefined();
          expect(await f.write("reply", "Edit", { schema: ALL })).toContain(
            "writePolicyAnyOf failed at /",
          );
        });
      });

      it("commits the omitted writer's write through its own action, from its own module", async () => {
        await withFixture(async (f) => {
          expect(await released(f, RENAMED)).toBeUndefined();

          expect(await f.write("edit", "Edit", { schema: ALL }))
            .toBeUndefined();
        });
      });

      it("refuses the omitted writer's write through another action, or none, or from another module", async () => {
        await withFixture(async (f) => {
          expect(await released(f, RENAMED)).toBeUndefined();

          expect(await f.write("edit", "Send", { schema: ALL })).toContain(
            "writePolicyAnyOf failed at /",
          );
          expect(await f.write("edit", undefined, { schema: ALL })).toContain(
            "writePolicyAnyOf failed at /",
          );
          expect(
            await f.write("edit", "Edit", {
              schema: ALL,
              module: "other-module",
            }),
          ).toContain("writePolicyAnyOf failed at /");
        });
      });

      it("refuses a release listing no alternatives at a position the write leaves untouched", async () => {
        await withFixture(async (f) => {
          expect(
            await f.write("send", undefined, {
              schema: noteBesideTag(SCHEMA.ifc!.writePolicyAnyOf!),
              value: { note: "first" },
            }),
          ).toBeUndefined();

          const { error } = await f.writeWithRetry(
            "send",
            undefined,
            { schema: noteBesideTag([]), value: { note: "released" } },
            (tx) => markRelease(f.runtime, tx, true),
          );
          expect(error?.message).toContain(
            "the candidate lists no alternative",
          );
        });
      });

      it("stores the stored alternatives, as stored, for a release that only omits one", async () => {
        await withFixture(async (f) => {
          expect(
            await released(f, {
              type: "string",
              ifc: { writePolicyAnyOf: [policy("send", "Send")] },
            }),
          ).toBeUndefined();

          expect(storedAlternatives(f.runtime)).toEqual([
            "send/Send",
            "edit/Edit",
          ]);
          expect(await f.write("edit", "Edit")).toBeUndefined();
        });
      });
    });

    describe("an appended alternative against the stored one it pairs with", () => {
      // Each case appends a variant of `reply` through `send`'s action, as
      // `APPENDED_VARIANTS` makes it, under the authorized marker.

      /** What the write appending `variant` returns as its error. */
      const appending = async (
        f: ReturnType<typeof fixture>,
        variant: (paired: Alternative) => Alternative,
      ) => {
        expect(await f.write("send", "Send")).toBeUndefined();
        const schema = {
          type: "string",
          ifc: {
            writePolicyAnyOf: [
              ...SCHEMA.ifc!.writePolicyAnyOf!,
              variant(policy("reply", "Send") as Alternative),
            ],
          },
        } as JSONSchemaObj;
        const { error } = await f.writeWithRetry(
          "send",
          "Send",
          { schema },
          (tx) => markRelease(f.runtime, tx, true),
        );
        return error;
      };

      for (
        const { name, vary } of APPENDED_VARIANTS.filter((v) => v.admitted)
      ) {
        it(`commits the write appending ${name}`, async () => {
          await withFixture(async (f) => {
            expect(await appending(f, vary)).toBeUndefined();
          });
        });
      }

      for (
        const { name, vary } of APPENDED_VARIANTS.filter((v) => !v.admitted)
      ) {
        it(`refuses the write appending ${name}`, async () => {
          await withFixture(async (f) => {
            expect((await appending(f, vary))?.message).toContain(
              "the release adds an alternative no stored alternative admits",
            );
          });
        });
      }
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
        storedSide: "existing",
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

      it("throws for an appended alternative whose writer claim binds no symbol", () => {
        for (
          const binding of [
            { moduleIdentity: "new" },
            { moduleIdentity: "new", file: "/records.tsx", path: [] },
            { moduleIdentity: "new", file: "/records.tsx", path: "reply" },
            {
              moduleIdentity: "new",
              file: "/records.tsx",
              path: ["reply"],
              extra: true,
            },
          ]
        ) {
          expect(() =>
            merge(candidateAdding({
              writeAuthorizedBy: { __ctWriterIdentityOf: binding },
              uiContract: contract("Send"),
            }))
          ).toThrow(CfcEnvelopeStabilityError);
        }
      });

      it("returns the stored alternatives, then the appended one, for a candidate omitting one while appending one", () => {
        expect(
          merge(
            schemaOf([
              alternative("send", "Send", "new"),
              alternative("reply", "Send", "new"),
            ]),
          ).ifc?.writePolicyAnyOf,
        ).toEqual([...STORED, alternative("reply", "Send", "new")]);
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

      it("returns a refusal for an appended alternative whose writer claim binds no symbol", () => {
        expect(
          kept([...STORED, {
            writeAuthorizedBy: {
              __ctWriterIdentityOf: { moduleIdentity: "new" },
            },
            uiContract: contract("Send"),
          }]),
        ).toContain("writePolicyAnyOf");
      });

      it("returns a refusal for a merged policy that drops a stored alternative", () => {
        expect(kept([STORED[0], alternative("reply", "Send", "new")]))
          .toContain("drops the stored writePolicyAnyOf");
      });
    });

    describe("the restatement waiver's position comparison", () => {
      // `ifcDiffersOnlyByReleaseAppend()` says whether a position's merged
      // policy is the stored one but for alternatives the release appended,
      // which the restatement waiver then takes for no change.

      const appended = alternative("reply", "Send", "new");

      it("returns `true` for the stored policy followed by an admissible appended alternative", () => {
        expect(
          ifcDiffersOnlyByReleaseAppend(
            { writePolicyAnyOf: STORED },
            { writePolicyAnyOf: [...STORED, appended] },
            RELEASE,
          ),
        ).toBe(true);
      });

      it("returns `false` for an appended alternative the release may not append", () => {
        expect(
          ifcDiffersOnlyByReleaseAppend(
            { writePolicyAnyOf: STORED },
            {
              writePolicyAnyOf: [
                ...STORED,
                alternative("reply", "Send", "other"),
              ],
            },
            RELEASE,
          ),
        ).toBe(false);
      });

      it("returns `false` where the stored alternatives are reordered, one is dropped, or one is stamped again", () => {
        for (
          const merged of [
            [STORED[1], STORED[0], appended],
            [STORED[0], appended],
            [STORED[0], alternative("edit", "Edit", "new"), appended],
          ]
        ) {
          expect(
            ifcDiffersOnlyByReleaseAppend(
              { writePolicyAnyOf: STORED },
              { writePolicyAnyOf: merged },
              RELEASE,
            ),
          ).toBe(false);
        }
      });

      it("returns `false` for an appended alternative beside another difference at the position", () => {
        const integrity = [{ kind: "authored-by" }];
        expect(
          ifcDiffersOnlyByReleaseAppend(
            { writePolicyAnyOf: STORED },
            {
              writePolicyAnyOf: [...STORED, appended],
              addIntegrity: integrity,
            },
            RELEASE,
          ),
        ).toBe(false);
        expect(
          ifcDiffersOnlyByReleaseAppend(
            { writePolicyAnyOf: STORED, uiContract: contract("Send") },
            {
              writePolicyAnyOf: [...STORED, appended],
              uiContract: contract("Edit"),
            },
            RELEASE,
          ),
        ).toBe(false);
      });

      it("returns `false` for a position with no write policy that the merge changed", () => {
        expect(
          ifcDiffersOnlyByReleaseAppend(
            { writeAuthorizedBy: STORED[0].writeAuthorizedBy },
            { writeAuthorizedBy: appended.writeAuthorizedBy },
            RELEASE,
          ),
        ).toBe(false);
      });
    });

    describe("an appended alternative against the stored one it pairs with", () => {
      // Each case appends a variant of `reply`, of `new`, through `send`'s
      // action, as `APPENDED_VARIANTS` makes it.

      const variants = APPENDED_VARIANTS.map(({ name, admitted, vary }) => ({
        name,
        admitted,
        appended: vary(alternative("reply", "Send", "new") as Alternative),
      }));

      describe("the merge", () => {
        for (const { name, appended } of variants.filter((v) => v.admitted)) {
          it(`returns the stored alternatives and ${name} after them`, () => {
            expect(merge(candidateAdding(appended)).ifc?.writePolicyAnyOf)
              .toEqual([...STORED, appended]);
          });
        }

        for (const { name, appended } of variants.filter((v) => !v.admitted)) {
          it(`throws for ${name}`, () => {
            expect(() => merge(candidateAdding(appended))).toThrow(
              "the release adds an alternative no stored alternative admits",
            );
          });
        }
      });

      describe("the keep rule", () => {
        for (const { name, appended } of variants.filter((v) => v.admitted)) {
          it(`returns \`undefined\` for ${name}`, () => {
            expect(kept([...STORED, appended])).toBeUndefined();
          });
        }

        for (const { name, appended } of variants.filter((v) => !v.admitted)) {
          it(`returns a refusal for ${name}`, () => {
            expect(kept([...STORED, appended])).toContain("writePolicyAnyOf");
          });
        }
      });
    });
  });
});
