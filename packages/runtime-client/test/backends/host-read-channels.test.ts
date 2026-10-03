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
import { PiecesController } from "@commonfabric/piece/ops";
import { defaultRenderConfidentialityCeiling } from "@commonfabric/lib-shell/runtime";
import {
  type Cell,
  hostValueOf,
  makeAddressKey,
  readProjected,
  Runtime,
  type RuntimeTelemetryMarkerResult,
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
import { type DocumentAt, HostReadGate } from "@/backends/host-read-gate.ts";
import {
  renderConfidentialityResolverFor,
  renderMembershipProviderFor,
  renderModulePolicySourceFor,
  toConsoleDebugValue,
} from "@/backends/runtime-processor.ts";
import { runtimeErrorReport } from "@/backends/runtime-error.ts";
import { createCellRef } from "@/backends/utils.ts";
import { RequestType } from "@/protocol/mod.ts";
import { buildProcessor } from "./build-processor.ts";
import { NotificationType } from "@/protocol/mod.ts";

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
  const documentAt: DocumentAt = (documentSpace, id, scope) =>
    runtime.getCellFromLink({
      space: documentSpace as typeof space,
      id: id as typeof contactsId,
      path: [],
      ...(scope === undefined ? {} : { scope }),
    });

  return {
    runtime,
    write,
    contacts,
    contactsId,
    caveated,
    documentAt,
    async [Symbol.asyncDispose]() {
      await runtime.dispose();
      await storageManager.close();
    },
  };
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
