/**
 * What crosses to a host beside a read, decided under the display ceiling by
 * the same gate as a read: label views on labels, refs and links, metadata,
 * reads through a cell the gate cannot measure, and the diagnostic channels.
 * The documents a visitor may not see carry a key and a value that appear
 * nowhere else, so a search of what crossed for either is a search for the
 * document having escaped.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type CfcAtom, cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { rootRenderPolicyFor } from "@commonfabric/html/worker";
import { createSession, Identity } from "@commonfabric/identity";
import { SERVER_EXECUTION_EFFECTS_DOC_ID } from "@commonfabric/memory/v2";
import { PiecesController } from "@commonfabric/piece/ops";
import { defaultRenderConfidentialityCeiling } from "@commonfabric/lib-shell/runtime";
import {
  type Cell,
  entityIdFrom,
  hostValueOf,
  makeAddressKey,
  readProjected,
  Runtime,
  RuntimeTelemetryEvent,
  type RuntimeTelemetryMarkerResult,
  slugIdForSpace,
} from "@commonfabric/runner";
import { stringSchema } from "@commonfabric/runner/schemas";
import {
  EmulatedStorageManager,
  newLoopbackServer,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../../runner/test/cfc-seed-envelope.ts";
import {
  type DocumentAt,
  HostReadGate,
  NavigationWithheldError,
} from "@/backends/host-read-gate.ts";
import {
  renderConfidentialityResolverFor,
  renderMembershipProviderFor,
  renderModulePolicySourceFor,
  toConsoleDebugValue,
} from "@/backends/runtime-processor.ts";
import { runtimeErrorReport } from "@/backends/runtime-error.ts";
import { createCellRef } from "@/backends/utils.ts";
import { NotificationType, RequestType } from "@/protocol/mod.ts";
import { buildProcessor } from "./build-processor.ts";

const owner = await Identity.fromPassphrase("host read channels owner");
const visitor = await Identity.fromPassphrase("host read channels visitor");
const space = owner.did();
const ownerOnly = cfcAtom.user(owner.did());

/** A key of a document only its owner may see: a field name is content. */
const SECRET_KEY = "alice-secret-key@example.invalid";
const SECRET_VALUE = "value-behind-the-seal";
const PLACEHOLDER = "Content hidden by policy";

type Labels = readonly [path: string[], confidentiality: readonly CfcAtom[]][];

