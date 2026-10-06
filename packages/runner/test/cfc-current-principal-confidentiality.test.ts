import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { cfcAtom } from "@commonfabric/api/cfc";
import type { JSONValue } from "@commonfabric/api";
import { internSchema } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";

import { mergeCfcSchemaEnvelopes } from "../src/cfc/schema-merge.ts";
import { bindCurrentPrincipalConfidentiality } from "../src/cfc/current-principal-confidentiality.ts";
import { loadStoredCfcEnvelope } from "../src/cfc/prepare.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import { ContextualFlowControl } from "../src/cfc.ts";
import { registerSchemaDocument } from "../src/schema-registry.ts";
import { parseExternalSchemaRef } from "@commonfabric/data-model-schema/schema-refs";
import { externalizeSchema } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const ownerIdentity = await Identity.fromPassphrase(
  "principal confidentiality owner",
);
const visitorIdentity = await Identity.fromPassphrase(
  "principal confidentiality visitor",
);
const schema = {
  type: "array",
  items: { type: "string" },
  ifc: {
    confidentiality: [{
      type: "https://commonfabric.org/cfc/atom/User",
      subject: { __ctCurrentPrincipal: true },
    }],
  },
} as const;

const privateNotes = {
  type: "array",
  items: {
    type: "object",
    properties: { note: { type: "string" } },
    ifc: { confidentiality: [...schema.ifc.confidentiality] },
  },
  ifc: { confidentiality: [...schema.ifc.confidentiality] },
} as const;

type Note = { note: string };

/** The confidentiality stored for `link`'s document at exactly `path`. */
const storedConfidentialityAt = (
  runtime: Runtime,
  link: Parameters<typeof loadStoredCfcEnvelope>[1],
  path: readonly string[],
): unknown[] => {
  const tx = runtime.edit();
  try {
    const envelope = loadStoredCfcEnvelope(tx, link);
    if (envelope.status !== "loaded") {
      throw new Error(`No stored envelope: ${envelope.status}`);
    }
    return envelope.metadata.labelMap.entries
      .filter((entry) => entry.path.join("/") === path.join("/"))
      .flatMap((entry) => entry.label.confidentiality ?? []);
  } finally {
    tx.abort();
  }
};

