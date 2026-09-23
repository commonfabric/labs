/**
 * Deterministic coverage for the engine's commit/read validation paths —
 * protocol-shape rejections, branch existence/range checks, and stored-row
 * decode guards. These branches otherwise only run on malformed input or
 * corrupt rows, so exercising them here keeps the coverage of this package
 * stable instead of flapping with timing-dependent suites.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import { applyCommit, close, type Engine, open, read } from "../v2/engine.ts";
import {
  CODEMIRROR_CHANGESET_CODEC,
  encodeMemoryBoundary,
  ProtocolError,
} from "../v2.ts";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { taggedHashStringOf } from "@commonfabric/data-model";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";

const withEngine = async (
  fn: (engine: Engine) => void | Promise<void>,
): Promise<void> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  try {
    await fn(engine);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
};

const setOp = (id: string, value: unknown) =>
  ({ op: "set", id, value: { value } }) as never;

const commit = (localSeq: number, extra: Record<string, unknown>) =>
  ({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [],
    ...extra,
  }) as never;

Deno.test("rejects a commit with no operations, observation, or preconditions", async () => {
  await withEngine((engine) => {
    assertThrows(
      () => applyCommit(engine, { sessionId: "s:a", commit: commit(1, {}) }),
      Error,
      "requires at least one operation",
    );
  });
});

Deno.test("rejects commits and reads against an unknown branch", async () => {
  await withEngine((engine) => {
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(1, {
            branch: "nope",
            operations: [setOp("of:fid1:a", 1)],
          }),
        }),
      Error,
      "unknown branch: nope",
    );
    assertThrows(
      () => read(engine, { id: "of:fid1:a", branch: "nope" } as never),
      Error,
      "unknown branch: nope",
    );
  });
});

Deno.test("rejects reads at a seq beyond the branch head", async () => {
  await withEngine((engine) => {
    assertThrows(
      () => read(engine, { id: "of:fid1:a", seq: 999 } as never),
      Error,
      "out of range",
    );
  });
});

Deno.test("rejects stored revision rows that decode to non-documents", async () => {
  await withEngine((engine) => {
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:fid1:bad", 1)] }),
    });
    // Corrupt the stored row in place: a VALID boundary encoding whose root
    // is an array, not the plain-object root every stored document must be.
    engine.database.prepare(
      `UPDATE revision SET data = :data WHERE id = 'of:fid1:bad'`,
    ).run({ data: encodeMemoryBoundary([1]) });
    assertThrows(
      () => read(engine, { id: "of:fid1:bad" } as never),
      Error,
      "stored documents must be plain object roots",
    );
  });
});

Deno.test("rejects stored revision rows with an unexpected op", async () => {
  await withEngine((engine) => {
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:fid1:odd", 1)] }),
    });
    engine.database.prepare(
      `UPDATE revision SET op = 'bogus' WHERE id = 'of:fid1:odd'`,
    ).run({});
    assertThrows(
      () => read(engine, { id: "of:fid1:odd" } as never),
      Error,
      "unexpected stored revision op",
    );
  });
});

Deno.test("a valid set still reads back after the validation batteries", async () => {
  await withEngine((engine) => {
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:fid1:ok", 7)] }),
    });
    assertEquals(read(engine, { id: "of:fid1:ok" } as never), { value: 7 });
  });
});

Deno.test("admits no operation but `set` against a content-addressed document", async () => {
  await withEngine((engine) => {
    const schema = { type: "string", title: "immutable" } as const;
    const id = `cid:${internSchemaAsTaggedHashString(schema)}`;
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp(id, schema)] }),
    });
    // Every operation the protocol carries beside `set`, so that an
    // operation added to the union is refused here by default rather
    // than admitted by an enumeration that forgot it. `sqlite` writes no
    // entity and so names no id.
    const refused = [
      { op: "delete", id },
      { op: "patch", id, patches: [] },
      {
        op: "apply-op",
        id,
        path: ["text"],
        codec: CODEMIRROR_CHANGESET_CODEC,
        submissionId: "sub-1",
        base: null,
        payload: [],
      },
      {
        op: "release-op-field",
        id,
        path: ["text"],
        codec: CODEMIRROR_CHANGESET_CODEC,
        cursor: { epoch: 1, version: 1 },
      },
    ];
    for (const [index, operation] of refused.entries()) {
      assertThrows(
        () =>
          applyCommit(engine, {
            sessionId: "s:a",
            commit: commit(2 + index, { operations: [operation] as never }),
          }),
        ProtocolError,
        `cannot ${operation.op} content-addressed document`,
      );
    }
    // An idempotent re-set stays legal: it is how writers install closures.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2 + refused.length, {
        operations: [setOp(id, schema)],
      }),
    });
  });
});

Deno.test("compares content-addressed sets by content inside special objects", async () => {
  await withEngine((engine) => {
    // A special object keeps its state in private fields, which a naive
    // structural walk conflates across distinct instances (CT-1770); the
    // guard compares canonical content, so a difference inside one is a
    // difference.
    const bytesDoc = (byte: number) => ({
      payload: new FabricBytes(new Uint8Array([byte])),
    });
    const id = `cid:${taggedHashStringOf(bytesDoc(1))}`;
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(1, {
            operations: [setOp(id, bytesDoc(1)), setOp(id, bytesDoc(2))],
          }),
        }),
      ProtocolError,
      "conflicting sets of content-addressed document",
    );
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, { operations: [setOp(id, bytesDoc(1))] }),
    });
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(3, { operations: [setOp(id, bytesDoc(2))] }),
        }),
      ProtocolError,
      "cannot change content-addressed document",
    );
  });
});

Deno.test("accepts a content-addressed document whose content hashes to its id", async () => {
  await withEngine((engine) => {
    // A string, through the general content hash...
    const code = "export const answer = 42;";
    const codeId = `cid:${taggedHashStringOf(code)}`;
    // ...an object that is not a schema, through the same hash...
    const blob = { kind: "blob", bytes: [1, 2, 3] };
    const blobId = `cid:${taggedHashStringOf(blob)}`;
    // ...and a schema, through the schema hash.
    const schema = { type: "string", title: "accepted" } as const;
    const schemaId = `cid:${internSchemaAsTaggedHashString(schema)}`;
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, {
        operations: [
          setOp(codeId, code),
          setOp(blobId, blob),
          setOp(schemaId, schema),
        ],
      }),
    });
    assertEquals(read(engine, { id: codeId, branch: "" }), { value: code });
    assertEquals(read(engine, { id: blobId, branch: "" }), { value: blob });
    assertEquals(read(engine, { id: schemaId, branch: "" }), {
      value: schema,
    });
  });
});

Deno.test("rejects a content-addressed document whose content hashes to neither its id nor its schema id", async () => {
  await withEngine((engine) => {
    const codeId = `cid:${taggedHashStringOf("export const answer = 42;")}`;
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(1, {
            operations: [setOp(codeId, "export const answer = 43;")],
          }),
        }),
      ProtocolError,
      "whose content does not hash to its id",
    );
    // A schema under an id that is neither of its hashes is refused too.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(2, {
            operations: [setOp("cid:fid1:placeholder", { type: "string" })],
          }),
        }),
      ProtocolError,
      "whose content does not hash to its id",
    );
  });
});

Deno.test("rejects a set that changes a content-addressed document", async () => {
  await withEngine((engine) => {
    const settled = { type: "string", title: "settled" } as const;
    const settledId = `cid:${internSchemaAsTaggedHashString(settled)}`;
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp(settledId, settled)] }),
    });
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(2, {
            operations: [setOp(settledId, { type: "number" })],
          }),
        }),
      ProtocolError,
      "cannot change content-addressed document",
    );
    const conflicted = { type: "string", title: "conflicted" } as const;
    const conflictedId = `cid:${internSchemaAsTaggedHashString(conflicted)}`;
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(3, {
            operations: [
              setOp(conflictedId, conflicted),
              setOp(conflictedId, { type: "number" }),
            ],
          }),
        }),
      ProtocolError,
      "conflicting sets of content-addressed document",
    );
    // Identical duplicate sets within one commit are the idempotent case.
    const duplicated = { type: "boolean", title: "duplicated" } as const;
    const duplicatedId = `cid:${internSchemaAsTaggedHashString(duplicated)}`;
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(4, {
        operations: [
          setOp(duplicatedId, duplicated),
          setOp(duplicatedId, duplicated),
        ],
      }),
    });
  });
});

Deno.test("rejects a content-addressed document written at a non-space scope", async () => {
  await withEngine((engine) => {
    // A scoped partition could hold a divergent copy under one cid: id —
    // the immutability check reads at the operation's scope, and readers
    // resolve cid: documents at space scope only.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          principal: "did:key:alice",
          commit: commit(1, {
            operations: [{
              op: "set",
              id: "cid:fid1:scoped",
              scope: "user",
              value: { value: { type: "string" } },
            } as never],
          }),
        }),
      ProtocolError,
      "cannot write content-addressed document cid:fid1:scoped at user scope",
    );
  });
});

Deno.test("validates the schema closure a commit's content references", async () => {
  await withEngine((engine) => {
    const leafSchema = { type: "string", title: "closure-leaf" } as const;
    const leafHash = internSchemaAsTaggedHashString(leafSchema);
    const rootSchema = {
      type: "object",
      properties: { x: { $ref: `cid:${leafHash}` } },
    } as const;
    const rootHash = internSchemaAsTaggedHashString(rootSchema);
    const carrier = (target: string) => ({
      linked: {
        "/": {
          "link@1": {
            id: target,
            path: [],
            schema: { $ref: `cid:${rootHash}` },
          },
        },
      },
    });

    // A reference nothing backs is rejected outright.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(1, {
            operations: [setOp("of:closure-carrier", carrier("of:t1"))],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // The whole closure included in the SAME commit is accepted...
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        operations: [
          setOp("of:closure-carrier", carrier("of:t1")),
          setOp(`cid:${rootHash}`, rootSchema),
          setOp(`cid:${leafHash}`, leafSchema),
        ],
      }),
    });

    // ...and once stored, it satisfies later commits by itself.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(3, {
        operations: [setOp("of:closure-carrier-2", carrier("of:t2"))],
      }),
    });
  });
});

Deno.test("rejects incomplete or forged closures included in a commit", async () => {
  await withEngine((engine) => {
    const leafSchema = { type: "number", title: "partial-leaf" } as const;
    const leafHash = internSchemaAsTaggedHashString(leafSchema);
    const rootSchema = {
      type: "object",
      properties: { y: { $ref: `cid:${leafHash}` } },
    } as const;
    const rootHash = internSchemaAsTaggedHashString(rootSchema);

    // Installing the root without its dependency is an incomplete closure:
    // the walk is transitive.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(1, {
            operations: [setOp(`cid:${rootHash}`, rootSchema)],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // Forged content under a referenced id is rejected by the identity
    // check on its own install, so a forged first-install cannot back a
    // reference.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(2, {
            operations: [
              setOp(`cid:${rootHash}`, rootSchema),
              setOp(`cid:${leafHash}`, { type: "boolean", title: "forged" }),
            ],
          }),
        }),
      ProtocolError,
      "whose content does not hash to its id",
    );

    // Content that verifies against its id but is not a schema cannot back
    // a schema reference either: a code document's string is content the
    // namespace holds, and no schema.
    const code = "export const notASchema = true;";
    const codeId = `cid:${taggedHashStringOf(code)}`;
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(2, {
            operations: [
              setOp(codeId, code),
              setOp("of:code-as-schema-carrier", {
                linked: {
                  "/": {
                    "link@1": {
                      id: "of:code-as-schema-target",
                      path: [],
                      schema: { $ref: codeId },
                    },
                  },
                },
              }),
            ],
          }),
        }),
      ProtocolError,
      "whose included content does not verify",
    );

    // A patch's own values introduce requirements too.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(3, {
        operations: [setOp("of:patched-carrier", { plain: true })],
      }),
    });
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(4, {
            operations: [{
              op: "patch",
              id: "of:patched-carrier",
              patches: [{
                op: "add",
                path: "/value/linked",
                value: {
                  "/": {
                    "link@1": {
                      id: "of:patched-target",
                      path: [],
                      schema: { $ref: `cid:${rootHash}` },
                    },
                  },
                },
              }],
            } as never],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );
  });
});

Deno.test("serves a repeat schema reference from the per-engine verification cache", async () => {
  await withEngine((engine) => {
    const leaf = { type: "string", title: "cache-hit-leaf" } as const;
    const leafHash = internSchemaAsTaggedHashString(leaf);
    const schema = {
      type: "object",
      properties: { x: { $ref: `cid:${leafHash}` } },
    } as const;
    const hash = internSchemaAsTaggedHashString(schema);
    const carrier = (target: string) => ({
      linked: {
        "/": {
          "link@1": {
            id: target,
            path: [],
            schema: { $ref: `cid:${hash}` },
          },
        },
      },
    });
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, {
        operations: [
          setOp(`cid:${hash}`, schema),
          setOp(`cid:${leafHash}`, leaf),
        ],
      }),
    });
    // The first stored-backed reference verifies by re-hashing the stored
    // content and caches the verdict...
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        operations: [setOp("of:cache-carrier-1", carrier("of:t1"))],
      }),
    });
    // ...and a repeat reference is served from that cache: the document is
    // immutable, so its unchanged seq revalidates it without re-hashing,
    // and the cached entry re-enqueues its own dependencies.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(3, {
        operations: [setOp("of:cache-carrier-2", carrier("of:t2"))],
      }),
    });
    assertEquals(read(engine, { id: "of:cache-carrier-2" } as never), {
      value: carrier("of:t2"),
    });
  });
});

Deno.test("rejects a reference backed by a stored cid: document holding other content", async () => {
  await withEngine((engine) => {
    const claimed = { type: "string", title: "impostor-claim" } as const;
    const claimedHash = internSchemaAsTaggedHashString(claimed);
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, {
        operations: [setOp(`cid:${claimedHash}`, claimed)],
      }),
    });
    // The commit API admits nothing under an id its content does not hash
    // to, so an impostor reaches storage only out of band — modeled here by
    // direct database manipulation, as genuine corruption would.
    const forged = encodeMemoryBoundary({
      value: { type: "boolean", title: "impostor" },
    });
    engine.database.prepare(
      `UPDATE revision SET data = :data, seq = seq + 1 WHERE id = :id`,
    ).run({ data: forged, id: `cid:${claimedHash}` });
    engine.database.prepare(
      `UPDATE head SET seq = seq + 1 WHERE id = :id`,
    ).run({ id: `cid:${claimedHash}` });
    // It cannot back a schema reference: satisfaction re-hashes the stored
    // content against the id the reference claims.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(2, {
            operations: [
              setOp("of:impostor-carrier", {
                linked: {
                  "/": {
                    "link@1": {
                      id: "of:impostor-target",
                      path: [],
                      schema: { $ref: `cid:${claimedHash}` },
                    },
                  },
                },
              }),
            ],
          }),
        }),
      ProtocolError,
      "whose stored content does not verify",
    );
  });
});

Deno.test("treats an $alias-shaped record as plain data at the commit boundary", async () => {
  await withEngine((engine) => {
    // An alias is a binding only by context. To the commit boundary this
    // record is plain data, so the `cid:` ref inside its `schema` member
    // creates no closure obligation — a document that merely looks like a
    // binding must never have its commit rejected over one.
    const hash = internSchemaAsTaggedHashString({
      type: "string",
      title: "alias-data-leaf",
    });
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, {
        operations: [
          setOp("of:alias-data-carrier", {
            bound: {
              $alias: {
                cell: "argument",
                path: ["field"],
                schema: { $ref: `cid:${hash}` },
              },
            },
          }),
        ],
      }),
    });
    assertEquals(
      read(engine, { id: "of:alias-data-carrier" } as never) !== null,
      true,
    );
  });
});
Deno.test("applies an identical content-addressed re-set as a no-op", async () => {
  await withEngine((engine) => {
    const schema = { type: "string", title: "elided-re-set" } as const;
    const id = `cid:${internSchemaAsTaggedHashString(schema)}`;
    const install = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp(id, schema)] }),
    });
    assertEquals(install.revisions.length, 1);
    assertEquals(install.elidedOpIndexes, undefined);
    const headSeq = engine.database.prepare(
      `SELECT seq FROM head WHERE id = :id`,
    ).get<{ seq: number }>({ id })!.seq;

    // The identical re-set is proven unchanged by the immutability
    // comparison, so it applies as a no-op: no revision, no head advance —
    // and therefore nothing for fan-out to deliver — while the commit
    // itself still records and advances the space log.
    const reSet = applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        operations: [
          setOp(id, schema),
          setOp(id, schema),
          setOp("of:elide-bystander", { n: 1 }),
        ],
      }),
    });
    assertEquals(reSet.seq > install.seq, true);
    assertEquals(reSet.elidedOpIndexes, [0, 1]);
    assertEquals(reSet.revisions.map((revision) => revision.id), [
      "of:elide-bystander",
    ]);
    const after = engine.database.prepare(
      `SELECT seq FROM head WHERE id = :id`,
    ).get<{ seq: number }>({ id })!.seq;
    assertEquals(after, headSeq);

    // A differing re-set still cannot slip through as an elision.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(3, {
            operations: [setOp(id, { type: "number", title: "changed" })],
          }),
        }),
      ProtocolError,
      "cannot change content-addressed document",
    );
  });
});

Deno.test("a replayed eliding commit reports its elision again", async () => {
  await withEngine((engine) => {
    const schema = { type: "string", title: "replayed-elision" } as const;
    const id = `cid:${internSchemaAsTaggedHashString(schema)}`;
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp(id, schema)] }),
    });
    const elidingCommit = commit(2, { operations: [setOp(id, schema)] });
    const first = applyCommit(engine, {
      sessionId: "s:a",
      commit: elidingCommit,
    });
    assertEquals(first.elidedOpIndexes, [0]);
    // The replay returns the stored result — including the elision report,
    // which persisted no revision and must be re-derived, or the accept
    // path would classify the unchanged document as dirty.
    const replayed = applyCommit(engine, {
      sessionId: "s:a",
      commit: elidingCommit,
    });
    assertEquals(replayed.seq, first.seq);
    assertEquals(replayed.elidedOpIndexes, [0]);
    assertEquals(replayed.revisions, []);
  });
});

Deno.test("validates the schema document a result's `schema` metadata references", async () => {
  await withEngine((engine) => {
    const resultSchema = {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    } as const;
    const resultHash = internSchemaAsTaggedHashString(resultSchema);
    const docWithSchemaMeta = (id: string, hash: string) =>
      ({
        op: "set",
        id,
        value: { value: { title: "v" }, schema: { $ref: `cid:${hash}` } },
      }) as never;

    // The reserved root `schema` member is a schema position in the link
    // spelling: a reference nothing backs is the same broken closure a
    // dangling link `$ref` would create.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(1, {
            operations: [docWithSchemaMeta("of:result-carrier", resultHash)],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // The document included in the SAME commit is accepted...
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        operations: [
          docWithSchemaMeta("of:result-carrier", resultHash),
          setOp(`cid:${resultHash}`, resultSchema),
        ],
      }),
    });

    // ...and once stored, it satisfies later metadata by itself.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(3, {
        operations: [docWithSchemaMeta("of:result-carrier-2", resultHash)],
      }),
    });

    // A patch landing a reference AT the member is validated through the
    // post-patch document, like a patch landing a CFC envelope.
    const missingSchema = {
      type: "object",
      properties: { later: { type: "number" } },
    } as const;
    const missingHash = internSchemaAsTaggedHashString(missingSchema);
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(4, {
            operations: [
              {
                op: "patch",
                id: "of:result-carrier",
                patches: [{
                  op: "replace",
                  path: "/schema",
                  value: { $ref: `cid:${missingHash}` },
                }],
              } as never,
            ],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // Moving document content into the member is the same landing.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(5, {
        operations: [{
          op: "set",
          id: "of:move-result-carrier",
          value: { value: { hoard: { $ref: `cid:${missingHash}` } } },
        } as never],
      }),
    });
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(6, {
            operations: [
              {
                op: "patch",
                id: "of:move-result-carrier",
                patches: [{
                  op: "move",
                  from: "/value/hoard",
                  path: "/schema",
                }],
              } as never,
            ],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // The same move with the document backing it lands.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(7, {
        operations: [
          setOp(`cid:${missingHash}`, missingSchema),
          {
            op: "patch",
            id: "of:move-result-carrier",
            patches: [{ op: "move", from: "/value/hoard", path: "/schema" }],
          } as never,
        ],
      }),
    });
    assertEquals(
      (read(engine, { id: "of:move-result-carrier" } as never) as {
        schema?: unknown;
      })?.schema,
      { $ref: `cid:${missingHash}` },
    );

    // The member's grammar has two forms. A `cid:` reference in any other
    // position — nested inside an inline schema, or a root reference with
    // sibling keywords — is refused outright, as is a non-schema value,
    // whether a set or a patch lands it, before any backing is consulted.
    const hybridNested = {
      type: "object",
      properties: { nested: { $ref: `cid:${resultHash}` } },
    };
    const hybridSiblings = { $ref: `cid:${resultHash}`, title: "sibling" };
    for (const malformed of [null, hybridNested, hybridSiblings]) {
      assertThrows(
        () =>
          applyCommit(engine, {
            sessionId: "s:a",
            commit: commit(8, {
              operations: [{
                op: "set",
                id: "of:hybrid-carrier",
                value: { value: { title: "v" }, schema: malformed },
              } as never],
            }),
          }),
        ProtocolError,
        "malformed schema metadata",
      );
      assertThrows(
        () =>
          applyCommit(engine, {
            sessionId: "s:a",
            commit: commit(8, {
              operations: [{
                op: "patch",
                id: "of:result-carrier",
                patches: [{ op: "replace", path: "/schema", value: malformed }],
              } as never],
            }),
          }),
        ProtocolError,
        "malformed schema metadata",
      );
    }

    // Every `cid:` document carries the member the same way: content
    // addressing hashes `.value` alone, so a schema document and a blob
    // whose value happens to be schema-shaped are indistinguishable, and
    // the member is validated like an ordinary document's on both. Backed
    // lands; unbacked is refused. A forged backing cannot exist: the install
    // that would supply it is itself refused by the content identity check,
    // which is what the commit below trips.
    const blob = { bytes: "not a schema" };
    const blobId = `cid:${taggedHashStringOf(blob)}`;
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(9, {
            operations: [{
              op: "set",
              id: blobId,
              value: { value: blob, schema: { $ref: "cid:fid1:unbacked" } },
            } as never],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );
    const forgedSchema = { type: "object", title: "forged" } as const;
    const forgedHash = internSchemaAsTaggedHashString(forgedSchema);
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(9, {
            operations: [
              {
                op: "set",
                id: blobId,
                value: { value: blob, schema: { $ref: `cid:${forgedHash}` } },
              } as never,
              setOp(`cid:${forgedHash}`, { ...forgedSchema, title: "other" }),
            ],
          }),
        }),
      ProtocolError,
      "whose content does not hash to its id",
    );
    const blobWithMeta = {
      op: "set",
      id: blobId,
      value: { value: blob, schema: { $ref: `cid:${resultHash}` } },
    } as never;
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(9, { operations: [blobWithMeta] }),
    });
    const schemaShaped = { type: "boolean", title: "schema-shaped" } as const;
    const schemaShapedId = `cid:${
      internSchemaAsTaggedHashString(schemaShaped)
    }`;
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(10, {
            operations: [{
              op: "set",
              id: schemaShapedId,
              value: {
                value: schemaShaped,
                schema: { $ref: "cid:fid1:unbacked" },
              },
            } as never],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(10, {
        operations: [{
          op: "set",
          id: schemaShapedId,
          value: { value: schemaShaped, schema: { $ref: `cid:${resultHash}` } },
        } as never],
      }),
    });

    // The member rides the `cid:` immutability rule with the rest of the
    // envelope: an identical re-set is the idempotent install, a re-set
    // that changes the member is a change to a content-addressed document.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(11, { operations: [blobWithMeta] }),
    });
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(12, {
            operations: [{
              op: "set",
              id: blobId,
              value: { value: blob, schema: { $ref: `cid:${missingHash}` } },
            } as never],
          }),
        }),
      ProtocolError,
      "cannot change content-addressed document",
    );
  });
});

Deno.test("validates the schema document a CFC envelope's schemaHash references", async () => {
  await withEngine((engine) => {
    const envelopeSchema = {
      type: "object",
      properties: { field: { type: "string" } },
      ifc: { confidentiality: ["secret"] },
    } as const;
    const envelopeHash = internSchemaAsTaggedHashString(envelopeSchema);
    const docWithMetadata = (schemaHash: string) =>
      ({
        op: "set",
        id: "of:envelope-carrier",
        value: {
          value: { field: "v" },
          cfc: {
            version: 1,
            schemaHash,
            labelMap: { version: 1, entries: [] },
          },
        },
      }) as never;

    // Metadata naming a document nothing backs is rejected — the same
    // broken closure a dangling link `$ref` would create, spelled as a
    // bare hash at the reserved `cfc` position.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(1, {
            operations: [docWithMetadata(envelopeHash)],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // The document included in the SAME commit is accepted...
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, {
        operations: [
          docWithMetadata(envelopeHash),
          setOp(`cid:${envelopeHash}`, envelopeSchema),
        ],
      }),
    });

    // ...and once stored, it satisfies later metadata by itself.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(3, {
        operations: [docWithMetadata(envelopeHash)],
      }),
    });

    // The boundary polices backing, not spelling: a `schemaHash` in any
    // format is the reference, and one no content can verify against is
    // permanently unbackable — refused here rather than reading as
    // unreadable later.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(4, {
            operations: [
              {
                op: "set",
                id: "of:junk-envelope-carrier",
                value: {
                  value: { field: "v" },
                  cfc: {
                    version: 1,
                    schemaHash: "seed-schema",
                    labelMap: { version: 1, entries: [] },
                  },
                },
              } as never,
            ],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // The patch spelling of the same landing is validated too.
    const missingSchema = {
      type: "object",
      properties: { other: { type: "number" } },
    } as const;
    const missingHash = internSchemaAsTaggedHashString(missingSchema);
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(5, {
            operations: [
              {
                op: "patch",
                id: "of:envelope-carrier",
                patches: [{
                  op: "replace",
                  path: "/cfc",
                  value: {
                    version: 1,
                    schemaHash: missingHash,
                    labelMap: { version: 1, entries: [] },
                  },
                }],
              } as never,
            ],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // A ROOT-level replace smuggles the same landing inside a whole
    // document value.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(6, {
            operations: [
              {
                op: "patch",
                id: "of:envelope-carrier",
                patches: [{
                  op: "replace",
                  path: "",
                  value: {
                    value: { field: "v" },
                    cfc: {
                      version: 1,
                      schemaHash: missingHash,
                      labelMap: { version: 1, entries: [] },
                    },
                  },
                }],
              } as never,
            ],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // A MOVE converts plain document data into a metadata reference: the
    // installed value exists only post-patch, so only the post-patch scan
    // sees it.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(7, {
        operations: [{
          op: "set",
          id: "of:move-carrier",
          value: { value: { hoard: missingHash } },
        } as never],
      }),
    });
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(8, {
            operations: [
              {
                op: "patch",
                id: "of:move-carrier",
                patches: [{
                  op: "add",
                  path: "/cfc",
                  value: { version: 1, labelMap: { version: 1, entries: [] } },
                }, {
                  op: "move",
                  from: "/value/hoard",
                  path: "/cfc/schemaHash",
                }],
              } as never,
            ],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // The same move with the document backing it lands.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(9, {
        operations: [
          setOp(`cid:${missingHash}`, missingSchema),
          {
            op: "patch",
            id: "of:move-carrier",
            patches: [{
              op: "add",
              path: "/cfc",
              value: { version: 1, labelMap: { version: 1, entries: [] } },
            }, {
              op: "move",
              from: "/value/hoard",
              path: "/cfc/schemaHash",
            }],
          } as never,
        ],
      }),
    });

    // A cfc-touching sequence that cannot APPLY is not the validator's to
    // judge: the closure scan skips it, and the commit's own application
    // refuses it on its own terms.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(10, {
            operations: [
              {
                op: "patch",
                id: "of:move-carrier",
                patches: [{ op: "replace", path: "", value: 42 }],
              } as never,
            ],
          }),
        }),
      Error,
      "entity document",
    );

    // A SCOPED patch replays over the document at its OWN scope — the
    // space-scoped instance (absent here) is not the document a
    // user-scoped patch lands on, and validating against it would let a
    // scoped envelope be re-pointed at an unbacked hash.
    applyCommit(engine, {
      sessionId: "s:a",
      principal: "did:key:scoped-author",
      commit: commit(11, {
        operations: [{
          op: "set",
          id: "of:scoped-envelope-carrier",
          scope: "user",
          value: {
            value: { field: "v" },
            cfc: {
              version: 1,
              schemaHash: envelopeHash,
              labelMap: { version: 1, entries: [] },
            },
          },
        } as never],
      }),
    });
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          principal: "did:key:scoped-author",
          commit: commit(12, {
            operations: [{
              op: "patch",
              id: "of:scoped-envelope-carrier",
              scope: "user",
              patches: [{
                op: "replace",
                path: "/cfc/schemaHash",
                value: "fid1:scoped-unbacked-hash",
              }],
            } as never],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // A delete between them clears the staged base: the patch that
    // follows replays over an absent document, and the envelope it adds
    // there is validated like any other landing.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(14, {
            operations: [{
              op: "set",
              id: "of:delete-then-patch-carrier",
              value: { value: { field: "v" } },
            } as never, {
              op: "delete",
              id: "of:delete-then-patch-carrier",
            } as never, {
              op: "patch",
              id: "of:delete-then-patch-carrier",
              patches: [{
                op: "add",
                path: "/cfc",
                value: {
                  version: 1,
                  schemaHash: "fid1:post-delete-unbacked",
                  labelMap: { version: 1, entries: [] },
                },
              }],
            } as never],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    // Operations in ONE commit compose: a set stages the base a later
    // patch rewrites, so the patch validates against what THIS commit
    // leaves, never against durable pre-commit state alone.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(13, {
            operations: [{
              op: "set",
              id: "of:intra-commit-carrier",
              value: {
                value: { field: "v" },
                cfc: {
                  version: 1,
                  schemaHash: "",
                  labelMap: { version: 1, entries: [] },
                },
              },
            } as never, {
              op: "patch",
              id: "of:intra-commit-carrier",
              patches: [{
                op: "replace",
                path: "/cfc/schemaHash",
                value: "fid1:intra-commit-unbacked",
              }],
            } as never],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );
  });
});

Deno.test("validates the label documents a version-2 CFC envelope references", async () => {
  await withEngine((engine) => {
    const envelopeSchema = {
      type: "object",
      properties: { field: { type: "string" } },
    } as const;
    const envelopeHash = internSchemaAsTaggedHashString(envelopeSchema);
    const label = { confidentiality: ["secret", "vaulted"] };
    const labelHash = taggedHashStringOf(label);
    const docWithLabel = (ref: string) =>
      ({
        op: "set",
        id: "of:label-carrier",
        value: {
          value: { field: "v" },
          cfc: {
            version: 2,
            schemaHash: envelopeHash,
            labelMap: {
              version: 1,
              entries: [{ path: ["field"], label: { $ref: ref } }],
            },
          },
        },
      }) as never;

    // A label reference nothing backs is the same broken closure a
    // dangling schema reference is, and is refused the same way.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(1, {
            operations: [
              docWithLabel(`cid:${labelHash}`),
              setOp(`cid:${envelopeHash}`, envelopeSchema),
            ],
          }),
        }),
      ProtocolError,
      "references CFC label document",
    );

    // A reference outside the `cid:` namespace can never be backed.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(2, {
            operations: [
              docWithLabel("of:not-content-addressed"),
              setOp(`cid:${envelopeHash}`, envelopeSchema),
            ],
          }),
        }),
      ProtocolError,
      "outside the cid: namespace",
    );

    // The label document included in the SAME commit backs the reference,
    // its content already verified against its id by the `cid:` rule...
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(3, {
        operations: [
          docWithLabel(`cid:${labelHash}`),
          setOp(`cid:${envelopeHash}`, envelopeSchema),
          setOp(`cid:${labelHash}`, label),
        ],
      }),
    });

    // ...and once stored, it backs later envelopes by itself.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(4, {
        operations: [docWithLabel(`cid:${labelHash}`)],
      }),
    });

    // Entries that hold no reference — inline labels, a malformed label,
    // an envelope with no entries array — name no document and pass the
    // scan; the boundary polices backing, not the map's shape.
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(40, {
        operations: [{
          op: "set",
          id: "of:inline-carrier",
          value: {
            value: { field: "v" },
            cfc: {
              version: 2,
              schemaHash: envelopeHash,
              labelMap: {
                version: 1,
                entries: [
                  { path: ["field"], label: { confidentiality: ["secret"] } },
                  { path: ["field"], label: "malformed" },
                ],
              },
            },
          },
        } as never, {
          op: "set",
          id: "of:entryless-carrier",
          value: {
            value: { field: "v" },
            cfc: { version: 2, schemaHash: envelopeHash, labelMap: {} },
          },
        } as never],
      }),
    });

    // A document that verifies against its id but is not label-shaped is
    // refused as well: the hash cannot tell a label from any other record,
    // and a reader resolving it would fail closed on every read.
    const malformed = { confidentiality: "secret" };
    const malformedHash = taggedHashStringOf(malformed);
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(5, {
            operations: [
              docWithLabel(`cid:${malformedHash}`),
              setOp(`cid:${malformedHash}`, malformed),
            ],
          }),
        }),
      ProtocolError,
      "does not hold a label",
    );

    // A stored label document whose bytes were changed out of band no
    // longer hashes to its id, and a later envelope naming it is refused:
    // the commit API rejects every `cid:` mutation, so direct database
    // manipulation is the only door left, and this models genuine
    // corruption.
    engine.database.prepare(
      `UPDATE revision SET data = :data, seq = seq + 1 WHERE id = :id`,
    ).run({
      data: encodeMemoryBoundary({ value: { confidentiality: ["forged"] } }),
      id: `cid:${labelHash}`,
    });
    engine.database.prepare(`UPDATE head SET seq = seq + 1 WHERE id = :id`)
      .run({ id: `cid:${labelHash}` });
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(41, {
            operations: [{
              op: "set",
              id: "of:tampered-carrier",
              value: {
                value: { field: "v" },
                cfc: {
                  version: 2,
                  schemaHash: envelopeHash,
                  labelMap: {
                    version: 1,
                    entries: [{
                      path: ["field"],
                      label: { $ref: `cid:${labelHash}` },
                    }],
                  },
                },
              },
            } as never],
          }),
        }),
      ProtocolError,
      "whose stored content does not verify",
    );

    // A patch that lands a reference at the reserved member is collected
    // from the post-patch document like the schema reference is.
    const otherHash = taggedHashStringOf({ confidentiality: ["other"] });
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(6, {
            operations: [
              {
                op: "patch",
                id: "of:label-carrier",
                patches: [{
                  op: "replace",
                  path: "/cfc/labelMap/entries/0/label",
                  value: { $ref: `cid:${otherHash}` },
                }],
              } as never,
            ],
          }),
        }),
      ProtocolError,
      "references CFC label document",
    );
  });
});

Deno.test("walks a CFC envelope's schema-document closure transitively", async () => {
  await withEngine((engine) => {
    // A decomposed envelope root references its definitions as
    // `$ref: cid:` members. The closure walk must follow those
    // references — a root without its definition is the same broken
    // closure as missing the root itself.
    const childSchema = {
      type: "string",
      ifc: { confidentiality: ["decomposed"] },
    } as const;
    const childHash = internSchemaAsTaggedHashString(childSchema);
    const rootSchema = {
      type: "object",
      properties: { secret: { $ref: `cid:${childHash}` } },
    } as never;
    const rootHash = internSchemaAsTaggedHashString(rootSchema);
    const carrier = {
      op: "set",
      id: "of:decomposed-envelope-carrier",
      value: {
        value: { secret: "v" },
        cfc: {
          version: 1,
          schemaHash: rootHash,
          labelMap: { version: 1, entries: [] },
        },
      },
    } as never;

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(30, {
            operations: [carrier, setOp(`cid:${rootHash}`, rootSchema)],
          }),
        }),
      ProtocolError,
      "neither included in the commit nor stored in the space",
    );

    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(31, {
        operations: [
          carrier,
          setOp(`cid:${rootHash}`, rootSchema),
          setOp(`cid:${childHash}`, childSchema),
        ],
      }),
    });
  });
});