/** The documents every case reads, and the runtime holding them. */
async function shelf() {
  const storageManager = StorageManager.emulate({ as: owner });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });
  const write = async (
    id: string,
    value: unknown,
    labels: Labels = [],
    meta: Record<string, unknown> = {},
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, id, undefined, tx);
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, {
      space,
      id: cell.getAsNormalizedFullLink().id!,
      type: "application/json",
      path: [],
    }, {
      value,
      ...meta,
      ...(labels.length === 0 ? {} : {
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: labels.map(([path, confidentiality]) => ({
              path,
              label: { confidentiality },
            })),
          },
        },
      }),
    } as FabricValue);
    expect((await tx.commit()).ok).toBeDefined();
    return runtime.getCell(space, id);
  };

  // A document only its owner may see, down to the name of its field.
  const contacts = await write(
    "contacts",
    { [SECRET_KEY]: SECRET_VALUE },
    [[[], [ownerOnly]], [[SECRET_KEY], [ownerOnly]]],
    { slug: "contacts-slug" },
  );
  // A value carrying a caveat of the prompt-influence family, for its owner.
  const caveated = await write("caveated", { text: "fetched page" }, [[
    [],
    [ownerOnly, cfcAtom.caveat("prompt-influence", cfcAtom.user(owner.did()))],
  ]]);
  await runtime.idle();

  const contactsId = contacts.getAsNormalizedFullLink().id;

  return {
    runtime,
    write,
    contacts,
    contactsId,
    caveated,
    documentAt: documentAtIn(runtime),
    async [Symbol.asyncDispose]() {
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

/** The document a diagnostic names, at its root, as the worker finds it. */
function documentAtIn(runtime: Runtime): DocumentAt {
  return (documentSpace, id, scope) =>
    runtime.getCellFromLink({
      space: documentSpace as typeof space,
      id: id as `${string}:${string}`,
      path: [],
      ...(scope === undefined ? {} : { scope }),
    });
}

/** Binds `slug` to `target`, as `set-slug` does. */
async function pointSlug(
  runtime: Runtime,
  slug: string,
  target: Cell<unknown>,
): Promise<void> {
  const slugCell = runtime.getCellFromEntityId(
    space,
    entityIdFrom(slugIdForSpace(space, slug)),
  );
  await runtime.editWithRetry((tx) => {
    const slugWithTx = slugCell.withTx(tx);
    slugWithTx.setRawUntyped(
      target.withTx(tx).getAsWriteRedirectLink({ base: slugWithTx }),
    );
  });
}

/** A worker for `viewer` that serves slugs of the shelf's space. */
function slugProcessorFor(runtime: Runtime, viewer: Identity) {
  return buildProcessor({
    runtime,
    cc: { getSpace: () => space },
    identity: viewer,
    space,
    renderConfidentialityCeiling: defaultRenderConfidentialityCeiling(
      viewer.did(),
    ),
  });
}

/** The gate a worker builds for `viewer`, under the shell's default ceiling. */
function gateFor(runtime: Runtime, viewer: Identity): HostReadGate {
  const ceiling = defaultRenderConfidentialityCeiling(viewer.did());
  const membership = renderMembershipProviderFor(runtime, viewer, ceiling);
  const modulePolicies = renderModulePolicySourceFor(runtime, ceiling);
  return new HostReadGate(rootRenderPolicyFor(ceiling), {
    resolveConfidentiality: renderConfidentialityResolverFor(
      runtime,
      viewer,
      ceiling,
      viewer.did(),
      membership,
      modulePolicies,
    ),
    membership,
    modulePolicies,
  });
}

/** Whether `text` appears anywhere in `answer`. */
function holds(answer: unknown, text: string): boolean {
  return JSON.stringify(answer ?? null).includes(text);
}

describe("HostReadGate, for what crosses beside a value", () => {
  describe("scoped instances reached through a link", () => {
    const SCOPED_SECRET = "scoped-secret-value";

    /**
     * A document whose space instance only its owner may see, and whose user
     * instance holds a value and stores no label of its own, which a reader
     * of it answers to its space instance's confidentiality for. Returns a
     * link to the user instance.
     */
    async function scopedBehindSealedSpace(
      docs: Awaited<ReturnType<typeof shelf>>,
      name: string,
    ) {
      const tx = docs.runtime.edit();
      const id = docs.runtime.getCell(space, name, undefined, tx)
        .getAsNormalizedFullLink().id;
      writeSeedEnvelopeDoc(tx, space);
      seedStoredEnvelope(tx, {
        space,
        id,
        type: "application/json",
        path: [],
      }, {
        value: { note: "the space instance" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: { confidentiality: [ownerOnly] } }],
          },
        },
      } as FabricValue);
      seedStoredEnvelope(tx, {
        space,
        id,
        scope: "user",
        type: "application/json",
        path: [],
      }, { value: { note: SCOPED_SECRET } } as FabricValue);
      expect((await tx.commit()).ok).toBeDefined();
      return { "/": { "link@1": { id, path: [], scope: "user" } } };
    }

    it("refuses a visitor a record whose link reaches a scoped instance it is refused", async () => {
      await using docs = await shelf();
      const link = await scopedBehindSealedSpace(docs, "scoped-target");
      const outer = await docs.write("scoped-outer", { f: link });

      const toVisitor = gateFor(docs.runtime, visitor);
      expect(toVisitor.read(outer.key("f"))).toEqual({
        refused: { refusedBy: "display-ceiling" },
      });
      const whole = toVisitor.read(outer);
      expect(holds(whole, SCOPED_SECRET)).toBe(false);
      expect(whole).toEqual({ refused: { refusedBy: "display-ceiling" } });
      expect(holds(gateFor(docs.runtime, owner).read(outer), SCOPED_SECRET))
        .toBe(true);
    });

    it("withholds what an action logged of a scoped instance it read through a link", async () => {
      const storageManager = StorageManager.emulate({ as: owner });
      const shown: unknown[] = [];
      let gates: HostReadGate[] = [];
      let heard: () => void = () => {};
      const logged = new Promise<void>((resolve) => (heard = resolve));
      const runtime = new Runtime({
        apiUrl: new URL("http://localhost"),
        storageManager,
        consoleHandler: ({ method, args, consumed }) => {
          if (gates.length === 0) return args;
          for (const gate of gates) {
            shown.push(
              gate.console(
                { method },
                args.map((arg) => toConsoleDebugValue(arg)),
                consumed,
              ).args,
            );
          }
          heard();
          return [];
        },
      });
      try {
        const docs = {
          runtime,
          write: async (id: string, value: unknown) => {
            const tx = runtime.edit();
            runtime.getCell(space, id, undefined, tx).set(value);
            expect((await tx.commit()).ok).toBeDefined();
          },
        };
        const tx = runtime.edit();
        const id = runtime.getCell(space, "logged-scoped", undefined, tx)
          .getAsNormalizedFullLink().id;
        writeSeedEnvelopeDoc(tx, space);
        seedStoredEnvelope(tx, {
          space,
          id,
          type: "application/json",
          path: [],
        }, {
          value: { note: "the space instance" },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{ path: [], label: { confidentiality: [ownerOnly] } }],
            },
          },
        } as FabricValue);
        seedStoredEnvelope(tx, {
          space,
          id,
          scope: "user",
          type: "application/json",
          path: [],
        }, { value: { note: SCOPED_SECRET } } as FabricValue);
        expect((await tx.commit()).ok).toBeDefined();
        await docs.write("logged-scoped-input", {
          n: { "/": { "link@1": { id, path: ["note"], scope: "user" } } },
        });
        gates = [gateFor(runtime, visitor), gateFor(runtime, owner)];
        const compiled = await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: [
              "import { computed, pattern } from 'commonfabric';",
              "export default pattern<{ n: string }, { out: string }>(",
              "  ({ n }) => {",
              "    const out = computed(() => {",
              "      console.log('read', n);",
              "      return 'x';",
              "    });",
              "    return { out };",
              "  },",
              ");",
            ].join("\n"),
          }],
        }, { space });
        const result = runtime.getCell(
          space,
          "logged-scoped-result",
          compiled.resultSchema,
        );
        const run = runtime.edit();
        runtime.run(
          run,
          compiled,
          runtime.getCell(space, "logged-scoped-input"),
          result,
        );
        await run.commit();
        const cancel = result.sink(() => {});
        await logged;
        cancel();

        // The visitor is shown the placeholder; the owner, what was logged.
        expect(shown[0]).toEqual([PLACEHOLDER]);
        expect(holds(shown[1], SCOPED_SECRET)).toBe(true);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });

  describe("label views", () => {
    it("joins a refused document's label at its root for a label read, and keeps the owner's whole", async () => {
      await using docs = await shelf();

      const toVisitor = gateFor(docs.runtime, visitor).label(docs.contacts);
      const toOwner = gateFor(docs.runtime, owner).label(docs.contacts);

      expect(holds(toVisitor, SECRET_KEY)).toBe(false);
      expect(toVisitor.cfcLabel?.entries.map((entry) => entry.path)).toEqual([
        [],
      ]);
      expect(holds(toOwner, SECRET_KEY)).toBe(true);
    });

    it("joins the view a ref to a refused document carries", async () => {
      await using docs = await shelf();

      expect(
        holds(gateFor(docs.runtime, visitor).ref(docs.contacts), SECRET_KEY),
      ).toBe(false);
      expect(
        holds(gateFor(docs.runtime, owner).ref(docs.contacts), SECRET_KEY),
      ).toBe(true);
    });
  });

  describe("metadata and reads it cannot measure", () => {
    it("refuses a visitor a refused document's slug, and returns its owner the slug", async () => {
      await using docs = await shelf();

      expect(gateFor(docs.runtime, visitor).slug(docs.contacts)).toEqual({
        refused: { refusedBy: "display-ceiling" },
      });
      expect(gateFor(docs.runtime, owner).slug(docs.contacts)).toEqual({
        slug: "contacts-slug",
      });
    });

    it("does not tell a visitor which piece a slug it is refused stands for", async () => {
      await using docs = await shelf();
      // A piece only its owner may see, and a slug a visitor could guess.
      const piece = await docs.write(
        "credential-piece",
        { [SECRET_KEY]: SECRET_VALUE },
        [[[], [ownerOnly]]],
        {
          slug: "credential",
          patternIdentity: { identity: "pattern-credential", symbol: "main" },
        },
      );
      await pointSlug(docs.runtime, "credential", piece);
      const pieceId = piece.getAsNormalizedFullLink().id;
      const toVisitor = slugProcessorFor(docs.runtime, visitor);
      const toOwner = slugProcessorFor(docs.runtime, owner);
      try {
        const resolve = {
          type: RequestType.SlugResolve,
          space,
          slug: "credential",
        } as const;
        const getSlug = {
          type: RequestType.PieceGetSlug,
          space,
          pieceId: pieceId.replace(/^of:/, ""),
        } as const;

        const resolved = await toVisitor.handleSlugResolve(resolve);
        expect(JSON.stringify(resolved)).not.toContain(pieceId);
        expect(resolved).toEqual({
          refusal: expect.objectContaining({ code: "display-ceiling" }),
        });
        // As the visitor is refused the slug of that piece.
        expect(await toVisitor.handlePieceGetSlug(getSlug)).toEqual({
          refused: { refusedBy: "display-ceiling" },
        });
        expect(await toOwner.handleSlugResolve(resolve)).toEqual({
          piece: { cell: expect.objectContaining({ id: pieceId, path: [] }) },
          pathAfter: [],
        });
        expect(await toOwner.handlePieceGetSlug(getSlug)).toEqual({
          slug: "credential",
        });
      } finally {
        await toVisitor.dispose();
        await toOwner.dispose();
      }
    });

    it("decides a slug reference to a member on each document the walk read", async () => {
      await using docs = await shelf();
      const pieceMeta = (name: string) => ({
        patternIdentity: { identity: `pattern-${name}`, symbol: "main" },
      });
      const piece = await docs.write(
        "sealed-member",
        { [SECRET_KEY]: SECRET_VALUE },
        [[[], [ownerOnly]]],
        pieceMeta("sealed-member"),
      );
      // A collection anyone may see, holding a piece only its owner may.
      const board = await docs.write(
        "open-board",
        { names: { "1": piece.getAsLink() } },
        [],
        pieceMeta("open-board"),
      );
      // A collection only its owner may see, down to its members' names.
      const sealedBoard = await docs.write(
        "sealed-board",
        { names: { [SECRET_KEY]: piece.getAsLink() } },
        [[[], [ownerOnly]]],
        pieceMeta("sealed-board"),
      );
      await pointSlug(docs.runtime, "open-top", board.key("names"));
      await pointSlug(docs.runtime, "sealed-top", sealedBoard.key("names"));
      const pieceId = piece.getAsNormalizedFullLink().id;
      const toVisitor = slugProcessorFor(docs.runtime, visitor);
      const toOwner = slugProcessorFor(docs.runtime, owner);
      const resolve = (slug: string, member: string) => ({
        type: RequestType.SlugResolve,
        space,
        slug,
        member,
      } as const);
      try {
        const refused = {
          refusal: expect.objectContaining({ code: "display-ceiling" }),
        };
        const member = await toVisitor.handleSlugResolve(
          resolve("open-top", "1"),
        );
        expect(JSON.stringify(member)).not.toContain(pieceId);
        expect(member).toEqual(refused);
        // A member the collection does not hold is its content as well.
        expect(await toVisitor.handleSlugResolve(resolve("sealed-top", "2")))
          .toEqual(refused);

        expect(await toOwner.handleSlugResolve(resolve("open-top", "1")))
          .toEqual({
            piece: { cell: expect.objectContaining({ id: pieceId }) },
            pathAfter: [],
          });
        expect(await toOwner.handleSlugResolve(resolve("sealed-top", "2")))
          .toEqual({
            refusal: expect.objectContaining({ code: "missing-member" }),
          });
      } finally {
        await toVisitor.dispose();
        await toOwner.dispose();
      }
    });

    for (const via of ["fromMetadata", "fromCell"] as const) {
      it(`builds nothing for a visitor ${via}() refuses, and builds the owner's answer`, async () => {
        await using docs = await shelf();
        const built: string[] = [];
        const build = (who: string) => () => {
          built.push(who);
          return Promise.resolve({ rows: [SECRET_VALUE] });
        };

        const toVisitor = await gateFor(docs.runtime, visitor)[via](
          docs.contacts,
          build("visitor"),
        );
        const toOwner = await gateFor(docs.runtime, owner)[via](
          docs.contacts,
          build("owner"),
        );

        expect(toVisitor).toEqual({
          refused: { refusedBy: "display-ceiling" },
        });
        expect(toOwner).toEqual({ rows: [SECRET_VALUE] });
        expect(built).toEqual(["owner"]);
      });
    }

    it("decides a document this worker has not loaded on what it holds, not on finding no label", async () => {
      // The owner's runtime writes a document only its owner may see; the
      // visitor's, on the same store, has not loaded it.
      const server = newLoopbackServer();
      const connect = () =>
        new Runtime({
          apiUrl: new URL("http://localhost"),
          storageManager: EmulatedStorageManager.connectTo(server, {
            as: owner,
          }),
        });
      const writer = connect();
      const reader = connect();
      try {
        const tx = writer.edit();
        writeSeedEnvelopeDoc(tx, space);
        for (const id of ["unloaded", "unloaded-for-owner"]) {
          const written = writer.getCell(space, id, undefined, tx);
          seedStoredEnvelope(tx, {
            space,
            id: written.getAsNormalizedFullLink().id!,
            type: "application/json",
            path: [],
          }, {
            value: { [SECRET_KEY]: SECRET_VALUE },
            slug: "unloaded-slug",
            cfc: {
              version: 1,
              schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
              labelMap: {
                version: 1,
                entries: [{
                  path: [],
                  label: { confidentiality: [ownerOnly] },
                }],
              },
            },
          } as FabricValue);
        }
        expect((await tx.commit()).ok).toBeDefined();
        await writer.storageManager.synced();
        const gate = gateFor(reader, visitor);
        const built: string[] = [];
        const build = () => {
          built.push("built");
          return Promise.resolve({ rows: [SECRET_VALUE] });
        };
        const unloaded = () => reader.getCell(space, "unloaded");

        const slug = gate.slug(unloaded());
        const metadata = gate.metadataRefusal(unloaded());
        const fromCell = await gate.fromCell(unloaded(), build);
        const fromMetadata = await gate.fromMetadata(unloaded(), build);

        expect(built).toEqual([]);
        expect(fromCell).toEqual({ refused: { refusedBy: "display-ceiling" } });
        expect(fromMetadata).toEqual({
          refused: { refusedBy: "display-ceiling" },
        });
        expect(slug).toEqual({ refused: { refusedBy: "display-ceiling" } });
        expect(metadata).toEqual({ refused: { refusedBy: "display-ceiling" } });
        // The owner's answer waits for the document, and is built.
        expect(
          await gateFor(reader, owner).fromCell(
            reader.getCell(space, "unloaded-for-owner"),
            build,
          ),
        ).toEqual({ rows: [SECRET_VALUE] });
      } finally {
        await reader.dispose();
        await writer.dispose();
        await server.close();
      }
    });

    it("does not tell a visitor where a link in a document only its owner may see leads", async () => {
      await using docs = await shelf();
      const target = await docs.write("link-target", { x: 1 });
      const holder = await docs.write(
        "link-holder",
        { link: target.getAsLink() },
        [[[], [ownerOnly]]],
      );
      // A visitor's worker, with the shell's default ceiling.
      const processor = buildProcessor({
        runtime: docs.runtime,
        identity: visitor,
        space: visitor.did(),
        renderConfidentialityCeiling: defaultRenderConfidentialityCeiling(
          visitor.did(),
        ),
      });
      const targetId = target.getAsNormalizedFullLink().id;
      try {
        const answer = processor.handleCellResolveAsCell({
          type: RequestType.CellResolveAsCell,
          cell: createCellRef(holder.key("link")),
        });
        expect(answer).toEqual({ refused: { refusedBy: "display-ceiling" } });
        expect(JSON.stringify(answer)).not.toContain(targetId);
        // A cell whose path follows no link resolves to the address named.
        expect(
          processor.handleCellResolveAsCell({
            type: RequestType.CellResolveAsCell,
            cell: createCellRef(target),
          }),
        ).toEqual({ cell: expect.objectContaining({ id: targetId }) });

        // A redirect the visitor may not see is not followed for them.
        const tx = docs.runtime.edit();
        const redirect = docs.runtime.getCell(space, "redirect", undefined, tx);
        const redirectId = redirect.getAsNormalizedFullLink().id;
        writeSeedEnvelopeDoc(tx, space);
        seedStoredEnvelope(tx, {
          space,
          id: redirectId,
          type: "application/json",
          path: [],
        }, {
          value: {
            "/": {
              "link@1": { id: targetId, path: [], overwrite: "redirect" },
            },
          },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{ path: [], label: { confidentiality: [ownerOnly] } }],
            },
          },
        } as FabricValue);
        expect((await tx.commit()).ok).toBeDefined();
        const pieces = buildProcessor({
          runtime: docs.runtime,
          cc: new PiecesController(
            createSession({ identity: visitor, spaceDid: space }),
            docs.runtime,
          ),
          identity: visitor,
          space,
          renderConfidentialityCeiling: defaultRenderConfidentialityCeiling(
            visitor.did(),
          ),
        });
        try {
          await expect(pieces.handlePieceGet({
            type: RequestType.PieceGet,
            pieceId: redirectId.replace(/^of:/, ""),
            space,
            runIt: false,
          })).rejects.toThrow("refused to name where this redirect leads");
        } finally {
          await pieces.dispose();
        }
      } finally {
        await processor.dispose();
      }
    });

    it("decides a member's one-shot read again once the access list it consulted loads", async () => {
      // The owner's space grants the visitor READ. The visitor's worker has
      // loaded a document labeled with that space, but not its access list.
      const server = newLoopbackServer();
      const writer = new Runtime({
        apiUrl: new URL("http://localhost"),
        storageManager: EmulatedStorageManager.connectTo(server, { as: owner }),
      });
      const reader = new Runtime({
        apiUrl: new URL("http://localhost"),
        storageManager: EmulatedStorageManager.connectTo(server, {
          as: visitor,
        }),
      });
      try {
        const tx = writer.edit();
        tx.writeOrThrow({
          space,
          id: `of:${space}` as `${string}:${string}`,
          type: "application/json",
          path: [],
        }, { value: { [space]: "OWNER", [visitor.did()]: "READ" } });
        const labeled = writer.getCell(space, "for-members", undefined, tx);
        writeSeedEnvelopeDoc(tx, space);
        seedStoredEnvelope(tx, {
          space,
          id: labeled.getAsNormalizedFullLink().id!,
          type: "application/json",
          path: [],
        }, {
          value: { note: "for members of the space" },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{
                path: [],
                label: { confidentiality: [cfcAtom.space(space)] },
              }],
            },
          },
        } as FabricValue);
        expect((await tx.commit()).ok).toBeDefined();
        await writer.storageManager.synced();
        const cell = reader.getCell(space, "for-members");
        await cell.sync();
        // The visitor's worker works in a space of its own, so membership of
        // the owner's space comes from that space's access list alone.
        const processor = buildProcessor({
          runtime: reader,
          identity: visitor,
          space: visitor.did(),
          renderConfidentialityCeiling: defaultRenderConfidentialityCeiling(
            visitor.did(),
          ),
        });
        try {
          const answer = await processor.handleRequest({
            type: RequestType.CellGet,
            cell: createCellRef(cell),
          });

          expect(answer).toEqual({
            value: { note: "for members of the space" },
          });
        } finally {
          await processor.dispose();
        }
      } finally {
        await reader.dispose();
        await writer.dispose();
        await server.close();
      }
    });

    it("decides a collaborative session on the field it holds, not on where the cell it named now leads", async () => {
      await using docs = await shelf();
      const sealed = await docs.write(
        "sealed-field",
        { content: SECRET_VALUE },
        [[[], [ownerOnly]]],
      );
      const open = await docs.write("open-field", { content: "anyone" });
      const holder = await docs.write("field-holder", {
        link: sealed.key("content").getAsLink(),
      });
      const named = createCellRef(holder.key("link"));
      const processorFor = (viewer: Identity) =>
        buildProcessor({
          runtime: docs.runtime,
          identity: viewer,
          space,
          renderConfidentialityCeiling: defaultRenderConfidentialityCeiling(
            viewer.did(),
          ),
        });
      const processor = processorFor(visitor);
      const ownersProcessor = processorFor(owner);
      try {
        // Each session begins on the sealed field the link leads to.
        for (const each of [processor, ownersProcessor]) {
          await each.handleOperationCapabilities({
            type: RequestType.OperationCapabilities,
            cell: named,
            operationSessionId: "session:moved",
          });
        }
        // The link moves to a field anyone may see.
        await docs.runtime.editWithRetry((tx) => {
          holder.withTx(tx).key("link").setRawUntyped(
            open.key("content").getAsLink(),
          );
        });

        const queried = await processor.handleOperationQuery({
          type: RequestType.OperationQuery,
          cell: named,
          operationSessionId: "session:moved",
        });

        expect(holds(queried, SECRET_VALUE)).toBe(false);
        expect(queried).toEqual({ refused: { refusedBy: "display-ceiling" } });
        // Its owner's session goes on with the field it began on.
        expect(
          holds(
            await ownersProcessor.handleOperationQuery({
              type: RequestType.OperationQuery,
              cell: named,
              operationSessionId: "session:moved",
            }),
            SECRET_VALUE,
          ),
        ).toBe(true);
      } finally {
        await processor.dispose();
        await ownersProcessor.dispose();
      }
    });

    it("refuses each update of a refused collaborative field", async () => {
      await using docs = await shelf();
      const field = { materialized: SECRET_VALUE } as never;

      const toVisitor = gateFor(docs.runtime, visitor).operationUpdate(
        docs.contacts,
        "subscription:1",
        field,
      );
      const toOwner = gateFor(docs.runtime, owner).operationUpdate(
        docs.contacts,
        "subscription:1",
        field,
      );

      expect(toVisitor).toEqual({
        type: NotificationType.OperationUpdate,
        subscriptionId: "subscription:1",
        refused: { refusedBy: "display-ceiling" },
      });
      expect(holds(toOwner, SECRET_VALUE)).toBe(true);
    });
  });

  describe("diagnostics", () => {
    it("names a refused document alone in a cell update's telemetry marker", async () => {
      await using docs = await shelf();
      const marker = {
        type: "cell.update",
        space,
        change: {
          address: { id: docs.contactsId, path: [SECRET_KEY] },
          before: "before the seal",
          after: SECRET_VALUE,
        },
        timeStamp: 1,
      } as RuntimeTelemetryMarkerResult;

      const toVisitor = gateFor(docs.runtime, visitor).telemetry(
        marker,
        docs.documentAt,
      );
      const toOwner = gateFor(docs.runtime, owner).telemetry(
        marker,
        docs.documentAt,
      );

      expect(holds(toVisitor, SECRET_VALUE)).toBe(false);
      expect(holds(toVisitor, SECRET_KEY)).toBe(false);
      expect(holds(toVisitor, PLACEHOLDER)).toBe(true);
      expect(toOwner.marker).toEqual(marker);
    });

    it("decides the text a telemetry marker carries on what its transaction read", async () => {
      await using docs = await shelf();
      const consumed = () =>
        readProjected(docs.contacts.asSchema(true), hostValueOf).consumed;
      const reason = `schema merge failed on ${SECRET_VALUE}`;
      const rejected: RuntimeTelemetryMarkerResult = {
        type: "cfc.prepare-reject",
        reasons: [reason],
        refusals: [{
          gate: "sink-ceiling",
          sink: "fetchText",
          offendingAtoms: [],
          inputs: [],
          attribution: "none",
          reason,
        }],
        terminal: true,
        timeStamp: 1,
      };
      const committed: RuntimeTelemetryMarkerResult = {
        type: "scheduler.event.commit",
        handlerId: "handler",
        readCount: 1,
        writeCount: 1,
        changedWriteCount: 1,
        writes: [],
        error: `commit refused over ${SECRET_VALUE}`,
        timeStamp: 2,
      };
      const pushed: RuntimeTelemetryMarkerResult = {
        type: "storage.push.error",
        id: "push",
        error: "ConflictError",
        message: `stale read of ${SECRET_VALUE}`,
        reads: [],
        writes: [],
        timeStamp: 3,
      };
      const settled: RuntimeTelemetryMarkerResult = {
        type: "scheduler.settle",
        durationMs: 1,
        iterations: 1,
        settledEarly: false,
        seedCount: 0,
        workSetSize: 0,
        timeStamp: 4,
      };
      const toVisitor = gateFor(docs.runtime, visitor);
      const toOwner = gateFor(docs.runtime, owner);

      expect(
        holds(toVisitor.telemetry(rejected, docs.documentAt, consumed), reason),
      ).toBe(false);
      expect(toOwner.telemetry(rejected, docs.documentAt, consumed).marker)
        .toEqual(rejected);
      // A commit's failure is reported once its transaction has closed, with
      // no labels to decide its text on, so under a policy it is withheld
      // from its owner too, as the error report of the same failure is.
      expect(toOwner.telemetry(committed, docs.documentAt).marker).toEqual({
        ...committed,
        error: PLACEHOLDER,
      });
      expect(toOwner.telemetry(pushed, docs.documentAt).marker).toEqual({
        ...pushed,
        message: PLACEHOLDER,
      });
      expect(toVisitor.telemetry(settled, docs.documentAt).marker).toEqual(
        settled,
      );
      // With no ceiling, nothing is decided.
      expect(
        new HostReadGate(undefined, {}).telemetry(committed, docs.documentAt)
          .marker,
      ).toEqual(committed);
    });

    it("names a refused document alone in the trigger trace", async () => {
      await using docs = await shelf();
      const entry = {
        recordedAt: 1,
        notificationType: "commit",
        changeIndex: 1,
        matchedActionCount: 0,
        mode: "pull" as const,
        space,
        entityId: docs.contactsId,
        path: [SECRET_KEY],
        before: { kind: "string" as const, size: 3, preview: "old" },
        after: { kind: "string" as const, size: 21, preview: SECRET_VALUE },
        triggered: [],
      };

      const toVisitor = gateFor(docs.runtime, visitor).triggerTrace(
        [entry],
        docs.documentAt,
      );
      const toOwner = gateFor(docs.runtime, owner).triggerTrace(
        [entry],
        docs.documentAt,
      );

      expect(toVisitor.trace).toEqual([{
        ...entry,
        path: [],
        before: { kind: "string" },
        after: { kind: "string" },
      }]);
      expect(toOwner.trace).toEqual([entry]);
    });

    it("decides a trace entry and a diagnosis key on the scoped instance of a document they name", async () => {
      // A document whose user-scoped instance only its owner may see, beside
      // a space-scoped instance of the same id anyone may.
      await using docs = await shelf();
      const tx = docs.runtime.edit();
      const id = docs.runtime.getCell(space, "scoped-pair", undefined, tx)
        .getAsNormalizedFullLink().id;
      writeSeedEnvelopeDoc(tx, space);
      seedStoredEnvelope(tx, {
        space,
        id,
        type: "application/json",
        path: [],
      }, { value: { [SECRET_KEY]: "public twin" } } as FabricValue);
      seedStoredEnvelope(tx, {
        space,
        id,
        scope: "user",
        type: "application/json",
        path: [],
      }, {
        value: { [SECRET_KEY]: SECRET_VALUE },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: { confidentiality: [ownerOnly] } }],
          },
        },
      } as FabricValue);
      expect((await tx.commit()).ok).toBeDefined();
      await docs.runtime.idle();
      const entry = {
        recordedAt: 1,
        notificationType: "commit",
        changeIndex: 1,
        matchedActionCount: 0,
        mode: "pull" as const,
        space,
        entityId: id,
        scope: "user" as const,
        path: [SECRET_KEY],
        before: { kind: "string" as const, size: 3, preview: "old" },
        after: { kind: "string" as const, size: 21, preview: SECRET_VALUE },
        triggered: [],
      };
      const key = makeAddressKey({
        space,
        id,
        scope: "user",
        path: [SECRET_KEY],
      });
      const diagnosis = {
        nonIdempotent: [{
          actionId: "action:1",
          runs: [{ timestamp: 1, reads: {}, writes: { [key]: SECRET_VALUE } }],
          differingWriteKeys: [key],
        }],
        cycles: [],
        duration: 1,
        busyTime: 1,
      };

      const visitorGate = gateFor(docs.runtime, visitor);
      const ownerGate = gateFor(docs.runtime, owner);

      expect(
        holds(visitorGate.triggerTrace([entry], docs.documentAt), SECRET_VALUE),
      )
        .toBe(false);
      expect(ownerGate.triggerTrace([entry], docs.documentAt).trace).toEqual([
        entry,
      ]);
      expect(
        holds(visitorGate.diagnosis(diagnosis, docs.documentAt), SECRET_VALUE),
      )
        .toBe(false);
      expect(ownerGate.diagnosis(diagnosis, docs.documentAt).result).toEqual(
        diagnosis,
      );
    });

    it("names a refused document alone in a diagnosis", async () => {
      await using docs = await shelf();
      const key = `${space}/${docs.contactsId}/${SECRET_KEY}`;
      const result = {
        nonIdempotent: [{
          actionId: "action:1",
          runs: [
            { timestamp: 1, reads: { [key]: "one" }, writes: { [key]: "x" } },
            {
              timestamp: 2,
              reads: { [key]: SECRET_VALUE },
              writes: { [key]: "y" },
            },
          ],
          differingWriteKeys: [key],
        }],
        cycles: [],
        duration: 1,
        busyTime: 1,
      };

      const toVisitor = gateFor(docs.runtime, visitor).diagnosis(
        result,
        docs.documentAt,
      );
      const toOwner = gateFor(docs.runtime, owner).diagnosis(
        result,
        docs.documentAt,
      );

      expect(holds(toVisitor, SECRET_VALUE)).toBe(false);
      expect(holds(toVisitor, SECRET_KEY)).toBe(false);
      expect(toVisitor.result.nonIdempotent[0].differingWriteKeys).toEqual([
        `${space}/${docs.contactsId}`,
      ]);
      expect(toOwner.result).toEqual(result);
    });

    it("withholds what an action logged from a reader its reads refuse", async () => {
      await using docs = await shelf();
      // What an action that read the document had consumed.
      const consumed = () =>
        readProjected(docs.contacts.asSchema(true), hostValueOf).consumed;
      const message = { method: "log" };

      expect(
        gateFor(docs.runtime, visitor).console(
          message,
          [SECRET_VALUE],
          consumed,
        )
          .args,
      ).toEqual([PLACEHOLDER]);
      expect(
        gateFor(docs.runtime, owner).console(message, [SECRET_VALUE], consumed)
          .args,
      ).toEqual([SECRET_VALUE]);
      // A call made outside an action carries no labels to decide it on,
      // and may be a continuation of one that read anything.
      expect(
        gateFor(docs.runtime, visitor).console(
          message,
          ["logged later"],
          undefined,
        ).args,
      ).toEqual([PLACEHOLDER]);
      // Labels that cannot be read refuse.
      expect(
        gateFor(docs.runtime, owner).console(message, ["logged"], () => {
          throw new Error("the transaction is gone");
        }).args,
      ).toEqual([PLACEHOLDER]);
    });

    it("withholds what a continuation of an action logs, which runs outside it", async () => {
      const storageManager = StorageManager.emulate({ as: owner });
      const shown: unknown[] = [];
      let gate: HostReadGate | undefined;
      let heardBoth: () => void = () => {};
      const both = new Promise<void>((resolve) => {
        heardBoth = resolve;
      });
      const runtime = new Runtime({
        apiUrl: new URL("http://localhost"),
        storageManager,
        consoleHandler: ({ method, args, consumed }) => {
          if (gate === undefined) return args;
          shown.push(
            gate.console(
              { method },
              args.map((arg) => toConsoleDebugValue(arg)),
              consumed,
            ).args,
          );
          if (shown.length === 2) heardBoth();
          return [];
        },
      });
      try {
        gate = gateFor(runtime, visitor);
        const tx = runtime.edit();
        const input = runtime.getCell(space, "logged-input", undefined, tx);
        writeSeedEnvelopeDoc(tx, space);
        seedStoredEnvelope(tx, {
          space,
          id: input.getAsNormalizedFullLink().id!,
          type: "application/json",
          path: [],
        }, {
          value: { n: SECRET_VALUE },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{ path: [], label: { confidentiality: [ownerOnly] } }],
            },
          },
        } as FabricValue);
        expect((await tx.commit()).ok).toBeDefined();
        const compiled = await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: [
              "import { computed, pattern } from 'commonfabric';",
              "export default pattern<{ n: string }, { out: string }>(",
              "  ({ n }) => {",
              "    const out = computed(() => {",
              "      const v = n;",
              "      console.log('in the action', v);",
              "      Promise.resolve().then(() => console.log('after it', v));",
              "      return 'x' + v;",
              "    });",
              "    return { out };",
              "  },",
              ");",
            ].join("\n"),
          }],
        }, { space });
        const result = runtime.getCell(
          space,
          "logged-result",
          compiled.resultSchema,
        );
        const run = runtime.edit();
        runtime.run(
          run,
          compiled,
          runtime.getCell(space, "logged-input"),
          result,
        );
        await run.commit();
        const cancel = result.sink(() => {});
        await both;
        cancel();

        expect(shown).toEqual([[PLACEHOLDER], [PLACEHOLDER]]);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("withholds the error a handler throws after an `await`, from a reader its reads refuse", async () => {
      const storageManager = StorageManager.emulate({ as: owner });
      let gate: HostReadGate | undefined;
      let shown: unknown;
      let carriedLabels = false;
      let reported: () => void = () => {};
      const report = new Promise<void>((resolve) => (reported = resolve));
      const runtime = new Runtime({
        apiUrl: new URL("http://localhost"),
        storageManager,
        errorHandlers: [(error) => {
          if (gate === undefined) return;
          carriedLabels = error.consumed !== undefined;
          shown = gate.error(runtimeErrorReport(error), error.consumed);
          reported();
        }],
      });
      try {
        gate = gateFor(runtime, visitor);
        const tx = runtime.edit();
        const input = runtime.getCell(space, "thrown-input", undefined, tx);
        writeSeedEnvelopeDoc(tx, space);
        seedStoredEnvelope(tx, {
          space,
          id: input.getAsNormalizedFullLink().id!,
          type: "application/json",
          path: [],
        }, {
          value: { n: SECRET_VALUE },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{ path: [], label: { confidentiality: [ownerOnly] } }],
            },
          },
        } as FabricValue);
        expect((await tx.commit()).ok).toBeDefined();
        const compiled = await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: [
              "import { handler, pattern, Stream } from 'commonfabric';",
              "const boom = handler<unknown, { n: string }>(",
              "  async (_event, { n }) => {",
              "    const v = n;",
              "    await Promise.resolve();",
              "    throw new Error('after the await ' + v);",
              "  },",
              ");",
              "export default pattern<{ n: string }, { go: Stream<unknown> }>(",
              "  ({ n }) => ({ go: boom({ n }) }),",
              ");",
            ].join("\n"),
          }],
        }, { space });
        const result = runtime.getCell(
          space,
          "thrown-result",
          compiled.resultSchema,
        );
        const run = runtime.edit();
        runtime.run(
          run,
          compiled,
          runtime.getCell(space, "thrown-input"),
          result,
        );
        await run.commit();
        const cancel = result.sink(() => {});
        await runtime.idle();
        result.key("go").send({} as never);
        await report;
        cancel();

        // The runner marks the rejection with the run that raised it, so the
        // report carries the labels the run read.
        expect(carriedLabels).toBe(true);
        expect(holds(shown, SECRET_VALUE)).toBe(false);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("withholds what a telemetry marker says of a failed run from a reader the run's reads refuse", async () => {
      const storageManager = StorageManager.emulate({ as: owner });
      const toVisitor: unknown[] = [];
      const toOwner: unknown[] = [];
      let errors = 0;
      let reportedBoth: () => void = () => {};
      const both = new Promise<void>((resolve) => (reportedBoth = resolve));
      const runtime = new Runtime({
        apiUrl: new URL("http://localhost"),
        storageManager,
        errorHandlers: [() => {
          if (++errors === 2) reportedBoth();
        }],
      });
      try {
        const visitorGate = gateFor(runtime, visitor);
        const ownerGate = gateFor(runtime, owner);
        const documentAt = documentAtIn(runtime);
        runtime.telemetry.addEventListener("telemetry", (event) => {
          if (!(event instanceof RuntimeTelemetryEvent)) return;
          const { marker, consumed } = event;
          toVisitor.push(
            visitorGate.telemetry(marker, documentAt, consumed).marker,
          );
          toOwner.push(
            ownerGate.telemetry(marker, documentAt, consumed).marker,
          );
        });
        const tx = runtime.edit();
        const input = runtime.getCell(space, "failing-input", undefined, tx);
        writeSeedEnvelopeDoc(tx, space);
        seedStoredEnvelope(tx, {
          space,
          id: input.getAsNormalizedFullLink().id!,
          type: "application/json",
          path: [],
        }, {
          value: { n: SECRET_VALUE },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{ path: [], label: { confidentiality: [ownerOnly] } }],
            },
          },
        } as FabricValue);
        expect((await tx.commit()).ok).toBeDefined();
        const compiled = await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: [
              "import { computed, handler, pattern, Stream } from 'commonfabric';",
              "const boom = handler<unknown, { n: string }>(",
              "  (_event, { n }) => {",
              "    throw new Error('handler ' + n);",
              "  },",
              ");",
              "export default pattern<",
              "  { n: string },",
              "  { out: string; go: Stream<unknown> }",
              ">(({ n }) => {",
              "  const out = computed(() => {",
              "    throw new Error('lift ' + n);",
              "  });",
              "  return { out, go: boom({ n }) };",
              "});",
            ].join("\n"),
          }],
        }, { space });
        const result = runtime.getCell(
          space,
          "failing-result",
          compiled.resultSchema,
        );
        const run = runtime.edit();
        runtime.run(
          run,
          compiled,
          runtime.getCell(space, "failing-input"),
          result,
        );
        await run.commit();
        const cancel = result.sink(() => {});
        await runtime.idle();
        result.key("go").send({} as never);
        await both;
        cancel();

        expect(holds(toVisitor, SECRET_VALUE)).toBe(false);
        expect(holds(toVisitor, PLACEHOLDER)).toBe(true);
        // Decided on what the run read, not withheld from everyone: its
        // owner is told why it failed.
        expect(holds(toOwner, `lift ${SECRET_VALUE}`)).toBe(true);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("withholds a navigation an action chose from what it read, from a reader its reads refuse", async () => {
      const storageManager = StorageManager.emulate({ as: owner });
      let gates: { visitor: HostReadGate; owner: HostReadGate } | undefined;
      const decisions: { ref: unknown; visitor: unknown; owner: unknown }[] =
        [];
      let navigated: () => void = () => {};
      const navigation = new Promise<void>((resolve) => (navigated = resolve));
      const runtime = new Runtime({
        apiUrl: new URL("http://localhost"),
        storageManager,
        // Enforced, the navigation's own commit is refused for writing what it
        // read into its result, which no label there admits. Observed, the
        // commit lands, and the gate alone decides where a host is sent, as
        // it must under every mode.
        cfcEnforcementMode: "observe",
        navigateCallback: (target, consumed) => {
          if (gates === undefined) return;
          const ref = createCellRef(target);
          const decide = (gate: HostReadGate) => {
            try {
              return gate.navigate(ref, consumed);
            } catch (error) {
              return error;
            }
          };
          decisions.push({
            ref,
            visitor: decide(gates.visitor),
            owner: decide(gates.owner),
          });
          navigated();
        },
      });
      try {
        gates = {
          visitor: gateFor(runtime, visitor),
          owner: gateFor(runtime, owner),
        };
        const tx = runtime.edit();
        const destination = runtime.getCell(
          space,
          "navigation-destination",
          undefined,
          tx,
        );
        destination.set({ title: "anyone may see this" });
        // Where to go is held in a document only its owner may see.
        const input = runtime.getCell(space, "navigation-input", undefined, tx);
        writeSeedEnvelopeDoc(tx, space);
        seedStoredEnvelope(tx, {
          space,
          id: input.getAsNormalizedFullLink().id!,
          type: "application/json",
          path: [],
        }, {
          value: { target: destination.getAsLink() },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{ path: [], label: { confidentiality: [ownerOnly] } }],
            },
          },
        } as FabricValue);
        expect((await tx.commit()).ok).toBeDefined();
        const compiled = await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: [
              "import { navigateTo, pattern } from 'commonfabric';",
              "export default pattern<",
              "  { target: unknown },",
              "  { nav: boolean }",
              ">(({ target }) => ({ nav: navigateTo(target) }));",
            ].join("\n"),
          }],
        }, { space });
        const result = runtime.getCell(
          space,
          "navigation-result",
          compiled.resultSchema,
        );
        const run = runtime.edit();
        runtime.run(
          run,
          compiled,
          runtime.getCell(space, "navigation-input"),
          result,
        );
        await run.commit();
        const cancel = result.sink(() => {});
        await navigation;
        cancel();

        expect(decisions.length).toBe(1);
        expect(decisions[0].visitor).toBeInstanceOf(NavigationWithheldError);
        expect(decisions[0].owner).toEqual({
          type: NotificationType.NavigateRequest,
          targetCellRef: decisions[0].ref,
        });
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("decides a server's navigation on what chose it, and leaves one it withholds unacked", async () => {
      const nonce = "nav:host-read-channels";
      const enact = async (viewer: Identity) => {
        const storageManager = StorageManager.emulate({ as: owner });
        let gate: HostReadGate | undefined;
        const delivered: unknown[] = [];
        let called: () => void = () => {};
        const enacted = new Promise<void>((resolve) => (called = resolve));
        const runtime = new Runtime({
          apiUrl: new URL("http://localhost"),
          storageManager,
          experimental: { serverExecution: true },
          // As the worker's callback does: the gate's request is posted.
          navigateCallback: (target, consumed) => {
            called();
            if (gate === undefined) return;
            delivered.push(gate.navigate(createCellRef(target), consumed));
          },
        });
        try {
          gate = gateFor(runtime, viewer);
          const tx = runtime.edit();
          const destination = runtime.getCell(
            space,
            "server-destination",
            undefined,
            tx,
          );
          destination.set({ title: "anyone may see this" });
          const destinationId = destination.getAsNormalizedFullLink().id;
          // The intent a server writes into this session's effects
          // instance, raw as the server writes it, chosen from what only the
          // owner may see.
          runtime.getCellFromLink({
            space,
            id: SERVER_EXECUTION_EFFECTS_DOC_ID,
            scope: "session",
            path: [],
          }).withTx(tx).setRawUntyped({
            entries: [{
              nonce,
              kind: "navigate",
              args: {
                target: { id: destinationId, path: [] },
                chosenFrom: {
                  confidentiality: [ownerOnly],
                  integrity: [],
                  modulePolicySpaces: {},
                },
              },
              issuedIn: null,
            }],
          });
          expect((await tx.commit()).ok).toBeDefined();
          await enacted;
          await runtime.settled();
          const acks = runtime.getCellFromLink({
            space,
            id: SERVER_EXECUTION_EFFECTS_DOC_ID,
            scope: "session",
            path: ["acks"],
          }).get();
          return { delivered, acks };
        } finally {
          await runtime.dispose();
          await storageManager.close();
        }
      };

      const toVisitor = await enact(visitor);
      expect(toVisitor.delivered).toEqual([]);
      expect(holds(toVisitor.acks, nonce)).toBe(false);

      const toOwner = await enact(owner);
      expect(toOwner.delivered).toEqual([
        expect.objectContaining({ type: NotificationType.NavigateRequest }),
      ]);
      expect(toOwner.acks).toEqual({ [nonce]: true });
    });

    it("decides a navigation as it decides what an action logged", async () => {
      await using docs = await shelf();
      const consumed = () =>
        readProjected(docs.contacts.asSchema(true), hostValueOf).consumed;
      const target = createCellRef(docs.caveated);

      // A withheld navigation is not answered with nothing, which a caller
      // could take for one made: it throws.
      expect(() => gateFor(docs.runtime, visitor).navigate(target, consumed))
        .toThrow(NavigationWithheldError);
      expect(gateFor(docs.runtime, owner).navigate(target, consumed))
        .toEqual({
          type: NotificationType.NavigateRequest,
          targetCellRef: target,
        });
      // A request made outside an action carries no labels to decide it on.
      expect(() => gateFor(docs.runtime, owner).navigate(target, undefined))
        .toThrow(NavigationWithheldError);
      expect(new HostReadGate(undefined, {}).navigate(target, undefined))
        .toEqual({
          type: NotificationType.NavigateRequest,
          targetCellRef: target,
        });
    });

    it("withholds a failed action's message and stack from a reader its reads refuse", async () => {
      await using docs = await shelf();
      const consumed = () =>
        readProjected(docs.contacts.asSchema(true), hostValueOf).consumed;
      const report = {
        message: `could not parse ${SECRET_VALUE}`,
        stackTrace: `Error: could not parse ${SECRET_VALUE}\n  at action`,
        pieceId: "piece-1",
      };

      const toVisitor = gateFor(docs.runtime, visitor).error(report, consumed);
      const toOwner = gateFor(docs.runtime, owner).error(report, consumed);

      expect(holds(toVisitor, SECRET_VALUE)).toBe(false);
      expect(toVisitor.pieceId).toBe("piece-1");
      expect(toVisitor.stackTrace).toBeUndefined();
      expect(toOwner).toEqual({
        type: NotificationType.ErrorReport,
        ...report,
      });
    });
  });

  it("returns its owner a value carrying a caveat of the prompt-influence family", async () => {
    await using docs = await shelf();

    expect(
      gateFor(docs.runtime, owner).read(
        docs.caveated.key("text").asSchema(stringSchema),
      ),
    ).toEqual({ value: "fetched page" });
  });
});