describe("cfc-current-principal-confidentiality", () => {
  it("refuses creator placeholders inside alternatives or other atom subjects", () => {
    const clauses: JSONValue[] = [
      { anyOf: [schema.ifc.confidentiality[0]] },
      {
        type: "https://commonfabric.org/cfc/atom/Space",
        subject: { __ctCurrentPrincipal: true },
      },
    ];
    for (const clause of clauses) {
      expect(() =>
        bindCurrentPrincipalConfidentiality(
          { ifc: { confidentiality: [clause] } },
          ownerIdentity.did(),
        )
      ).toThrow(/CurrentPrincipal confidentiality requires a User subject/);
    }
  });

  it("preserves public definition names inside an external private schema", () => {
    const inner = {
      type: "object",
      ifc: { confidentiality: [cfcAtom.user(ownerIdentity.did())] },
      properties: { value: { $ref: "#/$defs/Public" } },
      $defs: { Public: { type: "string" } },
    } as const;
    const { taggedHashString } = internSchema(inner, true);
    registerSchemaDocument(taggedHashString, inner);
    const outer = {
      type: "object",
      properties: { secret: { $ref: `cid:${taggedHashString}` } },
      $defs: { Public: { type: "number" } },
    } as const;
    const candidateInner = {
      ...inner,
      ifc: {
        confidentiality: [
          cfcAtom.user(ownerIdentity.did()),
          cfcAtom.user(visitorIdentity.did()),
        ],
      },
    };
    const candidateHash = internSchema(candidateInner, true).taggedHashString;
    registerSchemaDocument(candidateHash, candidateInner);
    const merged = mergeCfcSchemaEnvelopes(outer, {
      ...outer,
      properties: { secret: { $ref: `cid:${candidateHash}` } },
    });
    const field = ContextualFlowControl.schemaAtPath(merged, [
      "secret",
      "value",
    ]);
    expect(
      typeof field === "boolean"
        ? field
        : ContextualFlowControl.resolveSchemaRefs(field),
    )
      .toMatchObject({ type: "string" });
  });

  it("retains an unchanged recursive confidential schema", () => {
    const declared = {
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: {
        Node: {
          type: "object",
          ifc: { confidentiality: [cfcAtom.user(ownerIdentity.did())] },
          properties: { next: { $ref: "#/$defs/Node" } },
        },
      },
    } as const;
    expect(mergeCfcSchemaEnvelopes(declared, declared)).toEqual(declared);
    const candidate = {
      ...declared,
      properties: { ...declared.properties, title: { type: "string" } },
      $defs: { ...declared.$defs, Unrelated: { type: "number" } },
    } as const;
    expect(mergeCfcSchemaEnvelopes(declared, candidate)).toMatchObject(
      candidate,
    );
  });

  it("retains a recursive private external schema through public evolution", () => {
    const node = {
      type: "object",
      ifc: { confidentiality: [cfcAtom.user(ownerIdentity.did())] },
      properties: { next: { $ref: "#/$defs/Node" } },
    } as const;
    const oldDocument = { $defs: { Node: node } } as const;
    const newDocument = {
      $defs: {
        Node: {
          ...node,
          properties: { ...node.properties, title: { type: "string" } },
        },
      },
    } as const;
    const oldHash = internSchema(oldDocument, true).taggedHashString;
    const newHash = internSchema(newDocument, true).taggedHashString;
    registerSchemaDocument(oldHash, oldDocument);
    registerSchemaDocument(newHash, newDocument);
    const stored = {
      properties: { node: { $ref: `cid:${oldHash}#/$defs/Node` } },
    };
    const candidate = {
      properties: { node: { $ref: `cid:${newHash}#/$defs/Node` } },
    };

    const merged = mergeCfcSchemaEnvelopes(stored, candidate);
    expect(
      (merged as { properties: { node: { $ref: string } } }).properties
        .node.$ref,
    ).toBe(`cid:${newHash}#/$defs/Node`);

    const changedDocument = {
      $defs: {
        Node: {
          ...node,
          ifc: { confidentiality: [cfcAtom.user(visitorIdentity.did())] },
        },
      },
    } as const;
    const changedHash = internSchema(changedDocument, true).taggedHashString;
    registerSchemaDocument(changedHash, changedDocument);
    expect(() =>
      mergeCfcSchemaEnvelopes(stored, {
        properties: {
          node: { $ref: `cid:${changedHash}#/$defs/Node` },
        },
      })
    ).toThrow(/Recursive confidentiality schema merging is unsupported/);
  });

  it("retains recursive schema references that carry no confidentiality", () => {
    const declared = {
      type: "object",
      ifc: { confidentiality: [cfcAtom.user(ownerIdentity.did())] },
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: {
        Node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/Node" }, anything: true },
        },
        Anything: true,
      },
    } as const;
    expect(mergeCfcSchemaEnvelopes(declared, declared)).toMatchObject(declared);
    const tightened = {
      ...declared,
      ifc: {
        confidentiality: [
          cfcAtom.user(ownerIdentity.did()),
          cfcAtom.user(visitorIdentity.did()),
        ],
      },
      properties: {
        ...declared.properties,
        anything: { $ref: "#/$defs/Anything" },
        optional: true,
      },
    } as const;
    expect(mergeCfcSchemaEnvelopes(declared, tightened)).toMatchObject(
      tightened,
    );
  });

  it("refuses unresolved references when merging changed confidentiality", () => {
    const declared = {
      type: "object",
      properties: { private: { $ref: "#/$defs/Missing" } },
      ifc: { confidentiality: [cfcAtom.user(ownerIdentity.did())] },
    } as const;
    expect(() =>
      mergeCfcSchemaEnvelopes(declared, {
        ...declared,
        ifc: {
          confidentiality: [
            cfcAtom.user(ownerIdentity.did()),
            cfcAtom.user(visitorIdentity.did()),
          ],
        },
      })
    ).toThrow(/Confidentiality merging requires resolved schemas/);
  });

  it("refuses changes to a recursive private reader policy", () => {
    const declared = {
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: {
        Node: {
          type: "object",
          ifc: { confidentiality: [cfcAtom.user(ownerIdentity.did())] },
          properties: { next: { $ref: "#/$defs/Node" } },
        },
      },
    } as const;
    expect(() =>
      mergeCfcSchemaEnvelopes(declared, {
        ...declared,
        $defs: {
          Node: {
            ...declared.$defs.Node,
            ifc: { confidentiality: [cfcAtom.user(visitorIdentity.did())] },
          },
        },
      })
    ).toThrow(/Recursive confidentiality schema merging is unsupported/);
  });

  it("adds an optional field within a recursive private declaration without changing its reader", () => {
    const declared = {
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: {
        Node: {
          type: "object",
          ifc: { confidentiality: [cfcAtom.user(ownerIdentity.did())] },
          properties: {
            next: { $ref: "#/$defs/Node" },
            previous: { $ref: "#/$defs/Node" },
          },
        },
      },
    } as const;
    const candidate = {
      ...declared,
      $defs: {
        Node: {
          ...declared.$defs.Node,
          properties: {
            previous: declared.$defs.Node.properties.previous,
            title: { type: "string" },
            next: declared.$defs.Node.properties.next,
          },
        },
      },
    } as const;
    const merged = mergeCfcSchemaEnvelopes(declared, candidate);
    expect(ContextualFlowControl.schemaAtPath(merged, ["node", "title"]))
      .toMatchObject({ type: "string" });
    expect(
      ContextualFlowControl.schemaAtPath(merged, ["node", "next", "title"]),
    ).toMatchObject({ type: "string" });
    const nextNode = ContextualFlowControl.schemaAtPath(merged, [
      "node",
      "next",
    ]);
    expect(
      typeof nextNode === "boolean"
        ? nextNode
        : ContextualFlowControl.resolveSchemaRefs(nextNode),
    ).toMatchObject({
      ifc: { confidentiality: [cfcAtom.user(ownerIdentity.did())] },
    });
  });

  it("preserves different stored readers at separate uses of one private definition", () => {
    const stored = {
      type: "object",
      properties: {
        first: {
          ...schema,
          ifc: { confidentiality: [cfcAtom.user(ownerIdentity.did())] },
        },
        second: {
          ...schema,
          ifc: { confidentiality: [cfcAtom.user(visitorIdentity.did())] },
        },
      },
    } as const;
    const candidate = {
      type: "object",
      properties: {
        first: { $ref: "#/$defs/Private" },
        second: { $ref: "#/$defs/Private" },
      },
      $defs: { Private: schema },
    } as const;
    expect(mergeCfcSchemaEnvelopes(stored, candidate)).toMatchObject(stored);
  });

  it("refuses reader replacement in referenced additional properties beside named fields", () => {
    const declared = {
      type: "object",
      ifc: { confidentiality: [cfcAtom.user(ownerIdentity.did())] },
      properties: { title: { type: "string" } },
      additionalProperties: { $ref: "#/$defs/Private" },
      $defs: {
        Private: {
          type: "string",
          ifc: { confidentiality: [cfcAtom.user(ownerIdentity.did())] },
        },
      },
    } as const;
    const candidate = {
      ...declared,
      $defs: {
        Private: {
          ...declared.$defs.Private,
          ifc: { confidentiality: [cfcAtom.user(visitorIdentity.did())] },
        },
      },
    } as const;
    expect(() => mergeCfcSchemaEnvelopes(declared, candidate))
      .toThrow(/confidentiality cannot be weakened/);
  });

  it("refuses reader replacement behind an external mixed-record reference", () => {
    const record = (reader: string) => ({
      type: "object",
      properties: { title: { type: "string" } },
      additionalProperties: { $ref: "#/$defs/Private" },
      $defs: {
        Private: {
          type: "string",
          ifc: { confidentiality: [cfcAtom.user(reader)] },
        },
      },
    } as const);
    const reference = (reader: string) => {
      const document = record(reader);
      const { taggedHashString } = internSchema(document, true);
      registerSchemaDocument(taggedHashString, document);
      return { $ref: `cid:${taggedHashString}` };
    };
    expect(() =>
      mergeCfcSchemaEnvelopes(
        reference(ownerIdentity.did()),
        reference(visitorIdentity.did()),
      )
    ).toThrow(/confidentiality cannot be weakened/);
  });

  it("refuses a concrete reader replacement hidden behind a schema reference", () => {
    const declared = {
      type: "object",
      properties: { books: { $ref: "#/$defs/Private" } },
    } as const;
    const withReader = (subject: string) => ({
      ...declared,
      $defs: {
        Private: {
          ...schema,
          ifc: { confidentiality: [cfcAtom.user(subject)] },
        },
      },
    });
    expect(() =>
      mergeCfcSchemaEnvelopes(
        withReader(ownerIdentity.did()),
        withReader(visitorIdentity.did()),
      )
    )
      .toThrow(/confidentiality cannot be weakened/);
  });

  it("binds held references to the source creator in the creation transaction and later writes", async () => {
    const storage = StorageManager.emulate({ as: ownerIdentity });
    const runtimes = [ownerIdentity, visitorIdentity].map((identity) =>
      new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager: storage,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
        cfcReadMaxConfidentiality: [cfcAtom.user(identity.did())],
        trustSnapshotProvider: () => ({
          id: identity.did(),
          actingPrincipal: identity.did(),
        }),
      })
    );
    const [owner, visitor] = runtimes;
    try {
      const tx = owner.edit();
      const source = owner.getCell<string[]>(
        ownerIdentity.did(),
        "linked-source",
        schema,
        tx,
      );
      source.set(["Solaris"]);
      const linked = owner.getCell(ownerIdentity.did(), "first-reference", {
        type: "object",
        properties: { books: { asCell: ["readonly"] } },
      }, tx);
      linked.set({ books: source });
      expect((await tx.commit().settled).error).toBeUndefined();
      await linked.sync();
      expect(linked.withTx(undefined).get()).toBeDefined();
      const later = visitor.edit();
      const another = visitor.getCell(ownerIdentity.did(), "later-reference", {
        type: "object",
        properties: { books: { asCell: ["readonly"] } },
      }, later);
      another.set({
        books: visitor.getCellFromLink(
          source.getAsNormalizedFullLink(),
          schema,
          undefined,
          {
            version: 1,
            entries: [{
              path: [],
              label: { confidentiality: [...schema.ifc.confidentiality] },
            }],
          },
        ),
      });
      expect((await later.commit().settled).error).toBeUndefined();
      await another.sync();
      expect(owner.getCellFromLink(another.getAsNormalizedFullLink()).get())
        .toBeDefined();
      expect(() => another.withTx(undefined).get()).toThrow(/read ceiling/);
    } finally {
      await storage.synced();
      for (const runtime of runtimes) await runtime.dispose();
      await storage.close();
    }
  });

  it("retains symbolic and concrete constraints while combining one transaction", () => {
    const concrete = cfcAtom.user(ownerIdentity.did());
    const merged = mergeCfcSchemaEnvelopes(schema, {
      ...schema,
      ifc: { confidentiality: [concrete] },
    });
    expect(merged).toMatchObject({
      ifc: { confidentiality: [schema.ifc.confidentiality[0], concrete] },
    });
  });
  it("binds a declaration to its creator and preserves it through another writer", async () => {
    const storageManager = StorageManager.emulate({ as: ownerIdentity });
    const runtimes = [ownerIdentity, visitorIdentity].map((identity) =>
      new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
        cfcReadMaxConfidentiality: [cfcAtom.user(identity.did())],
        trustSnapshotProvider: () => ({
          id: identity.did(),
          actingPrincipal: identity.did(),
        }),
      })
    );
    const [owner, visitor] = runtimes;
    try {
      const create = owner.edit();
      const source = owner.getCell<string[]>(
        ownerIdentity.did(),
        "inbox",
        schema,
        create,
      );
      source.set(["Solaris"]);
      expect((await create.commit().settled).error).toBeUndefined();
      await source.sync();
      const link = source.getAsNormalizedFullLink();
      expect(owner.getCellFromLink(link).get()).toEqual(["Solaris"]);
      expect(() => visitor.getCellFromLink(link).get()).toThrow(/read ceiling/);
      const submit = visitor.edit();
      visitor.getCellFromLink<string[]>(link, schema, submit).push("Piranesi");
      expect((await submit.commit().settled).error).toBeUndefined();
      expect(owner.getCellFromLink(link).get()).toEqual([
        "Solaris",
        "Piranesi",
      ]);
      expect(() => visitor.getCellFromLink(link).get()).toThrow(/read ceiling/);
    } finally {
      await storageManager.synced();
      for (const runtime of runtimes) await runtime.dispose();
      await storageManager.close();
    }
  });
  it("refuses a declaration without an authenticated creator", async () => {
    const storageManager = StorageManager.emulate({ as: ownerIdentity });
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
      trustSnapshotProvider: () => undefined,
    });
    try {
      const tx = runtime.edit();
      runtime.getCell<string[]>(ownerIdentity.did(), "unbound", schema, tx).set(
        [],
      );
      const result = await tx.commit().settled;
      expect(result.error).toBeDefined();
      expect(JSON.stringify(result.error)).toContain(
        "requires an authenticated creator",
      );
    } finally {
      await storageManager.synced();
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects replacing the creator with a literal visitor policy", async () => {
    const storageManager = StorageManager.emulate({ as: ownerIdentity });
    let actor = ownerIdentity.did();
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
      trustSnapshotProvider: () => ({ id: actor, actingPrincipal: actor }),
    });
    try {
      const create = runtime.edit();
      const inbox = runtime.getCell<string[]>(
        ownerIdentity.did(),
        "fixed-reader",
        schema,
        create,
      );
      inbox.set(["Solaris"]);
      expect((await create.commit().settled).error).toBeUndefined();
      await inbox.sync();
      actor = visitorIdentity.did();
      const change = runtime.edit();
      runtime.getCellFromLink<string[]>(inbox.getAsNormalizedFullLink(), {
        ...schema,
        ifc: { confidentiality: [cfcAtom.user(actor)] },
      }, change).push("Piranesi");
      const result = await change.commit().settled;
      expect(result.error).toBeDefined();
      expect(JSON.stringify(result.error)).toContain(
        "confidentiality cannot be weakened",
      );
    } finally {
      await storageManager.synced();
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("retains every stored reader clause when a symbolic declaration is ambiguous", async () => {
    const storageManager = StorageManager.emulate({ as: ownerIdentity });
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
      cfcReadMaxConfidentiality: [cfcAtom.user(visitorIdentity.did())],
      trustSnapshotProvider: () => ({
        id: "visitor",
        actingPrincipal: visitorIdentity.did(),
      }),
    });
    try {
      const create = runtime.edit();
      const inbox = runtime.getCell<string[]>(
        ownerIdentity.did(),
        "two-readers",
        {
          ...schema,
          ifc: {
            confidentiality: [
              cfcAtom.user(ownerIdentity.did()),
              cfcAtom.user(visitorIdentity.did()),
            ],
          },
        },
        create,
      );
      inbox.set(["Solaris"]);
      expect((await create.commit().settled).error).toBeUndefined();
      await inbox.sync();
      const link = inbox.getAsNormalizedFullLink();
      const append = runtime.edit();
      runtime.getCellFromLink<string[]>(link, schema, append).push("Piranesi");
      expect((await append.commit().settled).error).toBeUndefined();
      expect(() => runtime.getCellFromLink(link).get()).toThrow(/read ceiling/);
    } finally {
      await storageManager.synced();
      await runtime.dispose();
      await storageManager.close();
    }
  });

  for (const external of [false, true]) {
    it(`binds private fields reached through ${external ? "external" : "local"} schema definitions`, async () => {
      const storageManager = StorageManager.emulate({ as: ownerIdentity });
      const runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
        cfcReadMaxConfidentiality: [cfcAtom.user(ownerIdentity.did())],
        trustSnapshotProvider: () => ({
          id: "owner",
          actingPrincipal: ownerIdentity.did(),
        }),
      });
      try {
        const tx = runtime.edit();
        const declared = {
          type: "object",
          properties: { books: { $ref: "#/$defs/PrivateBooks" } },
          $defs: { PrivateBooks: schema },
          required: ["books"],
        } as const;
        const viewSchema = external ? externalizeSchema(declared) : declared;
        if (
          typeof viewSchema === "object" && "$ref" in viewSchema &&
          typeof viewSchema.$ref === "string"
        ) {
          tx.stageSchemaDocClosure(
            ownerIdentity.did(),
            parseExternalSchemaRef(viewSchema.$ref)!.taggedHash,
          );
        }
        const books = runtime.getCell<{ books: string[] }>(
          ownerIdentity.did(),
          "nested",
          viewSchema,
          tx,
        );
        books.set({ books: ["Solaris"] });
        expect((await tx.commit().settled).error).toBeUndefined();
        await books.sync();
        expect(books.withTx(undefined).get()).toEqual({ books: ["Solaris"] });
        const visitor = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager,
          cfcEnforcementMode: "enforce-strict",
          cfcFlowLabels: "persist",
          cfcReadMaxConfidentiality: [cfcAtom.user(visitorIdentity.did())],
          trustSnapshotProvider: () => ({
            id: "visitor",
            actingPrincipal: visitorIdentity.did(),
          }),
        });
        try {
          const link = books.getAsNormalizedFullLink();
          const visitorView = visitor.getCellFromLink<{ books: string[] }>(
            link,
            viewSchema,
          );
          expect(() => visitorView.get()).toThrow(/read ceiling/);
          const append = visitor.edit();
          visitorView.withTx(append).key("books").push("Piranesi");
          expect((await append.commit().settled).error).toBeUndefined();
          expect(books.withTx(undefined).get()).toEqual({
            books: ["Solaris", "Piranesi"],
          });
          expect(() => visitorView.get()).toThrow(/read ceiling/);
          const takeover = visitor.edit();
          const changedPolicy = {
            ...declared,
            $defs: {
              PrivateBooks: {
                ...schema,
                ifc: { confidentiality: [cfcAtom.user(visitorIdentity.did())] },
              },
            },
          };
          visitor.getCellFromLink<{ books: string[] }>(
            link,
            changedPolicy,
            takeover,
          )
            .key("books").push("Unauthorized replacement");
          expect((await takeover.commit().settled).error?.message)
            .toContain("confidentiality cannot be weakened");
        } finally {
          await visitor.dispose();
        }
      } finally {
        await storageManager.synced();
        await runtime.dispose();
        await storageManager.close();
      }
    });
  }

  describe("a document created under a labeled parent", () => {
    // The owner's runtime reads under a ceiling admitting only the owner, so
    // a label naming anyone else on the way to an item withholds it. The
    // visitor's runtime has none: an append reads the list it joins, which a
    // ceiling admitting only the visitor would withhold before any commit.

    const withOwnerAndVisitor = async (
      body: (owner: Runtime, visitor: Runtime) => Promise<void>,
    ) => {
      const storageManager = StorageManager.emulate({ as: ownerIdentity });
      const runtimes = [ownerIdentity, visitorIdentity].map((identity) =>
        new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager,
          cfcEnforcementMode: "enforce-strict",
          cfcFlowLabels: "persist",
          ...(identity === ownerIdentity
            ? { cfcReadMaxConfidentiality: [cfcAtom.user(identity.did())] }
            : {}),
          trustSnapshotProvider: () => ({
            id: identity.did(),
            actingPrincipal: identity.did(),
          }),
        })
      );
      try {
        await body(runtimes[0], runtimes[1]);
      } finally {
        await storageManager.synced();
        for (const runtime of runtimes) await runtime.dispose();
        await storageManager.close();
      }
    };

    const createList = async (
      owner: Runtime,
      listSchema: JSONSchema,
      initial: Note[],
    ) => {
      const create = owner.edit();
      const list = owner.getCell<Note[]>(
        ownerIdentity.did(),
        "notes",
        listSchema,
        create,
      );
      list.set(initial);
      expect((await create.commit().settled).error).toBeUndefined();
      await list.sync();
      return list.getAsNormalizedFullLink();
    };

    const appendAs = async (
      writer: Runtime,
      link: Awaited<ReturnType<typeof createList>>,
      listSchema: JSONSchema,
    ) => {
      const append = writer.edit();
      writer.getCellFromLink<Note[]>(link, listSchema, append).push({
        note: "Piranesi",
      });
      return (await append.commit().settled).error;
    };

    it("binds an item another principal appends to the owner of the list", async () => {
      await withOwnerAndVisitor(async (owner, visitor) => {
        const link = await createList(owner, privateNotes, []);
        expect(await appendAs(visitor, link, privateNotes)).toBeUndefined();

        const item = visitor.getCellFromLink<Note[]>(link, privateNotes)
          .key(0).resolveAsCell().getAsNormalizedFullLink();
        expect(item.id).not.toBe(link.id);
        const itemLabel = storedConfidentialityAt(visitor, item, []);
        expect(itemLabel).toContainEqual(cfcAtom.user(ownerIdentity.did()));
        expect(itemLabel).not.toContainEqual(
          cfcAtom.user(visitorIdentity.did()),
        );
        const slotLabel = storedConfidentialityAt(visitor, link, ["0"]);
        expect(slotLabel).toContainEqual(cfcAtom.user(ownerIdentity.did()));
        expect(slotLabel).not.toContainEqual(
          cfcAtom.user(visitorIdentity.did()),
        );
        expect(owner.getCellFromLink(link).get()).toEqual([
          { note: "Piranesi" },
        ]);
      });
    });

    it("binds a document nested in an appended item to the owner of the list", async () => {
      await withOwnerAndVisitor(async (owner, visitor) => {
        const withParts = {
          ...privateNotes,
          items: {
            ...privateNotes.items,
            properties: {
              ...privateNotes.items.properties,
              parts: { type: "array", items: privateNotes.items },
            },
          },
        } as const;
        const link = await createList(owner, withParts, []);
        const append = visitor.edit();
        visitor.getCellFromLink<(Note & { parts: Note[] })[]>(
          link,
          withParts,
          append,
        ).push({ note: "Piranesi", parts: [{ note: "Halls" }] });
        expect((await append.commit().settled).error).toBeUndefined();

        const items = visitor.getCellFromLink<(Note & { parts: Note[] })[]>(
          link,
          withParts,
        );
        const item = items.key(0).resolveAsCell().getAsNormalizedFullLink();
        const part = items.key(0).key("parts").key(0).resolveAsCell()
          .getAsNormalizedFullLink();
        expect(part.id).not.toBe(item.id);
        const partLabel = storedConfidentialityAt(visitor, part, []);
        expect(partLabel).toContainEqual(cfcAtom.user(ownerIdentity.did()));
        expect(partLabel).not.toContainEqual(
          cfcAtom.user(visitorIdentity.did()),
        );
        expect(owner.getCellFromLink(link).get()).toEqual([
          { note: "Piranesi", parts: [{ note: "Halls" }] },
        ]);
      });
    });

    it("binds an item the owner appends to the owner", async () => {
      await withOwnerAndVisitor(async (owner, visitor) => {
        const link = await createList(owner, privateNotes, []);
        expect(await appendAs(owner, link, privateNotes)).toBeUndefined();

        const item = visitor.getCellFromLink<Note[]>(link, privateNotes)
          .key(0).resolveAsCell().getAsNormalizedFullLink();
        const itemLabel = storedConfidentialityAt(visitor, item, []);
        expect(itemLabel).toContainEqual(cfcAtom.user(ownerIdentity.did()));
        expect(itemLabel).not.toContainEqual(
          cfcAtom.user(visitorIdentity.did()),
        );
        expect(owner.getCellFromLink(link).get()).toEqual([
          { note: "Piranesi" },
        ]);
      });
    });

    it("binds an appended item to its writer where the list names no reader", async () => {
      // The list is labeled for its space's readers, which names no `User`
      // for a creator-bound declaration to take.

      await withOwnerAndVisitor(async (owner, visitor) => {
        const spaceLabeled = {
          ...privateNotes,
          ifc: { confidentiality: [cfcAtom.space(ownerIdentity.did())] },
        };
        const link = await createList(owner, {
          ...spaceLabeled,
          items: { type: "object", properties: { note: { type: "string" } } },
        }, []);
        expect(await appendAs(visitor, link, spaceLabeled)).toBeUndefined();

        const item = visitor.getCellFromLink<Note[]>(link, spaceLabeled)
          .key(0).resolveAsCell().getAsNormalizedFullLink();
        const itemLabel = storedConfidentialityAt(visitor, item, []);
        expect(itemLabel).toContainEqual(cfcAtom.user(visitorIdentity.did()));
        expect(itemLabel).not.toContainEqual(
          cfcAtom.user(ownerIdentity.did()),
        );
      });
    });

    describe("a document that already existed", () => {
      // The visitor writes a document that existed before the transaction,
      // holding no labels, and links it into the owner's list. It is not a new
      // document, so its declaration binds to the visitor and not to the
      // list's owner.

      const linkExistingNote = async (
        owner: Runtime,
        visitor: Runtime,
        stage: (address: Omit<IMemorySpaceAddress, "path">) => Promise<void>,
        { alsoCreateForUser = false } = {},
      ) => {
        const link = await createList(owner, privateNotes, []);
        const note = visitor.getCell<Note>(ownerIdentity.did(), "existing");
        const noteLink = note.getAsNormalizedFullLink();
        await stage({
          space: noteLink.space,
          id: noteLink.id,
          scope: "space",
          type: "application/json",
        });
        const append = visitor.edit();
        const existing = visitor.getCellFromLink<Note>(
          noteLink,
          privateNotes.items,
          append,
        );
        existing.set({ note: "Piranesi" });
        if (alsoCreateForUser) {
          const forUser = visitor.getCell<Note>(
            ownerIdentity.did(),
            "existing",
            undefined,
            append,
            "user",
          );
          expect(forUser.getAsNormalizedFullLink().id).toBe(noteLink.id);
          forUser.set({ note: "Halls" });
        }
        visitor.getCellFromLink<Note[]>(link, privateNotes, append).push(
          existing,
        );
        expect((await append.commit().settled).error).toBeUndefined();
        return storedConfidentialityAt(visitor, noteLink, []);
      };

      it("binds a document stored as present but `undefined` to its writer", async () => {
        await withOwnerAndVisitor(async (owner, visitor) => {
          const noteLabel = await linkExistingNote(
            owner,
            visitor,
            async (address) => {
              const seed = visitor.edit();
              seed.writeOrThrow({ ...address, path: ["value"] }, undefined);
              expect((await seed.commit().settled).error).toBeUndefined();
            },
          );
          expect(noteLabel).toContainEqual(
            cfcAtom.user(visitorIdentity.did()),
          );
          expect(noteLabel).not.toContainEqual(
            cfcAtom.user(ownerIdentity.did()),
          );
        });
      });

      it("binds a document to its writer when the transaction creates one of the same id in another scope", async () => {
        await withOwnerAndVisitor(async (owner, visitor) => {
          const noteLabel = await linkExistingNote(
            owner,
            visitor,
            async (address) => {
              const seed = visitor.edit();
              seed.writeOrThrow({ ...address, path: ["value"] }, {
                note: "Solaris",
              });
              expect((await seed.commit().settled).error).toBeUndefined();
            },
            { alsoCreateForUser: true },
          );
          expect(noteLabel).toContainEqual(
            cfcAtom.user(visitorIdentity.did()),
          );
          expect(noteLabel).not.toContainEqual(
            cfcAtom.user(ownerIdentity.did()),
          );
        });
      });
    });

    it("keeps the stored readers of an existing list another principal appends a string to", async () => {
      // A string joins the list's own document rather than one of its own,
      // so the list's stored readers bind the declaration.

      await withOwnerAndVisitor(async (owner, visitor) => {
        const create = owner.edit();
        const list = owner.getCell<string[]>(
          ownerIdentity.did(),
          "strings",
          schema,
          create,
        );
        list.set(["Solaris"]);
        expect((await create.commit().settled).error).toBeUndefined();
        await list.sync();
        const link = list.getAsNormalizedFullLink();
        const append = visitor.edit();
        visitor.getCellFromLink<string[]>(link, schema, append).push(
          "Piranesi",
        );
        expect((await append.commit().settled).error).toBeUndefined();

        const listLabel = storedConfidentialityAt(visitor, link, []);
        expect(listLabel).toContainEqual(cfcAtom.user(ownerIdentity.did()));
        expect(listLabel).not.toContainEqual(
          cfcAtom.user(visitorIdentity.did()),
        );
        expect(owner.getCellFromLink(link).get()).toEqual([
          "Solaris",
          "Piranesi",
        ]);
      });
    });
  });
});
