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
import {
  cellLabelSources,
  rootRenderPolicyFor,
} from "@commonfabric/html/worker";
import { createSession, Identity } from "@commonfabric/identity";
import { SERVER_EXECUTION_EFFECTS_DOC_ID } from "@commonfabric/memory/v2";
import { PiecesController } from "@commonfabric/piece/ops";
import { defaultRenderConfidentialityCeiling } from "@commonfabric/lib-shell/runtime";
import {
  type Cell,
  entityIdFrom,
  hostValueOf,
  makeAddressKey,
  NavigationWithheldError,
  readProjected,
  Runtime,
  RuntimeTelemetryEvent,
  type RuntimeTelemetryMarkerResult,
  slugIdForSpace,
} from "@commonfabric/runner";
import type { SpaceMembershipProvider } from "@commonfabric/runner/cfc";
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
  type GraphDocumentAt,
  HostReadGate,
} from "@/backends/host-read-gate.ts";
import {
  navigationPoster,
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
      // A read that asks for the label beside the value is given the same
      // view, and a refused read none.
      const withLabel = { includeCfcLabel: true };
      expect(gateFor(docs.runtime, owner).read(docs.contacts, withLabel))
        .toEqual({
          value: { [SECRET_KEY]: SECRET_VALUE },
          cfcLabel: toOwner.cfcLabel,
        });
      expect(gateFor(docs.runtime, visitor).read(docs.contacts, withLabel))
        .toEqual({ refused: { refusedBy: "display-ceiling" } });
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

      expect(await gateFor(docs.runtime, visitor).slug(docs.contacts)).toEqual({
        refused: { refusedBy: "display-ceiling" },
      });
      expect(await gateFor(docs.runtime, owner).slug(docs.contacts)).toEqual({
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

        const slug = await gate.slug(unloaded());
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

    it("names where links lead on the nodes holding them, once the documents they consult are loaded", async () => {
      // The owner writes a chain of links: from a document anyone may see,
      // to one only the owner may see, through one without labels, to
      // another. A second worker of the owner's, and a visitor's, hold none
      // of them yet.
      const server = newLoopbackServer();
      const writer = new Runtime({
        apiUrl: new URL("http://localhost"),
        storageManager: EmulatedStorageManager.connectTo(server, { as: owner }),
      });
      const readers: Runtime[] = [];
      try {
        const tx = writer.edit();
        writeSeedEnvelopeDoc(tx, space);
        const seed = (name: string, value: FabricValue, labels?: Labels) => {
          const cell = writer.getCell(space, name, undefined, tx);
          seedStoredEnvelope(tx, {
            space,
            id: cell.getAsNormalizedFullLink().id!,
            type: "application/json",
            path: [],
          }, {
            value,
            ...(labels && {
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
          return cell;
        };
        const end = seed("chain-end", { note: "unlabeled" });
        const middle = seed("chain-middle", { c: end.getAsLink() });
        const sealed = seed(
          "sealed-target",
          { b: middle.getAsLink(), note: SECRET_VALUE },
          [[[], [ownerOnly]]],
        );
        seed("open-holder", { a: sealed.getAsLink() });
        const endId = end.getAsNormalizedFullLink().id;
        const middleId = middle.getAsNormalizedFullLink().id;
        const sealedId = sealed.getAsNormalizedFullLink().id;
        expect((await tx.commit()).ok).toBeDefined();
        await writer.storageManager.synced();
        const resolve = async (
          viewer: Identity,
          along: (holder: Cell<unknown>) => Cell<unknown>,
        ) => {
          const reader = new Runtime({
            apiUrl: new URL("http://localhost"),
            storageManager: EmulatedStorageManager.connectTo(server, {
              as: viewer,
            }),
          });
          readers.push(reader);
          const holder = reader.getCell(space, "open-holder");
          await holder.sync();
          const processor = buildProcessor({
            runtime: reader,
            identity: viewer,
            space: viewer.did(),
            renderConfidentialityCeiling: defaultRenderConfidentialityCeiling(
              viewer.did(),
            ),
          });
          try {
            return await processor.handleCellResolveAsCell({
              type: RequestType.CellResolveAsCell,
              cell: createCellRef(along(holder)),
            });
          } finally {
            await processor.dispose();
          }
        };
        const names = (id: string) => ({
          cell: expect.objectContaining({ id }),
        });

        // The owner, with no document behind the first link loaded:
        // followed, each document loaded as the link before it leads there,
        // not refused as unread.
        expect(await resolve(owner, (h) => h.key("a"))).toEqual(
          names(sealedId),
        );
        expect(await resolve(owner, (h) => h.key("a").key("b"))).toEqual(
          names(middleId),
        );
        expect(
          await resolve(owner, (h) => h.key("a").key("b").key("c")),
        ).toEqual(names(endId));
        // The visitor may read the first holder, so may be told the address
        // it holds, as a read of the holder hands it the same address as a
        // ref. What is behind it is decided when it is read.
        expect(await resolve(visitor, (h) => h.key("a"))).toEqual(
          names(sealedId),
        );
        // The second link sits in the document only the owner may see, so
        // where it leads is that document's content, as is every address
        // reached through it.
        for (
          const past of [
            await resolve(visitor, (h) => h.key("a").key("b")),
            await resolve(visitor, (h) => h.key("a").key("b").key("c")),
          ]
        ) {
          expect(past).toEqual({ refused: { refusedBy: "display-ceiling" } });
          expect(JSON.stringify(past)).not.toContain(middleId);
          expect(JSON.stringify(past)).not.toContain(endId);
        }
      } finally {
        for (const reader of readers) await reader.dispose();
        await writer.dispose();
        await server.close();
      }
    });

    it("refuses, rather than fails, a decision on a path that cannot be resolved", async () => {
      await using docs = await shelf();
      // A link that leads back through its own position never resolves.
      const loop = await docs.write("link-loop", {
        a: docs.runtime.getCell(space, "link-loop").key("a").key("b")
          .getAsLink(),
      });
      const looped = loop.key("a").key("b");
      expect(() => looped.resolveAsCell()).toThrow("Link cycle detected");

      for (const viewer of [visitor, owner]) {
        const gate = gateFor(docs.runtime, viewer);
        expect(gate.linkRefusal(looped)).toEqual({
          refused: { refusedBy: "display-ceiling" },
        });
        expect(gate.metadataRefusal(looped)).toEqual({
          refused: { refusedBy: "display-ceiling" },
        });
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
        const answer = await processor.handleCellResolveAsCell({
          type: RequestType.CellResolveAsCell,
          cell: createCellRef(holder.key("link")),
        });
        expect(answer).toEqual({ refused: { refusedBy: "display-ceiling" } });
        expect(JSON.stringify(answer)).not.toContain(targetId);
        // A cell whose path follows no link resolves to the address named.
        expect(
          await processor.handleCellResolveAsCell({
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

    it("decides a member's slug, metadata and unmeasured reads once the access list they consult loads", async () => {
      // As above: the visitor may read the owner's space, and its worker has
      // loaded a document labeled with that space, but not the access list.
      // Each decision is made on a worker of its own, so that one's load of
      // the access list does not answer for the next.
      const server = newLoopbackServer();
      const writer = new Runtime({
        apiUrl: new URL("http://localhost"),
        storageManager: EmulatedStorageManager.connectTo(server, { as: owner }),
      });
      const readers: Runtime[] = [];
      const coldReader = async () => {
        const reader = new Runtime({
          apiUrl: new URL("http://localhost"),
          storageManager: EmulatedStorageManager.connectTo(server, {
            as: visitor,
          }),
        });
        readers.push(reader);
        const cell = reader.getCell(space, "slugged-for-members");
        await cell.sync();
        return { gate: gateFor(reader, visitor), cell };
      };
      try {
        const tx = writer.edit();
        tx.writeOrThrow({
          space,
          id: `of:${space}` as `${string}:${string}`,
          type: "application/json",
          path: [],
        }, { value: { [space]: "OWNER", [visitor.did()]: "READ" } });
        const labeled = writer.getCell(
          space,
          "slugged-for-members",
          undefined,
          tx,
        );
        writeSeedEnvelopeDoc(tx, space);
        seedStoredEnvelope(tx, {
          space,
          id: labeled.getAsNormalizedFullLink().id!,
          type: "application/json",
          path: [],
        }, {
          value: { note: "for members of the space" },
          slug: "for-members",
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
        const build = () => Promise.resolve({ rows: ["built"] });

        const slugged = await coldReader();
        expect(await slugged.gate.slug(slugged.cell)).toEqual({
          slug: "for-members",
        });
        const unmeasured = await coldReader();
        expect(await unmeasured.gate.fromCell(unmeasured.cell, build))
          .toEqual({ rows: ["built"] });
        const metadata = await coldReader();
        expect(await metadata.gate.fromMetadata(metadata.cell, build))
          .toEqual({ rows: ["built"] });
      } finally {
        for (const reader of readers) await reader.dispose();
        await writer.dispose();
        await server.close();
      }
    });

    it("refuses, rather than fails, a decision whose access list cannot be loaded", async () => {
      await using docs = await shelf();
      const member = await docs.write("unloadable-list", { note: "x" }, [[
        [],
        [cfcAtom.space(visitor.did())],
      ]]);
      const ceiling = defaultRenderConfidentialityCeiling(owner.did());
      const modulePolicies = renderModulePolicySourceFor(docs.runtime, ceiling);
      // An access list that never loads.
      const membership: SpaceMembershipProvider = {
        readerRole: () => null,
        subscribe: () => () => {},
        held: () => false,
        whenHeld: () => Promise.reject(new Error("the access list is gone")),
      };
      const gate = new HostReadGate(rootRenderPolicyFor(ceiling), {
        resolveConfidentiality: renderConfidentialityResolverFor(
          docs.runtime,
          owner,
          ceiling,
          owner.did(),
          membership,
          modulePolicies,
        ),
        membership,
        modulePolicies,
      });

      const refused = { refused: { refusedBy: "display-ceiling" } };
      const build = () => Promise.resolve({ rows: [] });
      expect(await gate.settle(member)).toBe(false);
      expect(await gate.fromCell(member, build)).toEqual(refused);
      expect(await gate.fromMetadata(member, build)).toEqual(refused);
      expect(await gate.slug(member)).toEqual(refused);
      expect(await gate.resolveAsCell(member)).toEqual(refused);
    });

    it("refuses a member's document at once where nothing can load its access list", async () => {
      await using docs = await shelf();
      const member = await docs.write("members-only", { note: "x" }, [[
        [],
        [cfcAtom.space(space)],
      ]]);
      // Decided by the configured ceiling alone, with no provider that admits
      // a space's members or loads their list.
      const gate = HostReadGate.forConfiguredCeiling(
        defaultRenderConfidentialityCeiling(owner.did()),
      );

      expect(await gate.hold(member)).toBe(true);
      expect(await gate.settle(member)).toBe(false);
      expect(gate.read(member)).toEqual({
        refused: { refusedBy: "display-ceiling" },
      });
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
    it("builds no program text under a ceiling: pattern sources and graph previews", async () => {
      const storageManager = StorageManager.emulate({ as: owner });
      const runtime = new Runtime({
        apiUrl: new URL("http://localhost"),
        storageManager,
      });
      const PROGRAM_TEXT = "program-text-made-from-a-cell";
      try {
        const compiled = await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: [
              "import { computed, pattern } from 'commonfabric';",
              "export default pattern<{ n: string }, { out: string }>(",
              "  ({ n }) => {",
              `    const out = computed(() => '${PROGRAM_TEXT}' + n);`,
              "    return { out };",
              "  },",
              ");",
            ].join("\n"),
          }],
        }, { space });
        const input = runtime.getCell(space, "program-input");
        const result = runtime.getCell(
          space,
          "program-result",
          compiled.resultSchema,
        );
        const tx = runtime.edit();
        input.withTx(tx).set({ n: "x" });
        runtime.run(tx, compiled, input, result);
        await tx.commit();
        const cancel = result.sink(() => {});
        await runtime.idle();
        const processorFor = (ceiling: boolean) =>
          buildProcessor({
            runtime,
            identity: owner,
            space,
            ...(ceiling
              ? {
                renderConfidentialityCeiling:
                  defaultRenderConfidentialityCeiling(owner.did()),
              }
              : {}),
          });
        const sources = {
          type: RequestType.GetPatternSources,
        } as const;
        const graph = { type: RequestType.GetGraphSnapshot } as const;
        const underCeiling = processorFor(true);
        const unbounded = processorFor(false);
        try {
          const refused = underCeiling.getPatternSources(sources);
          expect(holds(refused, PROGRAM_TEXT)).toBe(false);
          expect(refused).toEqual({
            refused: { refusedBy: "display-ceiling" },
          });
          expect(holds(underCeiling.getGraphSnapshot(graph), PROGRAM_TEXT))
            .toBe(false);
          // With no ceiling, nothing is decided.
          expect(holds(unbounded.getPatternSources(sources), PROGRAM_TEXT))
            .toBe(true);
          expect(holds(unbounded.getGraphSnapshot(graph), PROGRAM_TEXT))
            .toBe(true);
          // A graph marker in telemetry is decided as the snapshot is.
          const marker: RuntimeTelemetryMarkerResult = {
            type: "scheduler.graph.snapshot",
            graph: runtime.scheduler.getGraphSnapshot(),
            timeStamp: 1,
          };
          expect(holds(marker, PROGRAM_TEXT)).toBe(true);
          expect(
            holds(
              gateFor(runtime, owner).telemetry(marker, documentAtIn(runtime)),
              PROGRAM_TEXT,
            ),
          ).toBe(false);
        } finally {
          await underCeiling.dispose();
          await unbounded.dispose();
        }
        cancel();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

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
      const pulled: RuntimeTelemetryMarkerResult = {
        type: "storage.pull.error",
        id: "pull",
        error: `could not read ${SECRET_VALUE}`,
        timeStamp: 3,
      };
      const attempted: RuntimeTelemetryMarkerResult = {
        type: "scheduler.read-attempt",
        kind: "reactive",
        reads: { proxyAccesses: 1, linkResolutions: 0 },
        timeStamp: 4,
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
      expect(toOwner.telemetry(pulled, docs.documentAt).marker).toEqual({
        ...pulled,
        error: PLACEHOLDER,
      });
      // Counts and times carry nothing of a cell.
      for (const counted of [attempted, settled]) {
        expect(toVisitor.telemetry(counted, docs.documentAt).marker).toEqual(
          counted,
        );
      }
      // With no ceiling, nothing is decided.
      expect(
        new HostReadGate(undefined, {}).telemetry(committed, docs.documentAt)
          .marker,
      ).toEqual(committed);
    });

    it("names a refused document alone in the scheduler graph's addresses", async () => {
      await using docs = await shelf();
      const sealedKey = `${space}/${docs.contactsId}/space/${SECRET_KEY}`;
      const openKey = `${space}/${docs.caveated.getAsNormalizedFullLink().id}` +
        "/space/text";
      const elsewhere = `${space}/of:another-instance/user:someone-else/field`;
      const snapshot = {
        nodes: [{
          id: "action",
          type: "computation" as const,
          isDirty: false,
          isPending: false,
          reads: [sealedKey, openKey],
          shallowReads: [sealedKey],
          writes: [elsewhere],
        }],
        edges: [],
        timestamp: 1,
      };
      const documentAt: GraphDocumentAt = (documentSpace, id, scopeKey) =>
        scopeKey === "space" ? docs.documentAt(documentSpace, id) : undefined;

      const toVisitor = gateFor(docs.runtime, visitor).graphSnapshot(
        snapshot,
        documentAt,
      ).snapshot.nodes[0];
      expect(holds(toVisitor, SECRET_KEY)).toBe(false);
      expect(toVisitor.reads).toContain(`${space}/${docs.contactsId}/space`);
      // An instance the worker cannot place is named alone, for anyone.
      expect(toVisitor.writes).toEqual([
        `${space}/of:another-instance/user:someone-else`,
      ]);
      const toOwner = gateFor(docs.runtime, owner).graphSnapshot(
        snapshot,
        documentAt,
      ).snapshot.nodes[0];
      expect(toOwner.reads).toEqual([sealedKey, openKey]);
    });

    it("names the document alone in a telemetry marker's addresses, which name no scope", async () => {
      await using docs = await shelf();
      const sealedKey = `${space}/${docs.contactsId}/${SECRET_KEY}`;
      const dependencies: RuntimeTelemetryMarkerResult = {
        type: "scheduler.dependencies.update",
        actionId: "action",
        reads: [sealedKey],
        // One document, spelled with and without a trailing separator.
        writes: [`${space}/${docs.contactsId}`, `${space}/${docs.contactsId}/`],
        timeStamp: 1,
      };
      const run: RuntimeTelemetryMarkerResult = {
        type: "scheduler.run.complete",
        actionId: "action",
        actionInfo: { patternName: "p", reads: [sealedKey], writes: [] },
        durationMs: 1,
        timeStamp: 2,
      };
      for (const viewer of [visitor, owner]) {
        const gate = gateFor(docs.runtime, viewer);
        const shownDependencies = gate.telemetry(dependencies, docs.documentAt);
        expect(holds(shownDependencies, SECRET_KEY)).toBe(false);
        expect(shownDependencies.marker).toEqual({
          ...dependencies,
          reads: [`${space}/${docs.contactsId}`],
          writes: [`${space}/${docs.contactsId}`],
        });
        expect(holds(gate.telemetry(run, docs.documentAt), SECRET_KEY))
          .toBe(false);
      }
      // With no ceiling, nothing is decided.
      expect(
        new HostReadGate(undefined, {}).telemetry(dependencies, docs.documentAt)
          .marker,
      ).toEqual(dependencies);
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

    it("withholds, under a ceiling, a diagnostic key that names no address it can decide", async () => {
      await using docs = await shelf();
      // Too few segments to name a document in each spelling: the scheduler
      // graph's `space/id/scopeKey/path`, telemetry's `space/id/path`, and a
      // diagnosis's `space/id/path`.
      const unplaced = `${space}/${SECRET_KEY}`;
      const bare = SECRET_KEY;
      const snapshot = {
        nodes: [{
          id: "action",
          type: "computation" as const,
          isDirty: false,
          isPending: false,
          reads: [unplaced],
          writes: [],
        }],
        edges: [],
        timestamp: 1,
      };
      const dependencies: RuntimeTelemetryMarkerResult = {
        type: "scheduler.dependencies.update",
        actionId: "action",
        reads: [bare],
        writes: [],
        timeStamp: 1,
      };
      const diagnosis = {
        nonIdempotent: [{
          actionId: "action:1",
          runs: [{ timestamp: 1, reads: { [bare]: SECRET_VALUE }, writes: {} }],
          differingWriteKeys: [bare],
        }],
        cycles: [],
        duration: 1,
        busyTime: 1,
      };
      const documentAt: GraphDocumentAt = (documentSpace, id) =>
        docs.documentAt(documentSpace, id);

      for (const viewer of [visitor, owner]) {
        const gate = gateFor(docs.runtime, viewer);
        const answers = [
          gate.graphSnapshot(snapshot, documentAt),
          gate.telemetry(dependencies, docs.documentAt),
          gate.diagnosis(diagnosis, docs.documentAt),
        ];
        for (const answer of answers) {
          expect(holds(answer, SECRET_KEY)).toBe(false);
          expect(holds(answer, SECRET_VALUE)).toBe(false);
          expect(holds(answer, PLACEHOLDER)).toBe(true);
        }
      }
      // With no ceiling, nothing is decided.
      expect(
        new HostReadGate(undefined, {}).diagnosis(diagnosis, docs.documentAt)
          .result,
      ).toEqual(diagnosis);
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
      // A module policy's label is decided on its manifest, looked up in the
      // spaces the labeled documents were read from; none is published here,
      // so the policy cannot be shown to admit what the action read.
      const governed = await docs.write("policy-governed", { note: "x" }, [[
        [],
        [cfcAtom.modulePolicyRef("module", "policy", "digest", owner.did())],
      ]]);
      const consumedGoverned = () =>
        readProjected(governed.asSchema(true), hostValueOf).consumed;
      expect(consumedGoverned().modulePolicySpaces.size).toBe(1);
      expect(
        gateFor(docs.runtime, owner).console(
          message,
          ["logged"],
          consumedGoverned,
        ).args,
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
        navigateCallback: async (target, consumed) => {
          if (gates === undefined) return;
          const ref = createCellRef(target);
          const decide = async (gate: HostReadGate) => {
            try {
              return await gate.navigate(ref, consumed);
            } catch (error) {
              return error;
            }
          };
          decisions.push({
            ref,
            visitor: await decide(gates.visitor),
            owner: await decide(gates.owner),
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

    it("decides a server's navigation on what chose it and where it is stored, and retires only a definitive withhold", async () => {
      const nonce = "nav:host-read-channels";
      const sealed = {
        confidentiality: [ownerOnly],
        integrity: [],
        modulePolicySpaces: {},
      };
      const open = {
        confidentiality: [],
        integrity: [],
        modulePolicySpaces: {},
      };
      // A claim the entry's writer chose, asserting the visitor reads the
      // owner's space, which it does not.
      const claimingAccess: {
        confidentiality: CfcAtom[];
        integrity: CfcAtom[];
        modulePolicySpaces: Record<string, string[]>;
      } = {
        confidentiality: [],
        integrity: [cfcAtom.hasRole(visitor.did(), space, "reader")],
        modulePolicySpaces: {},
      };
      const enact = async (
        viewer: Identity,
        intent: { chosenFrom?: typeof claimingAccess; stored?: CfcAtom },
      ) => {
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
          navigateCallback: async (target, consumed) => {
            called();
            if (gate === undefined) return;
            delivered.push(
              await gate.navigate(createCellRef(target), consumed),
            );
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
          const intents = {
            entries: [{
              nonce,
              kind: "navigate",
              args: {
                target: { id: destinationId, path: [] },
                ...(intent.chosenFrom === undefined
                  ? {}
                  : { chosenFrom: intent.chosenFrom }),
              },
              issuedIn: null,
            }],
          };
          if (intent.stored !== undefined) {
            // An entry something other than the server wrote, from what only
            // some may see, and so stored with that label.
            writeSeedEnvelopeDoc(tx, space);
            seedStoredEnvelope(tx, {
              space,
              id: SERVER_EXECUTION_EFFECTS_DOC_ID,
              scope: "session",
              type: "application/json",
              path: [],
            }, {
              value: intents,
              cfc: {
                version: 1,
                schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
                labelMap: {
                  version: 1,
                  entries: [{
                    path: ["entries"],
                    label: { confidentiality: [intent.stored] },
                  }],
                },
              },
            } as FabricValue);
          } else {
            // Raw, as the server writes an intent.
            runtime.getCellFromLink({
              space,
              id: SERVER_EXECUTION_EFFECTS_DOC_ID,
              scope: "session",
              path: [],
            }).withTx(tx).setRawUntyped(intents);
          }
          expect((await tx.commit()).ok).toBeDefined();
          await enacted;
          await runtime.settled();
          const acks = runtime.getCellFromLink({
            space,
            id: SERVER_EXECUTION_EFFECTS_DOC_ID,
            scope: "session",
            path: ["acks"],
          }).get();
          return { delivered, acked: holds(acks, nonce) };
        } finally {
          await runtime.dispose();
          await storageManager.close();
        }
      };
      const navigation = [
        expect.objectContaining({ type: NotificationType.NavigateRequest }),
      ];

      // Chosen from what the viewer may not see: withheld, and done for this
      // session, since the same viewer would be refused again.
      expect(await enact(visitor, { chosenFrom: sealed })).toEqual({
        delivered: [],
        acked: true,
      });
      expect(await enact(owner, { chosenFrom: sealed })).toEqual({
        delivered: navigation,
        acked: true,
      });
      // Nothing to decide on, as from a server that carries no labels:
      // withheld, and left pending rather than lost.
      expect(await enact(owner, {})).toEqual({ delivered: [], acked: false });
      // An entry stored with a label is decided on it too, whatever it
      // claims. (A write to a document whose envelope names a schema needs
      // a schema input, which an ack carries none of, so only what reached
      // the host is compared.)
      expect(
        (await enact(visitor, { chosenFrom: open, stored: ownerOnly }))
          .delivered,
      ).toEqual([]);
      expect(
        (await enact(owner, { chosenFrom: open, stored: ownerOnly }))
          .delivered,
      ).toEqual(navigation);
      // The claim's integrity discharges nothing the entry stores: a
      // non-member is not admitted to the owner's space on its say-so.
      expect(
        (await enact(visitor, {
          chosenFrom: claimingAccess,
          stored: cfcAtom.space(space),
        })).delivered,
      ).toEqual([]);
    });

    it("answers a host's read of the session effects document as unreadable", async () => {
      await using docs = await shelf();
      const effects = docs.runtime.getCellFromLink({
        space,
        id: SERVER_EXECUTION_EFFECTS_DOC_ID,
        scope: "session",
        path: [],
      });
      const target = "of:target-chosen-from-a-seal";
      const tx = docs.runtime.edit();
      effects.withTx(tx).setRawUntyped({
        entries: [{
          nonce: "nav:withheld",
          kind: "navigate",
          args: {
            target: { id: target, path: [] },
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
      // A record that links to the entry, as a pattern can mint one.
      const outer = await docs.write("links-to-an-intent", {
        intent: {
          "/": {
            "link@1": {
              id: SERVER_EXECUTION_EFFECTS_DOC_ID,
              path: ["entries", "0"],
              scope: "session",
            },
          },
        },
      });
      const refused = { refused: { refusedBy: "display-ceiling" } };

      for (const viewer of [visitor, owner]) {
        const gate = gateFor(docs.runtime, viewer);
        // The channel decides each intent itself; a host is told none of
        // them, nor the labels they carry.
        expect(gate.read(effects.key("entries"))).toEqual(refused);
        expect(gate.read(effects)).toEqual(refused);
        expect(holds(gate.read(outer), target)).toBe(false);
        expect(holds(gate.read(outer), "chosenFrom")).toBe(false);
        expect(
          await gate.fromCell(
            effects,
            () => Promise.resolve({ rows: [target] }),
          ),
        ).toEqual(refused);
      }
      // A decision on the document's own labels, as a render boundary makes
      // one without a read, finds none it may decide on.
      expect(cellLabelSources(effects.key("entries"))).toBeUndefined();
    });

    it("waits for the access lists a navigation's labels name, and calls a withhold definitive only where nothing can change it", async () => {
      // The visitor may read the owner's space; its worker has not loaded
      // the access list.
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
        expect((await tx.commit()).ok).toBeDefined();
        await writer.storageManager.synced();
        const gate = gateFor(reader, visitor);
        const target = createCellRef(reader.getCell(space, "anywhere"));
        const outcome = async (
          confidentiality: CfcAtom[],
        ): Promise<unknown> => {
          try {
            await gate.navigate(target, () => ({
              confidentiality,
              integrity: [],
              modulePolicySpaces: new Map(),
              sources: [],
            }));
            return "admitted";
          } catch (error) {
            return error instanceof NavigationWithheldError
              ? { definitive: error.definitive }
              : error;
          }
        };

        // A member, decided once its access list loads.
        expect(await outcome([cfcAtom.space(space)])).toBe("admitted");
        // A space the visitor is not a member of: refused, but an access
        // list can still grant access, so not definitive.
        const elsewhere =
          (await Identity.fromPassphrase("host read channels elsewhere"))
            .did();
        expect(await outcome([cfcAtom.space(elsewhere)]))
          .toEqual({ definitive: false });
        // A label no access list or manifest can change.
        expect(await outcome([ownerOnly])).toEqual({ definitive: true });
      } finally {
        await reader.dispose();
        await writer.dispose();
        await server.close();
      }
    });

    it("posts navigations in the order they were issued, a later one never overtaken", async () => {
      // The visitor may read the owner's space; neither worker has loaded
      // its access list.
      const server = newLoopbackServer();
      const writer = new Runtime({
        apiUrl: new URL("http://localhost"),
        storageManager: EmulatedStorageManager.connectTo(server, { as: owner }),
      });
      const readers: Runtime[] = [];
      try {
        const tx = writer.edit();
        tx.writeOrThrow({
          space,
          id: `of:${space}` as `${string}:${string}`,
          type: "application/json",
          path: [],
        }, { value: { [space]: "OWNER", [visitor.did()]: "READ" } });
        expect((await tx.commit()).ok).toBeDefined();
        await writer.storageManager.synced();
        const labels = (confidentiality: CfcAtom[]) => () => ({
          confidentiality,
          integrity: [],
          modulePolicySpaces: new Map(),
          sources: [],
        });
        const posted = async (viewer: Identity, disposed = false) => {
          const reader = new Runtime({
            apiUrl: new URL("http://localhost"),
            storageManager: EmulatedStorageManager.connectTo(server, {
              as: viewer,
            }),
          });
          readers.push(reader);
          const gate = gateFor(reader, viewer);
          const first = reader.getCell(space, "first");
          const second = reader.getCell(space, "second");
          const names = new Map([
            [first.getAsNormalizedFullLink().id, "first"],
            [second.getAsNormalizedFullLink().id, "second"],
          ]);
          const sent: string[] = [];
          const navigate = navigationPoster(
            () => gate,
            (request) => sent.push(names.get(request.targetCellRef.id) ?? "?"),
            () => disposed,
          );
          // A navigation labeled with the owner's space, then one with no
          // labeled input, issued one after the other.
          await Promise.all([
            navigate(first, labels([cfcAtom.space(space)])),
            navigate(second, labels([])),
          ]);
          return sent;
        };

        // The owner is admitted at once, and nothing waits for a list.
        expect(await posted(owner)).toEqual(["first", "second"]);
        // The visitor is refused at first, admitted once the list loads,
        // and by then the later navigation has gone: it is not overtaken.
        expect(await posted(visitor)).toEqual(["second"]);
        // Nothing is posted once the worker is disposed.
        expect(await posted(owner, true)).toEqual([]);
      } finally {
        for (const reader of readers) await reader.dispose();
        await writer.dispose();
        await server.close();
      }
    });

    it("decides a navigation as it decides what an action logged", async () => {
      await using docs = await shelf();
      const consumed = () =>
        readProjected(docs.contacts.asSchema(true), hostValueOf).consumed;
      const target = createCellRef(docs.caveated);

      // A withheld navigation is not answered with nothing, which a caller
      // could take for one made: it rejects.
      await expect(gateFor(docs.runtime, visitor).navigate(target, consumed))
        .rejects.toThrow(NavigationWithheldError);
      expect(await gateFor(docs.runtime, owner).navigate(target, consumed))
        .toEqual({
          type: NotificationType.NavigateRequest,
          targetCellRef: target,
        });
      // A request made outside an action carries no labels to decide it on.
      await expect(gateFor(docs.runtime, owner).navigate(target, undefined))
        .rejects.toThrow(NavigationWithheldError);
      expect(await new HostReadGate(undefined, {}).navigate(target, undefined))
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
