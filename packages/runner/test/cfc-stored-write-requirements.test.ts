import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";

import type { JSONSchema } from "../src/builder/types.ts";
import { loadStoredCfcEnvelope } from "../src/cfc/prepare.ts";
import { runtimeWritePolicyAuthorization } from "../src/cfc/types.ts";
import { markRendererTrustedEvent } from "../src/cfc/ui-contract.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import type { EventHandler } from "../src/scheduler.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-stored-write-requirements",
);
const space = signer.did();

const WRITER_LABEL = { confidentiality: ["writer-clause"] } as const;

const PIN_CONTRACT = {
  helper: "UiAction",
  action: "PinNote",
  trustedPattern: "PinSurface",
  requiredEventIntegrity: ["PinSurface"],
} as const;

const click = (action: string) => {
  const event = {
    type: "click",
    provenance: {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: "PinSurface",
        eventIntegrity: ["PinSurface"],
        uiContractDataset: { uiAction: action },
      },
    },
  };
  markRendererTrustedEvent(event);
  return event;
};

const pinClick = () => click("PinNote");

describe("stored write requirements", () => {
  // A document's stored envelope carries the write-side requirements its
  // declaring schema set: who may write a path, which click it needs, which
  // value it must copy, the integrity it must carry. A later writer's own
  // schema may add requirements but never removes the stored ones, whether
  // that schema declares nothing at the path or declares a label of its own.

  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const start = (): Runtime => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    return runtime;
  };

  const commitWrite = async (
    runtime: Runtime,
    id: string,
    schema: JSONSchema,
    value: unknown,
  ) => {
    const tx = runtime.edit();
    runtime.getCell(space, id, schema, tx).set(value as never);
    return await tx.commit();
  };

  // A write through a cell that declares no schema, whose write-policy input
  // is the document's stored schema.
  const commitUndeclaredWrite = async (
    runtime: Runtime,
    id: string,
    key: string,
    value: unknown,
  ) => {
    const tx = runtime.edit();
    runtime.getCell(space, id, undefined, tx).key(key).set(value as never);
    return await tx.commit();
  };

  // Writes `value` at `keys` of `id` from a handler that runs for one trusted
  // click, through a cell typed by `schema`.
  const clickAt = async (
    runtime: Runtime,
    id: string,
    schema: JSONSchema | undefined,
    value: unknown,
    keys: readonly string[] = [],
    action = "PinNote",
  ) => {
    const stream = runtime.getCell(space, `${id}-${keys.join(".")}-click`, {
      asCell: ["stream"],
    });
    let target = runtime.getCell(space, id, schema);
    for (const key of keys) target = target.key(key as never) as typeof target;
    const handler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        target.withTx(tx).set(value as never);
      }) as EventHandler,
      {
        reads: [],
        writes: [target.getAsNormalizedFullLink()],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );
    const cancel = runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      click(action),
    );
    await runtime.idle();
    cancel();
  };

  // What the runtime records in the transaction that sets a piece up, swaps
  // its pattern or repairs its start: the release marker for each of the
  // piece's stores, under its own authorization. `authorized: false` is what
  // pattern code could record.
  const markRelease = (
    runtime: Runtime,
    tx: IExtendedStorageTransaction,
    id: string,
    authorized = true,
  ) => {
    const target = runtime.getCell(space, id).getAsNormalizedFullLink();
    tx.recordCfcWritePolicyInput(
      {
        kind: "release-program",
        target: {
          space: target.space,
          id: target.id,
          scope: target.scope,
          path: [],
        },
        modules: [],
      },
      authorized ? runtimeWritePolicyAuthorization : undefined,
    );
  };

  const refusalOf = (result: { error?: unknown }): string => {
    const error = result.error as Error | undefined;
    expect(isCfcEnforcementRejection(error)).toBe(true);
    return String(error?.message);
  };

  describe("`exactCopyOf`", () => {
    const STORED = {
      type: "object",
      properties: {
        email: { type: "string" },
        confirmed: { type: "string", ifc: { exactCopyOf: ["email"] } },
      },
      required: ["email", "confirmed"],
    } as const satisfies JSONSchema;

    const seed = async (runtime: Runtime, id: string) => {
      const result = await commitWrite(runtime, id, STORED, {
        email: "a@example.com",
        confirmed: "a@example.com",
      });
      expect(result.error).toBeUndefined();
    };

    it("refuses a writer whose schema declares nothing at the path", async () => {
      const runtime = start();
      await seed(runtime, "exact-copy-unlabeled");
      const result = await commitUndeclaredWrite(
        runtime,
        "exact-copy-unlabeled",
        "confirmed",
        "b@example.com",
      );
      expect(refusalOf(result)).toContain("exactCopyOf failed at /confirmed");
    });

    it("refuses a writer whose schema declares a label of its own at the path", async () => {
      const runtime = start();
      await seed(runtime, "exact-copy-labeled");
      const result = await commitWrite(runtime, "exact-copy-labeled", {
        type: "object",
        properties: {
          email: { type: "string" },
          confirmed: { type: "string", ifc: { ...WRITER_LABEL } },
        },
        required: ["email", "confirmed"],
      }, { email: "a@example.com", confirmed: "b@example.com" });
      expect(refusalOf(result)).toContain("exactCopyOf failed at /confirmed");
    });

    it("commits a labeled writer whose value satisfies the stored claim", async () => {
      const runtime = start();
      await seed(runtime, "exact-copy-labeled-ok");
      const result = await commitWrite(runtime, "exact-copy-labeled-ok", {
        type: "object",
        properties: {
          email: { type: "string" },
          confirmed: { type: "string", ifc: { ...WRITER_LABEL } },
        },
        required: ["email", "confirmed"],
      }, { email: "b@example.com", confirmed: "b@example.com" });
      expect(result.error).toBeUndefined();
    });
  });

  describe("`requiredIntegrity`", () => {
    // The floor is stored by a runtime that does not enforce it, so nothing
    // in the stored schema mints the integrity a later writer would need.
    // The stored label is what makes the document keep an envelope at all,
    // and the labeled writer restates that label without the floor.

    const STORE_LABEL = { confidentiality: ["store-clause"] } as const;

    const FLOOR_SCHEMA = {
      type: "object",
      properties: {
        out: {
          type: "string",
          ifc: { ...STORE_LABEL, requiredIntegrity: ["floor-approved"] },
        },
      },
      required: ["out"],
    } as const satisfies JSONSchema;

    const FLOOR_ONLY_SCHEMA = {
      type: "object",
      properties: {
        out: { type: "string", ifc: { requiredIntegrity: ["floor-approved"] } },
      },
      required: ["out"],
    } as const satisfies JSONSchema;

    const seed = async (
      id: string,
      schema: JSONSchema = FLOOR_SCHEMA,
    ): Promise<Runtime> => {
      storageManager = StorageManager.emulate({ as: signer });
      const seeder = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        cfcWriteFloor: "off",
      });
      const result = await commitWrite(seeder, id, schema, {
        out: "seeded",
      });
      expect(result.error).toBeUndefined();
      await seeder.dispose({ closeStorage: false });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        cfcWriteFloor: "enforce",
      });
      return runtime;
    };

    it("refuses a writer whose schema declares nothing at the path", async () => {
      const runtime = await seed("floor-unlabeled");
      const result = await commitUndeclaredWrite(
        runtime,
        "floor-unlabeled",
        "out",
        "unapproved",
      );
      expect(refusalOf(result)).toContain("requiredIntegrity failed at /out");
    });

    it("refuses a writer whose schema declares a label of its own at the path", async () => {
      const runtime = await seed("floor-labeled");
      const result = await commitWrite(runtime, "floor-labeled", {
        type: "object",
        properties: {
          out: { type: "string", ifc: { ...STORE_LABEL } },
        },
        required: ["out"],
      }, { out: "unapproved" });
      expect(refusalOf(result)).toContain("requiredIntegrity failed at /out");
    });

    it("refuses a writer whose schema declares nothing at the path when the floor is the only claim stored there", async () => {
      const runtime = await seed("floor-only", FLOOR_ONLY_SCHEMA);
      const result = await commitUndeclaredWrite(
        runtime,
        "floor-only",
        "out",
        "unapproved",
      );
      expect(refusalOf(result)).toContain("failed at /out");
    });
  });

  describe("claims an ancestor of the written path declares", () => {
    // A claim on an object governs every write beneath it. The writer here
    // writes one field through a cell narrowed to it, so its own schema input
    // covers only that field, whether it declares nothing there or a label.

    const BUILTIN_WRITER = "pin-builtin";
    const PIN_FIELD = {
      type: "string",
      ifc: { uiContract: { ...PIN_CONTRACT } },
    };

    const REFUSALS = {
      uiContract: "missing trusted-event policy input",
      writeAuthorizedBy: "writeAuthorizedBy",
    } as const;
    const CLAIMS = {
      uiContract: { uiContract: { ...PIN_CONTRACT } },
      writeAuthorizedBy: { writeAuthorizedBy: [BUILTIN_WRITER] },
    } as const;
    const LEVELS = {
      root: {
        schema: (ifc: object) => ({
          type: "object",
          ifc,
          properties: {
            child: { type: "string" },
            other: { type: "string" },
          },
        }),
        seedPath: [] as string[],
        seed: { child: "seeded", other: "seeded" } as unknown,
        written: ["child"],
        read: (value: unknown) => (value as { child?: string })?.child,
      },
      parent: {
        schema: (ifc: object) => ({
          type: "object",
          properties: {
            parent: {
              type: "object",
              ifc,
              properties: { child: { type: "string" } },
            },
            other: { type: "string" },
          },
        }),
        seedPath: ["parent"],
        seed: { child: "seeded" } as unknown,
        written: ["parent", "child"],
        read: (value: unknown) =>
          (value as { parent?: { child?: string } })?.parent?.child,
      },
    } as const;

    // Seeds the document the way its declared writer would: a trusted click
    // for a contract, the named builtin for a writer claim.
    const seed = async (
      runtime: Runtime,
      id: string,
      claim: keyof typeof CLAIMS,
      level: keyof typeof LEVELS,
    ) => {
      const { schema, seedPath, seed: value } = LEVELS[level];
      const declared = schema(CLAIMS[claim]) as JSONSchema;
      if (claim === "uiContract") {
        const stream = runtime.getCell(space, `${id}-stream`, {
          asCell: ["stream"],
        });
        const output = runtime.getCell(space, id, declared).key(
          ...seedPath as [],
        );
        const handler = Object.assign(
          ((tx: IExtendedStorageTransaction) => {
            output.withTx(tx).set(value as never);
          }) as EventHandler,
          {
            reads: [],
            writes: [output.getAsNormalizedFullLink()],
            module: { type: "javascript" as const },
            pattern: {} as never,
          },
        );
        const cancel = runtime.scheduler.addEventHandler(
          handler,
          stream.getAsNormalizedFullLink(),
        );
        runtime.scheduler.queueEvent(
          stream.getAsNormalizedFullLink(),
          pinClick(),
        );
        await runtime.idle();
        cancel();
      } else {
        const tx = runtime.edit();
        tx.setCfcTrustSnapshot({
          id: `trust-${space}`,
          actingPrincipal: space,
        });
        tx.setCfcImplementationIdentity({
          kind: "builtin",
          builtinId: BUILTIN_WRITER,
        });
        runtime.getCell(space, id, declared, tx).key(...seedPath as [])
          .set(value as never);
        expect((await tx.commit()).error).toBeUndefined();
      }
      return declared;
    };

    // The written field's own schema: nothing, or a label of the writer's.
    const writerSchemas = {
      undeclared: undefined,
      labeled: { type: "string", ifc: { ...WRITER_LABEL } },
    } as const;

    for (const claim of Object.keys(CLAIMS) as (keyof typeof CLAIMS)[]) {
      for (const level of Object.keys(LEVELS) as (keyof typeof LEVELS)[]) {
        for (
          const writer of Object.keys(writerSchemas) as (
            keyof typeof writerSchemas
          )[]
        ) {
          it(`refuses a${writer === "labeled" ? " labeled" : "n undeclared"} writer of a field under a \`${claim}\` declared at the ${level}`, async () => {
            const runtime = start();
            const id = `ancestor-${claim}-${level}-${writer}`;
            const declared = await seed(runtime, id, claim, level);
            const { written, read } = LEVELS[level];
            const stored = runtime.getCell(space, id, declared);
            expect(read(stored.get())).toBe("seeded");

            const tx = runtime.edit();
            const field = runtime.getCell(space, id, undefined, tx).key(
              ...written.slice(0, -1) as [],
            ).asSchema(
              writerSchemas[writer] === undefined ? undefined : {
                type: "object",
                properties: { [written.at(-1)!]: writerSchemas[writer] },
              } as JSONSchema,
            ).key(written.at(-1)! as never);
            field.set("overwritten" as never);
            const result = await tx.commit();

            expect(refusalOf(result)).toContain(REFUSALS[claim]);
            expect(read(stored.get())).toBe("seeded");
          });
        }
      }
    }

    for (const level of Object.keys(LEVELS) as (keyof typeof LEVELS)[]) {
      it(`commits a clicked writer of a field under a \`uiContract\` declared at the ${level}`, async () => {
        // The click matches the contract above the written field, and the
        // evidence it leaves is recorded where the contract is declared.

        const runtime = start();
        const id = `ancestor-clicked-${level}`;
        const declared = await seed(runtime, id, "uiContract", level);
        const { written, read } = LEVELS[level];
        const stream = runtime.getCell(space, `${id}-write-stream`, {
          asCell: ["stream"],
        });
        let field = runtime.getCell(space, id, undefined);
        for (const key of written) {
          field = field.key(key as never) as typeof field;
        }
        const handler = Object.assign(
          ((tx: IExtendedStorageTransaction) => {
            field.withTx(tx).set("clicked" as never);
          }) as EventHandler,
          {
            reads: [],
            writes: [field.getAsNormalizedFullLink()],
            module: { type: "javascript" as const },
            pattern: {} as never,
          },
        );
        const cancel = runtime.scheduler.addEventHandler(
          handler,
          stream.getAsNormalizedFullLink(),
        );
        runtime.scheduler.queueEvent(
          stream.getAsNormalizedFullLink(),
          pinClick(),
        );
        await runtime.idle();
        cancel();

        expect(read(runtime.getCell(space, id, declared).get())).toBe(
          "clicked",
        );
      });
    }

    it("commits a clicked writer of an object holding a field that declares a \`uiContract\`", async () => {
      // The reverse: the write covers the contracted field from above.

      const runtime = start();
      const id = "descendant-clicked";
      const declared = {
        type: "object",
        properties: {
          box: {
            type: "object",
            properties: { pin: PIN_FIELD, other: { type: "string" } },
          },
        },
      } as JSONSchema;
      await clickAt(runtime, id, declared, { pin: "seeded", other: "o" }, [
        "box",
      ]);
      expect(runtime.getCell(space, id, declared).get()).toEqual({
        box: { pin: "seeded", other: "o" },
      });
      await clickAt(runtime, id, undefined, { pin: "clicked", other: "o2" }, [
        "box",
      ]);
      expect(runtime.getCell(space, id, declared).get()).toEqual({
        box: { pin: "clicked", other: "o2" },
      });

      const tx = runtime.edit();
      runtime.getCell(space, id, undefined, tx).key("box").set(
        { pin: "unclicked", other: "o3" } as never,
      );
      expect(refusalOf(await tx.commit())).toContain(
        "missing trusted-event policy input",
      );
    });

    it("does not let one click satisfy two different contracts on the written path", async () => {
      // `/parent` needs the pin action and `/parent/child` the review action.
      // A write to the child meets both, and a click performs one action, so
      // it is refused whichever click comes with it.

      const contract = (action: string) => ({
        uiContract: { ...PIN_CONTRACT, action },
      });
      const declared = {
        type: "object",
        properties: {
          parent: {
            type: "object",
            ifc: contract("PinNote"),
            properties: {
              child: { type: "string", ifc: contract("ReviewNote") },
              other: { type: "string" },
            },
          },
        },
      } as JSONSchema;
      const runtime = start();
      const id = "two-contracts";
      await clickAt(runtime, id, declared, { parent: { other: "o" } });
      const stored = runtime.getCell(space, id, declared);
      expect(stored.get()).toEqual({ parent: { other: "o" } });

      await clickAt(runtime, id, undefined, "pinned", ["parent", "other"]);
      expect(stored.get()).toEqual({ parent: { other: "pinned" } });

      for (const action of ["PinNote", "ReviewNote"]) {
        await clickAt(
          runtime,
          id,
          undefined,
          `child by ${action}`,
          ["parent", "child"],
          action,
        );
        expect(stored.get()).toEqual({ parent: { other: "pinned" } });
      }
    });

    it("commits a write to a sibling of the field that carries the claim", async () => {
      const runtime = start();
      const id = "ancestor-sibling";
      const declared = await seed(runtime, id, "uiContract", "parent");
      for (const schema of [undefined, writerSchemas.labeled]) {
        const tx = runtime.edit();
        runtime.getCell(space, id, undefined, tx).asSchema(
          schema === undefined ? undefined : {
            type: "object",
            properties: { other: schema },
          } as JSONSchema,
        ).key("other" as never).set("sibling" as never);
        expect((await tx.commit()).error).toBeUndefined();
      }
      expect(runtime.getCell(space, id, declared).get()).toEqual({
        parent: { child: "seeded" },
        other: "sibling",
      });
    });
  });

  describe("which writes an attempt reaches", () => {
    // A document storing a writer claim at one path, and writes elsewhere in
    // it. Only a write, or an attempt, at or around the claimed path meets
    // the claim.

    const BUILTIN_WRITER = "admins-builtin";
    const STORED = {
      type: "object",
      properties: {
        admins: {
          type: "object",
          properties: {
            list: {
              type: "array",
              items: { type: "string" },
              ifc: { writeAuthorizedBy: [BUILTIN_WRITER] },
            },
          },
        },
        spots: {
          type: "array",
          items: { type: "object", properties: { label: { type: "string" } } },
        },
        other: { type: "string" },
      },
    } as const satisfies JSONSchema;
    const SEED = { admins: { list: ["alice"] }, spots: [], other: "o" };

    const seed = async (runtime: Runtime, id: string) => {
      const tx = runtime.edit();
      tx.setCfcTrustSnapshot({ id: `trust-${space}`, actingPrincipal: space });
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: BUILTIN_WRITER,
      });
      runtime.getCell(space, id, STORED, tx).set(SEED as never);
      expect((await tx.commit()).error).toBeUndefined();
    };

    it("commits a labeled writer pushing an object into an array beside the claimed path", async () => {
      const runtime = start();
      await seed(runtime, "push-beside-claim");
      const tx = runtime.edit();
      runtime.getCell(space, "push-beside-claim", {
        type: "object",
        properties: {
          spots: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string", ifc: { ...WRITER_LABEL } },
              },
            },
          },
        },
      }, tx).key("spots").push({ label: "level 2" } as never);
      expect((await tx.commit()).error).toBeUndefined();
      expect(runtime.getCell(space, "push-beside-claim", STORED).get())
        .toMatchObject({
          admins: { list: ["alice"] },
          spots: [{ label: "level 2" }],
        });
    });

    it("refuses an unchanged write above the claimed path beside a real write elsewhere", async () => {
      // Setting the object holding the claimed list to the value it holds
      // changes nothing and leaves no write behind, but it is still an attempt
      // to write the list.

      const runtime = start();
      await seed(runtime, "no-op-beside-write");
      const tx = runtime.edit();
      const cell = runtime.getCell(space, "no-op-beside-write", undefined, tx);
      cell.key("admins").set({ list: ["alice"] } as never);
      cell.key("other").set("changed" as never);
      expect(refusalOf(await tx.commit())).toContain("writeAuthorizedBy");
      expect(runtime.getCell(space, "no-op-beside-write", STORED).get())
        .toMatchObject({ other: "o" });
    });
  });

  describe("writes into a recursive definition", () => {
    // A write that rewrites the document answers to the definition's claims
    // wherever the value it writes changes.

    const NODE = {
      type: "object",
      properties: {
        pin: { type: "string", ifc: { uiContract: { ...PIN_CONTRACT } } },
        child: { $ref: "#/$defs/Node" },
      },
    } as const;
    const SHAPES = {
      plain: {
        stored: {
          type: "object",
          properties: { node: { $ref: "#/$defs/Node" } },
          $defs: { Node: NODE },
        },
        seed: {
          node: {
            pin: "p1",
            child: { pin: "p2", child: { pin: "p3", child: { pin: "p4" } } },
          },
        },
      },
      nullable: {
        stored: {
          type: "object",
          properties: { node: { $ref: "#/$defs/Node" } },
          $defs: { Node: { anyOf: [NODE, { type: "null" }] } },
        },
        seed: {
          node: {
            pin: "p1",
            child: { pin: "p2", child: { pin: "p3", child: null } },
          },
        },
      },
    } as const;
    const CASES = [
      ["plain", [], {
        node: {
          pin: "p1",
          child: { pin: "p2", child: { pin: "p3", child: { pin: "x" } } },
        },
      }],
      ["nullable", [], {
        node: {
          pin: "p1",
          child: { pin: "p2", child: { pin: "x", child: null } },
        },
      }],
    ] as const;

    const seeded = async (shape: keyof typeof SHAPES, id: string) => {
      const runtime = start();
      const { stored, seed } = SHAPES[shape];
      await clickAt(runtime, id, stored as JSONSchema, seed);
      expect(runtime.getCell(space, id, stored as JSONSchema).get()).toEqual(
        seed,
      );
      return runtime;
    };

    for (const [shape, keys, value] of CASES) {
      it(`refuses an unclicked write at /${keys.join("/")} of the ${shape} definition`, async () => {
        const id = `recursive-${shape}-${keys.join(".")}`;
        const runtime = await seeded(shape, id);
        const tx = runtime.edit();
        let target = runtime.getCell(space, id, undefined, tx);
        for (const key of keys) {
          target = target.key(key as never) as typeof target;
        }
        target.set(value as never);
        expect(refusalOf(await tx.commit())).toContain(
          "missing trusted-event policy input",
        );
        expect(
          runtime.getCell(space, id, SHAPES[shape].stored as JSONSchema).get(),
        ).toEqual(SHAPES[shape].seed);
      });
    }
  });

  describe("any change at, above or below a claimed path", () => {
    // A writer claim governs the value at its path whatever shape the new
    // value takes: a write beneath it, a value of another type over it, and
    // removing it are all modifications.

    const WRITER = "frozen-builtin";
    const CLAIM = { writeAuthorizedBy: [WRITER] };
    const STORED = {
      type: "object",
      properties: {
        frozen: {
          type: "object",
          ifc: CLAIM,
          properties: { digest: { type: "string" } },
        },
        list: { type: "array", items: { type: "string" }, ifc: CLAIM },
        other: { type: "string" },
      },
    } as const satisfies JSONSchema;
    const SEED = { frozen: { digest: "d" }, list: ["a"], other: "o" };

    const seed = async (
      runtime: Runtime,
      id: string,
      schema: JSONSchema,
      value: unknown,
    ) => {
      const tx = runtime.edit();
      tx.setCfcTrustSnapshot({ id: `trust-${space}`, actingPrincipal: space });
      tx.setCfcImplementationIdentity({ kind: "builtin", builtinId: WRITER });
      runtime.getCell(space, id, schema, tx).set(value as never);
      expect((await tx.commit()).error).toBeUndefined();
    };

    const ATTEMPTS = [
      ["a write beneath the claimed object", ["frozen", "digest"], "mallory"],
      ["a string over the claimed object", ["frozen"], "mallory"],
      ["a number over the claimed list", ["list"], 7],
      ["a replacement of the claimed object", ["frozen"], { digest: "x" }],
      ["emptying the claimed list", ["list"], []],
      ["removing the claimed object", [], { list: ["a"], other: "o" }],
    ] as const;
    const WRITERS = {
      undeclared: undefined,
      labeled: {
        type: "object",
        properties: {
          frozen: { ifc: { ...WRITER_LABEL } },
          list: { ifc: { ...WRITER_LABEL } },
        },
      },
    } as const;

    for (const [name, keys, value] of ATTEMPTS) {
      for (const writer of Object.keys(WRITERS) as (keyof typeof WRITERS)[]) {
        it(`refuses ${name} by an ${writer} writer`, async () => {
          const runtime = start();
          const id = `shape-change-${name}-${writer}`;
          await seed(runtime, id, STORED, SEED);
          const tx = runtime.edit();
          let target = runtime.getCell(
            space,
            id,
            WRITERS[writer] as JSONSchema | undefined,
            tx,
          );
          for (const key of keys) {
            target = target.key(key as never) as typeof target;
          }
          target.set(value as never);
          expect(refusalOf(await tx.commit())).toContain("writeAuthorizedBy");
          expect(runtime.getCell(space, id, STORED).get()).toEqual(SEED);
        });
      }
    }

    for (const writer of Object.keys(WRITERS) as (keyof typeof WRITERS)[]) {
      it(`commits a write beneath the claimed object by its named writer, ${writer}`, async () => {
        // The writer is the one the claim names, and it writes below the
        // claimed path, so no write of its own sits at the claim.

        const runtime = start();
        const id = `named-writer-beneath-${writer}`;
        await seed(runtime, id, STORED, SEED);
        const tx = runtime.edit();
        tx.setCfcTrustSnapshot({
          id: `trust-${space}`,
          actingPrincipal: space,
        });
        tx.setCfcImplementationIdentity({ kind: "builtin", builtinId: WRITER });
        runtime.getCell(
          space,
          id,
          WRITERS[writer] as JSONSchema | undefined,
          tx,
        )
          .key("frozen").key("digest" as never).set("e" as never);
        expect((await tx.commit()).error).toBeUndefined();
        expect(runtime.getCell(space, id, STORED).get()).toMatchObject({
          frozen: { digest: "e" },
        });
      });
    }

    it("refuses a write beneath the claim that records no input, beside one by the named writer", async () => {
      // The named writer's write beside it does not vouch for a write that
      // names no schema of its own.

      const runtime = start();
      const id = "unrecorded-beside-named";
      await seed(runtime, id, STORED, SEED);
      const tx = runtime.edit();
      tx.setCfcTrustSnapshot({ id: `trust-${space}`, actingPrincipal: space });
      tx.setCfcImplementationIdentity({ kind: "builtin", builtinId: WRITER });
      const cell = runtime.getCell(space, id, undefined, tx);
      cell.key("frozen").key("digest" as never).set("e" as never);
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "mallory",
      });
      tx.writeValueOrThrow({
        ...cell.getAsNormalizedFullLink(),
        path: ["frozen", "note"],
      }, "evil" as never);
      expect(refusalOf(await tx.commit())).toContain("writeAuthorizedBy");
      expect(runtime.getCell(space, id, STORED).get()).toEqual(SEED);
    });

    describe("a claim on every item", () => {
      const ITEMS = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" } },
              ifc: CLAIM,
            },
          },
        },
      } as const satisfies JSONSchema;
      const ITEMS_SEED = { items: [{ name: "a" }] };

      it("commits a write beneath an item by its named writer", async () => {
        const runtime = start();
        await seed(runtime, "item-named-writer", ITEMS, ITEMS_SEED);
        const tx = runtime.edit();
        tx.setCfcTrustSnapshot({
          id: `trust-${space}`,
          actingPrincipal: space,
        });
        tx.setCfcImplementationIdentity({ kind: "builtin", builtinId: WRITER });
        runtime.getCell(space, "item-named-writer", undefined, tx)
          .key("items").key(0 as never).key("name" as never)
          .set("b" as never);
        expect((await tx.commit()).error).toBeUndefined();
        expect(runtime.getCell(space, "item-named-writer", ITEMS).get())
          .toEqual({ items: [{ name: "b" }] });
      });

      it("refuses a write beneath an item by another writer", async () => {
        const runtime = start();
        await seed(runtime, "item-other-writer", ITEMS, ITEMS_SEED);
        const tx = runtime.edit();
        tx.setCfcTrustSnapshot({
          id: `trust-${space}`,
          actingPrincipal: space,
        });
        tx.setCfcImplementationIdentity({
          kind: "builtin",
          builtinId: "mallory",
        });
        runtime.getCell(space, "item-other-writer", undefined, tx)
          .key("items").key(0 as never).key("name" as never)
          .set("evil" as never);
        expect(refusalOf(await tx.commit())).toContain("writeAuthorizedBy");
        expect(runtime.getCell(space, "item-other-writer", ITEMS).get())
          .toEqual(ITEMS_SEED);
      });
    });

    it("commits a write beneath a claimed root by its named writer", async () => {
      const runtime = start();
      const root = { type: "object", ifc: CLAIM } as const satisfies JSONSchema;
      await seed(runtime, "named-writer-under-root", root, { a: 1, b: 2 });
      const tx = runtime.edit();
      tx.setCfcTrustSnapshot({ id: `trust-${space}`, actingPrincipal: space });
      tx.setCfcImplementationIdentity({ kind: "builtin", builtinId: WRITER });
      runtime.getCell(space, "named-writer-under-root", undefined, tx).key("a")
        .set(3 as never);
      expect((await tx.commit()).error).toBeUndefined();
      expect(runtime.getCell(space, "named-writer-under-root", root).get())
        .toEqual({ a: 3, b: 2 });
    });

    for (
      const [kind, root] of [
        ["untyped", { ifc: CLAIM }],
        ["typed", { type: "object", ifc: CLAIM }],
      ] as const
    ) {
      it(`refuses a primitive written over an ${kind} claimed root`, async () => {
        const runtime = start();
        const id = `root-primitive-${kind}`;
        await seed(runtime, id, root as JSONSchema, { a: 1 });
        const tx = runtime.edit();
        runtime.getCell(space, id, undefined, tx).set(5 as never);
        expect(refusalOf(await tx.commit())).toContain("writeAuthorizedBy");
        expect(runtime.getCell(space, id, root as JSONSchema).get()).toEqual({
          a: 1,
        });
      });
    }
  });

  describe("a write to the document's metadata", () => {
    // A document's `result` field is metadata beside its value, not a key of
    // it, so writing it touches no claim on the value, not even one at a
    // path spelled `result` or under a wildcard.

    const WRITER = "metadata-builtin";
    const CLAIM = { writeAuthorizedBy: [WRITER] };

    const seed = async (
      runtime: Runtime,
      id: string,
      schema: JSONSchema,
      value: unknown,
    ) => {
      const tx = runtime.edit();
      tx.setCfcTrustSnapshot({ id: `trust-${space}`, actingPrincipal: space });
      tx.setCfcImplementationIdentity({ kind: "builtin", builtinId: WRITER });
      runtime.getCell(space, id, schema, tx).set(value as never);
      expect((await tx.commit()).error).toBeUndefined();
    };

    const writeResult = (
      runtime: Runtime,
      tx: IExtendedStorageTransaction,
      id: string,
    ) =>
      runtime.getCell(space, id, undefined, tx).setMetaRaw(
        "result",
        runtime.getCell(space, `${id}-result`).getAsLink(),
        rawMetaWriteAuthorization,
      );

    it("commits beside a claim on every item of the value", async () => {
      const runtime = start();
      const schema = {
        type: "array",
        items: { type: "string", ifc: CLAIM },
      } as const satisfies JSONSchema;
      await seed(runtime, "metadata-beside-items", schema, []);
      const tx = runtime.edit();
      runtime.getCell(space, "metadata-beside-items", schema, tx).set([]);
      writeResult(runtime, tx, "metadata-beside-items");
      expect((await tx.commit()).error).toBeUndefined();
    });

    it("commits beside a claim on a value key named `result`", async () => {
      const runtime = start();
      const schema = {
        type: "object",
        properties: {
          result: { type: "string", ifc: CLAIM },
          other: { type: "string" },
        },
      } as const satisfies JSONSchema;
      await seed(runtime, "metadata-beside-key", schema, {
        result: "r",
        other: "o",
      });
      const tx = runtime.edit();
      runtime.getCell(space, "metadata-beside-key", schema, tx).key("other")
        .set("changed");
      writeResult(runtime, tx, "metadata-beside-key");
      expect((await tx.commit()).error).toBeUndefined();
      expect(runtime.getCell(space, "metadata-beside-key", schema).get())
        .toEqual({ result: "r", other: "changed" });
    });

    it("still refuses a write to the claimed value key beside it", async () => {
      const runtime = start();
      const schema = {
        type: "object",
        properties: { result: { type: "string", ifc: CLAIM } },
      } as const satisfies JSONSchema;
      await seed(runtime, "metadata-and-key", schema, { result: "r" });
      const tx = runtime.edit();
      runtime.getCell(space, "metadata-and-key", schema, tx).key("result")
        .set("mallory");
      writeResult(runtime, tx, "metadata-and-key");
      expect(refusalOf(await tx.commit())).toContain("writeAuthorizedBy");
    });
  });

  describe("claims beneath a link", () => {
    // Where the document holds a link, the claims its schema describes beneath
    // it are the linked document's, which that document's own envelope
    // enforces. A new release of the linked pattern restamps them, and this
    // document's envelope follows. Held inline, the same claims are this
    // document's and stay bound.

    const writerOf = (moduleIdentity: string) => ({
      __ctWriterIdentityOf: {
        file: "/profile.tsx",
        path: ["setAvatar"],
        moduleIdentity,
      },
    });
    // The next release also adds a field, so the two envelopes merge rather
    // than differing by writer stamps alone.
    const profileSchema = (moduleIdentity: string) =>
      ({
        type: "object",
        properties: {
          avatar: {
            type: "string",
            ifc: { writeAuthorizedBy: writerOf(moduleIdentity) },
          },
          ...(moduleIdentity === "release-2" && { bio: { type: "string" } }),
        },
      }) as const;
    // The shape the home pattern gives its default profile: absent, or one
    // profile, whose release names the writer of its fields.
    // `guarded` gives the profile position, and each item of the list, a
    // writer claim of its own.
    const holderSchema = (moduleIdentity: string, guarded = false) =>
      ({
        type: "object",
        properties: {
          profile: {
            anyOf: [{ type: "undefined" }, { $ref: "#/$defs/Profile" }],
            ...(guarded && { ifc: { writeAuthorizedBy: ["profile-picker"] } }),
          },
          profiles: {
            type: "array",
            items: {
              anyOf: [{ type: "null" }, { $ref: "#/$defs/Profile" }],
              ...(guarded && {
                ifc: { writeAuthorizedBy: ["profile-picker"] },
              }),
            },
          },
          other: { type: "string" },
        },
        // A label, so the document stores an envelope.
        ifc: { ...WRITER_LABEL },
        $defs: { Profile: profileSchema(moduleIdentity) },
      }) as JSONSchema;

    const seedHolder = async (
      runtime: Runtime,
      id: string,
      value: (profile: unknown) => Record<string, unknown>,
      guarded = false,
      // `set` stores an object in a list as a document of its own, linked;
      // `raw` keeps it inline.
      raw = false,
    ) => {
      const profile = runtime.getCell(space, `${id}-profile`, {
        type: "object",
        ifc: { ...WRITER_LABEL },
      });
      {
        const tx = runtime.edit();
        profile.withTx(tx).set({ avatar: "a" } as never);
        expect((await tx.commit()).error).toBeUndefined();
      }
      const tx = runtime.edit();
      tx.setCfcTrustSnapshot({ id: `trust-${space}`, actingPrincipal: space });
      tx.setCfcImplementationIdentity({
        kind: "verified",
        moduleIdentity: "release-1",
        sourceFile: "/profile.tsx",
        bindingPath: ["setAvatar"],
      });
      const holder = runtime.getCell(
        space,
        id,
        holderSchema("release-1", guarded),
        tx,
      );
      const seeded = value(raw ? profile.getAsLink() : profile);
      if (raw) holder.setRaw(seeded as never);
      else holder.set(seeded as never);
      expect((await tx.commit()).error).toBeUndefined();
      return seeded;
    };

    // The holder's own next release rewrites its document whole, as a
    // pattern's setup does, changing only a field beside the profiles.
    const rewriteUnderNextRelease = async (
      runtime: Runtime,
      id: string,
      value: Record<string, unknown>,
      guarded = false,
      release: "authorized" | "unauthorized" | "none" = "authorized",
      raw = false,
    ) => {
      const tx = runtime.edit();
      tx.setCfcTrustSnapshot({ id: `trust-${space}`, actingPrincipal: space });
      if (release !== "none") {
        markRelease(runtime, tx, id, release === "authorized");
      }
      const holder = runtime.getCell(
        space,
        id,
        holderSchema("release-2", guarded),
        tx,
      );
      const next = { ...value, other: "changed" };
      if (raw) holder.setRaw(next as never);
      else holder.set(next as never);
      return await tx.commit();
    };

    it("follows a new release's claims beneath a linked profile", async () => {
      const runtime = start();
      const value = await seedHolder(runtime, "linked-profile", (profile) => ({
        profile,
        profiles: [profile],
        other: "o",
      }));
      expect(
        (await rewriteUnderNextRelease(runtime, "linked-profile", value))
          .error,
      ).toBeUndefined();
    });

    for (const release of ["none", "unauthorized"] as const) {
      it(`keeps the claims beneath a linked profile in a write that is no release (${release})`, async () => {
        // Only the runtime's release of the piece follows a new release's
        // claims; any other writer carrying the same schema keeps them.
        const runtime = start();
        const value = await seedHolder(runtime, `not-release-${release}`, (
          profile,
        ) => ({ profile, profiles: [], other: "o" }));
        expect(
          refusalOf(
            await rewriteUnderNextRelease(
              runtime,
              `not-release-${release}`,
              value,
              false,
              release,
            ),
          ),
        ).toContain("drops the stored writeAuthorizedBy at /profile/avatar");
      });
    }

    it("keeps the claims beneath an inline profile", async () => {
      const runtime = start();
      const value = await seedHolder(runtime, "inline-profile", (profile) => ({
        profile: { avatar: "a" },
        profiles: [profile],
        other: "o",
      }));
      expect(
        refusalOf(
          await rewriteUnderNextRelease(runtime, "inline-profile", value),
        ),
      ).toContain("at /profile/avatar");
    });

    it("follows a new release beneath a list of linked profiles", async () => {
      const runtime = start();
      const value = await seedHolder(runtime, "linked-list", (profile) => ({
        profile,
        profiles: [profile, profile],
        other: "o",
      }));
      expect(
        (await rewriteUnderNextRelease(runtime, "linked-list", value)).error,
      ).toBeUndefined();
    });

    it("follows a new release beneath an absent profile whose position names its writer", async () => {
      const runtime = start();
      const value = await seedHolder(
        runtime,
        "absent-guarded",
        () => ({ profiles: [], other: "o" }),
        true,
      );
      expect(
        (await rewriteUnderNextRelease(runtime, "absent-guarded", value, true))
          .error,
      ).toBeUndefined();

      // What may later come to be held there answers to the position's own
      // claim.
      const tx = runtime.edit();
      tx.setCfcTrustSnapshot({ id: `trust-${space}`, actingPrincipal: space });
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "mallory",
      });
      runtime.getCell(space, "absent-guarded", undefined, tx).key("profile")
        .set({ avatar: "inline" } as never);
      expect(refusalOf(await tx.commit())).toContain(
        "writeAuthorizedBy failed at /profile",
      );

      // The position's own writer holds no authority over the fields beneath:
      // an inline avatar answers to the avatar's writer, now release 2's.
      const picker = runtime.edit();
      picker.setCfcTrustSnapshot({
        id: `trust-${space}`,
        actingPrincipal: space,
      });
      picker.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "profile-picker",
      });
      runtime.getCell(space, "absent-guarded", undefined, picker)
        .key("profile").setRaw({ avatar: "inline" } as never);
      expect(refusalOf(await picker.commit())).toContain(
        "at /profile/avatar",
      );
    });

    it("keeps the claims beneath an absent profile whose position names no writer", async () => {
      const runtime = start();
      const value = await seedHolder(runtime, "absent-unguarded", () => ({
        profiles: [],
        other: "o",
      }));
      expect(
        refusalOf(
          await rewriteUnderNextRelease(runtime, "absent-unguarded", value),
        ),
      ).toContain("drops the stored writeAuthorizedBy at /profile/avatar");
    });

    it("keeps the claims beneath a list a release wrote an item of before rewriting it", async () => {
      // What the list held can't be told from the rewrite's own record once an
      // item beneath it was written first, and what can't be told relaxes
      // nothing.
      const runtime = start();
      const value = await seedHolder(runtime, "item-then-list", (profile) => ({
        profile,
        profiles: [profile],
        other: "o",
      }));
      const tx = runtime.edit();
      tx.setCfcTrustSnapshot({ id: `trust-${space}`, actingPrincipal: space });
      markRelease(runtime, tx, "item-then-list");
      const holder = runtime.getCell(
        space,
        "item-then-list",
        holderSchema("release-2"),
        tx,
      );
      tx.writeValueOrThrow(
        {
          ...holder.getAsNormalizedFullLink(),
          path: ["profiles", "0"],
        },
        runtime.getCell(space, "another-profile").getAsLink() as never,
      );
      const link = (cell: unknown) =>
        (cell as { getAsLink(): unknown }).getAsLink();
      holder.setRaw({
        profile: link(value.profile),
        profiles: (value.profiles as unknown[]).map(link),
        other: "changed",
      } as never);
      expect(refusalOf(await tx.commit())).toContain(
        "drops the stored writeAuthorizedBy",
      );
    });

    it("keeps the claims beneath a list holding one inline profile", async () => {
      const runtime = start();
      const value = await seedHolder(
        runtime,
        "mixed-list",
        (profile) => ({
          profile,
          profiles: [profile, { avatar: "a" }],
          other: "o",
        }),
        false,
        true,
      );
      expect(
        refusalOf(
          await rewriteUnderNextRelease(
            runtime,
            "mixed-list",
            value,
            false,
            "authorized",
            true,
          ),
        ),
      ).toContain("drops the stored writeAuthorizedBy at /profiles/*/avatar");
    });
  });

  describe("a release over a recursive definition", () => {
    // A release whose writes leave what the document held unknown along a
    // recursive definition compares it once per definition, as any write does.

    const NODE_WRITER = "node-writer";
    const NODE = {
      type: "object",
      properties: {
        label: { type: "string", ifc: { writeAuthorizedBy: [NODE_WRITER] } },
        next: { anyOf: [{ type: "null" }, { $ref: "#/$defs/Node" }] },
      },
      ifc: { ...WRITER_LABEL },
      $defs: {
        Node: {
          type: "object",
          properties: {
            label: {
              type: "string",
              ifc: { writeAuthorizedBy: [NODE_WRITER] },
            },
            next: { anyOf: [{ type: "null" }, { $ref: "#/$defs/Node" }] },
          },
        },
      },
    } as const satisfies JSONSchema;
    const SEED = { label: "a", next: { label: "b", next: null } };

    it("commits a release that writes beneath the document before rewriting it", async () => {
      const runtime = start();
      {
        const tx = runtime.edit();
        tx.setCfcTrustSnapshot({
          id: `trust-${space}`,
          actingPrincipal: space,
        });
        tx.setCfcImplementationIdentity({
          kind: "builtin",
          builtinId: NODE_WRITER,
        });
        runtime.getCell(space, "recursive-release", NODE, tx).set(
          SEED as never,
        );
        expect((await tx.commit()).error).toBeUndefined();
      }
      const tx = runtime.edit();
      tx.setCfcTrustSnapshot({ id: `trust-${space}`, actingPrincipal: space });
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: NODE_WRITER,
      });
      markRelease(runtime, tx, "recursive-release");
      const cell = runtime.getCell(space, "recursive-release", NODE, tx);
      cell.key("next").setRaw({ label: "c", next: null } as never);
      cell.setRaw({ label: "a", next: { label: "d", next: null } } as never);
      expect((await tx.commit()).error).toBeUndefined();
    });
  });

  describe("repointing a link", () => {
    // A link position's own claims govern who may point it elsewhere.
    // (`set` of an object at a link writes into the linked document, so the
    // tests that replace a link in this one use `setRaw`.) The
    // claims its schema describes beneath it belong to the linked document,
    // so they bind this document only where it holds that data inline:
    // replacing inline data with a link, or a link with inline data.

    const REPOINTER = "profile-picker";
    const AVATAR_WRITER = "profile-avatar";
    // Named by every claim, so a seed can hold a profile inline.
    const SEEDER = "holder-seed";
    const PROFILE = {
      type: "object",
      properties: {
        avatar: {
          type: "string",
          ifc: { writeAuthorizedBy: [AVATAR_WRITER, SEEDER] },
        },
      },
    } as const satisfies JSONSchema;
    const HOLDER = {
      type: "object",
      properties: {
        profile: {
          $ref: "#/$defs/Profile",
          ifc: { writeAuthorizedBy: [REPOINTER, SEEDER] },
        },
        profiles: {
          type: "array",
          items: {
            $ref: "#/$defs/Profile",
            ifc: { writeAuthorizedBy: [REPOINTER, SEEDER] },
          },
        },
      },
      ifc: { ...WRITER_LABEL },
      $defs: { Profile: PROFILE },
    } as const satisfies JSONSchema;

    const profileCell = async (runtime: Runtime, id: string) => {
      const cell = runtime.getCell(space, id, {
        type: "object",
        ifc: { ...WRITER_LABEL },
      });
      const tx = runtime.edit();
      cell.withTx(tx).set({ avatar: id } as never);
      expect((await tx.commit()).error).toBeUndefined();
      return cell;
    };

    const writeAs = async (
      runtime: Runtime,
      builtinIds: readonly string[],
      write: (tx: IExtendedStorageTransaction) => void,
    ) => {
      const tx = runtime.edit();
      tx.setCfcTrustSnapshot({ id: `trust-${space}`, actingPrincipal: space });
      // A builtin list claim names builtins; one identity per transaction,
      // so a write naming both writers runs as the one the test is about.
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: builtinIds[0],
      });
      write(tx);
      return await tx.commit();
    };

    const holder = (
      runtime: Runtime,
      id: string,
      tx: IExtendedStorageTransaction,
    ) => runtime.getCell(space, id, HOLDER, tx);

    const seedHolder = async (
      runtime: Runtime,
      id: string,
      value: Record<string, unknown>,
    ) => {
      const tx = runtime.edit();
      tx.setCfcTrustSnapshot({ id: `trust-${space}`, actingPrincipal: space });
      tx.setCfcImplementationIdentity({ kind: "builtin", builtinId: SEEDER });
      holder(runtime, id, tx).set(value as never);
      expect((await tx.commit()).error).toBeUndefined();
    };

    it("lets the position's named writer point it at another profile", async () => {
      const runtime = start();
      const a = await profileCell(runtime, "repoint-a");
      const b = await profileCell(runtime, "repoint-b");
      await seedHolder(runtime, "repoint-named", { profile: a, profiles: [] });
      expect(
        (await writeAs(
          runtime,
          [REPOINTER],
          (tx) =>
            holder(runtime, "repoint-named", tx).key("profile").set(
              b as never,
            ),
        )).error,
      ).toBeUndefined();
    });

    it("refuses another writer pointing the position at another profile", async () => {
      const runtime = start();
      const a = await profileCell(runtime, "other-a");
      const b = await profileCell(runtime, "other-b");
      await seedHolder(runtime, "repoint-other", { profile: a, profiles: [] });
      expect(
        refusalOf(
          await writeAs(
            runtime,
            ["mallory"],
            (tx) =>
              holder(runtime, "repoint-other", tx).key("profile").set(
                b as never,
              ),
          ),
        ),
      ).toContain("writeAuthorizedBy failed at /profile");
    });

    it("lets the position's named writer set an absent position and clear it", async () => {
      const runtime = start();
      const a = await profileCell(runtime, "absent-a");
      await seedHolder(runtime, "absent-to-link", { profiles: [] });
      expect(
        (await writeAs(
          runtime,
          [REPOINTER],
          (tx) =>
            holder(runtime, "absent-to-link", tx).key("profile").set(
              a as never,
            ),
        )).error,
      ).toBeUndefined();
      expect(
        (await writeAs(
          runtime,
          [REPOINTER],
          (tx) =>
            holder(runtime, "absent-to-link", tx).key("profile").setRaw(
              undefined as never,
            ),
        )).error,
      ).toBeUndefined();
    });

    it("refuses the position's writer replacing an inline profile with a link", async () => {
      const runtime = start();
      const a = await profileCell(runtime, "inline-to-link-a");
      await seedHolder(runtime, "inline-to-link", {
        profile: { avatar: "inline" },
        profiles: [],
      });
      expect(
        refusalOf(
          await writeAs(
            runtime,
            [REPOINTER],
            (tx) =>
              holder(runtime, "inline-to-link", tx).key("profile").set(
                a as never,
              ),
          ),
        ),
      ).toContain("writeAuthorizedBy failed at /profile/avatar");
    });

    it("refuses the position's writer replacing a link with an inline profile", async () => {
      const runtime = start();
      const a = await profileCell(runtime, "link-to-inline-a");
      await seedHolder(runtime, "link-to-inline", { profile: a, profiles: [] });
      expect(
        refusalOf(
          await writeAs(
            runtime,
            [REPOINTER],
            (tx) =>
              holder(runtime, "link-to-inline", tx).key("profile").setRaw(
                { avatar: "inline" } as never,
              ),
          ),
        ),
      ).toContain("writeAuthorizedBy failed at /profile/avatar");
    });

    it("keeps the claims beneath a profile a release first repoints and then rewrites inline", async () => {
      // Each write detail records the value its path held when it was made,
      // so a rewrite of the document after its profile was pointed at a link
      // sees the link rather than the inline profile stored before either.
      const runtime = start();
      const a = await profileCell(runtime, "ordering-a");
      await seedHolder(runtime, "ordering", {
        profile: { avatar: "x" },
        profiles: [],
      });
      const tx = runtime.edit();
      tx.setCfcTrustSnapshot({ id: `trust-${space}`, actingPrincipal: space });
      tx.setCfcImplementationIdentity({ kind: "builtin", builtinId: SEEDER });
      markRelease(runtime, tx, "ordering");
      tx.writeValueOrThrow({
        ...holder(runtime, "ordering", tx).getAsNormalizedFullLink(),
        path: ["profile"],
      }, a.getAsLink() as never);
      runtime.getCell(space, "ordering", {
        ...HOLDER,
        $defs: {
          Profile: {
            ...PROFILE,
            properties: {
              avatar: {
                type: "string",
                ifc: { writeAuthorizedBy: [REPOINTER, SEEDER] },
              },
            },
          },
        },
      } as JSONSchema, tx).setRaw(
        { profile: { avatar: "z" }, profiles: [] } as never,
      );
      expect(refusalOf(await tx.commit())).toContain("/profile/avatar");
    });

    it("judges each item of a list of links on its own previous and new value", async () => {
      const runtime = start();
      const a = await profileCell(runtime, "items-a");
      const b = await profileCell(runtime, "items-b");
      await seedHolder(runtime, "items", { profiles: [a, a] });
      expect(
        (await writeAs(
          runtime,
          [REPOINTER],
          (tx) =>
            holder(runtime, "items", tx).key("profiles").key(0 as never).set(
              b as never,
            ),
        )).error,
      ).toBeUndefined();
      expect(
        refusalOf(
          await writeAs(
            runtime,
            [REPOINTER],
            (tx) =>
              holder(runtime, "items", tx).key("profiles").setRaw(
                [b.getAsLink(), { avatar: "inline" }] as never,
              ),
          ),
        ),
      ).toContain("writeAuthorizedBy failed at /profiles/*/avatar");
    });
  });

  describe("the persisted envelope", () => {
    it("stores a merged schema document that holds no key without a value and that its JSON form hashes to", async () => {
      // A schema document is addressed by its hash, and a reader verifies the
      // content it loads against that address. A key present with no value
      // hashes differently from an absent one and does not survive a JSON
      // round trip, so a merged document carrying one would fail that check
      // wherever it crossed a JSON boundary.

      const runtime = start();
      const first = {
        type: "object",
        properties: {
          a: { type: "string", ifc: { confidentiality: ["store-clause"] } },
        },
      } as const satisfies JSONSchema;
      const second = {
        ...first,
        properties: { ...first.properties, b: { type: "string" } },
      } as const satisfies JSONSchema;
      expect((await commitWrite(runtime, "envelope", first, { a: "x" })).error)
        .toBeUndefined();
      expect(
        (await commitWrite(runtime, "envelope", second, { a: "x", b: "y" }))
          .error,
      ).toBeUndefined();

      const tx = runtime.edit();
      const link = runtime.getCell(space, "envelope", undefined, tx)
        .getAsNormalizedFullLink();
      const envelope = loadStoredCfcEnvelope(tx, link);
      expect(envelope.status).toBe("loaded");
      const { schemaHash } = (envelope as { metadata: { schemaHash: string } })
        .metadata;
      const stored = (tx.readOrThrow({
        space,
        id: `cid:${schemaHash}` as URI,
        type: "application/json",
        path: [],
      }) as { value?: unknown }).value;
      tx.abort("inspected");

      const keysWithoutValue: string[] = [];
      const walk = (node: unknown, at: string) => {
        if (node === null || typeof node !== "object") return;
        for (const [key, child] of Object.entries(node)) {
          if (child === undefined) keysWithoutValue.push(`${at}/${key}`);
          else walk(child, `${at}/${key}`);
        }
      };
      walk(stored, "");
      expect(keysWithoutValue).toEqual([]);
      expect((stored as { properties?: object }).properties).toHaveProperty(
        "b",
      );
      expect(
        internSchemaAsTaggedHashString(
          JSON.parse(JSON.stringify(stored)) as JSONSchema,
        ),
      ).toBe(schemaHash);
    });
  });

  describe("`uiContract`", () => {
    const STORED = {
      type: "string",
      ifc: { uiContract: { ...PIN_CONTRACT } },
    } as const satisfies JSONSchema;

    const read = (runtime: Runtime, id: string) =>
      runtime.getCell(space, id, STORED).get();

    it("refuses a labeled writer that has no trusted click", async () => {
      const runtime = start();
      await clickAt(runtime, "pin-labeled", STORED, "pinned");
      expect(read(runtime, "pin-labeled")).toBe("pinned");

      const result = await commitWrite(runtime, "pin-labeled", {
        type: "string",
        ifc: { ...WRITER_LABEL },
      }, "overwritten");
      expect(refusalOf(result)).toContain("missing trusted-event policy input");
      expect(read(runtime, "pin-labeled")).toBe("pinned");
    });

    it("refuses a labeled writer, and every writer after it, when the stored contract sits behind a reference", async () => {
      const REFERENCED = {
        type: "object",
        properties: { pin: { $ref: "#/$defs/Pin" } },
        required: ["pin"],
        $defs: { Pin: STORED },
      } as const satisfies JSONSchema;
      const runtime = start();
      await clickAt(runtime, "pin-referenced", REFERENCED, {
        pin: "pinned",
      });
      const pinned = runtime.getCell(space, "pin-referenced", REFERENCED);
      expect(pinned.get()).toEqual({ pin: "pinned" });

      const labeled = await commitWrite(runtime, "pin-referenced", {
        type: "object",
        properties: { pin: { type: "string", ifc: { ...WRITER_LABEL } } },
        required: ["pin"],
      }, { pin: "overwritten" });
      expect(refusalOf(labeled)).toContain(
        "missing trusted-event policy input",
      );
      const undeclared = await commitUndeclaredWrite(
        runtime,
        "pin-referenced",
        "pin",
        "overwritten",
      );
      expect(refusalOf(undeclared)).toContain(
        "missing trusted-event policy input",
      );
      expect(pinned.get()).toEqual({ pin: "pinned" });
    });

    for (
      const [shape, items] of [
        ["inline", { items: STORED }],
        ["behind a reference", {
          items: { $ref: "#/$defs/Pin" },
          $defs: { Pin: STORED },
        }],
      ] as const
    ) {
      it(`refuses a labeled writer that has no trusted click when the contract governs array items ${shape}`, async () => {
        const ITEMS = { type: "array", ...items } as JSONSchema;
        const id = `pin-items-${shape}`;
        const runtime = start();
        await clickAt(runtime, id, ITEMS, ["pinned"]);
        const pins = runtime.getCell(space, id, ITEMS);
        expect(pins.get()).toEqual(["pinned"]);

        const result = await commitWrite(runtime, id, {
          type: "array",
          items: { type: "string", ifc: { ...WRITER_LABEL } },
        }, ["overwritten"]);
        expect(refusalOf(result)).toContain(
          "missing trusted-event policy input",
        );
        expect(pins.get()).toEqual(["pinned"]);
      });
    }

    it("commits a labeled writer that does not restate the contract after a matching click", async () => {
      const runtime = start();
      await clickAt(runtime, "pin-labeled-click", STORED, "pinned");
      expect(read(runtime, "pin-labeled-click")).toBe("pinned");

      await clickAt(runtime, "pin-labeled-click", {
        type: "string",
        ifc: { ...WRITER_LABEL },
      }, "repinned");
      expect(read(runtime, "pin-labeled-click")).toBe("repinned");
    });

    it("commits a labeled writer after a matching click when a fresh session reads a decomposed stored envelope", async () => {
      // A decomposed envelope stores its root with the contract behind a
      // `cid:` reference. The session that stored it has closed, so the
      // schema registry no longer holds the referenced member, and this
      // session finds the contract only by recomposing the envelope from the
      // space, as the commit boundary does.

      const DECOMPOSED = {
        type: "object",
        properties: { pin: { $ref: "#/$defs/Pin" } },
        required: ["pin"],
        $defs: { Pin: STORED },
      } as const satisfies JSONSchema;
      const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
      try {
        const firstStorage = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const first = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: firstStorage,
          cfcDecomposedEnvelopes: true,
        });
        await clickAt(first, "pin-decomposed", DECOMPOSED, {
          pin: "pinned",
        });
        expect(first.getCell(space, "pin-decomposed", DECOMPOSED).get())
          .toEqual({ pin: "pinned" });
        await firstStorage.synced();
        await first.dispose();

        storageManager = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
          cfcDecomposedEnvelopes: true,
        });
        const cold = runtime.getCell(space, "pin-decomposed", DECOMPOSED);
        await cold.sync();
        expect(cold.get()).toEqual({ pin: "pinned" });
        await clickAt(runtime, "pin-decomposed", {
          type: "object",
          properties: { pin: { type: "string", ifc: { ...WRITER_LABEL } } },
          required: ["pin"],
        }, { pin: "repinned" });
        expect(cold.get()).toEqual({ pin: "repinned" });
      } finally {
        await runtime?.dispose();
        runtime = undefined;
        storageManager = undefined;
        await server.close();
      }
    });
  });
});
