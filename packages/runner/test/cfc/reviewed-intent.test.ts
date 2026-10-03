import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONValue } from "@commonfabric/api";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { hashStringOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";
import {
  commitReviewedIntent,
  parseReviewedIntentDescriptor,
  type PreparedReviewedIntent,
  prepareReviewedIntent,
  REVIEWED_INTENT_WRITER,
  type ReviewedIntentBindings,
  type ReviewedIntentConsent,
  reviewedIntentEndpoint,
  verifyReviewedIntentRecord,
} from "../../src/cfc/reviewed-intent.ts";
import { prepareSnapshotShare } from "../../src/cfc/share-snapshot.ts";
import type {
  CfcEnforcementMode,
  CfcFlowLabelsMode,
  ImplementationIdentity,
} from "../../src/cfc/types.ts";
import { markRendererTrustedEvent } from "../../src/cfc/ui-contract.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import { isAllowedAuthoredImportSpecifier } from "../../src/sandbox/runtime-module-policy.ts";
import { getRuntimeModuleExports } from "../../src/sandbox/runtime-modules.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { setCfcImplementationIdentity } from "../../src/storage/extended-storage-transaction.ts";

const sender = await Identity.fromPassphrase("reviewed-intent-sender");
const other = await Identity.fromPassphrase("reviewed-intent-other");

/** The builtin that keeps the sender's address book. */
const ADDRESS_BOOK = "address-book";

/**
 * The integrity a destination must carry: the address book wrote it, and
 * nothing has written it since.
 */
const WRITTEN_BY_ADDRESS_BOOK = {
  type: CFC_ATOM_TYPE.TransformedBy,
  identity: { kind: "builtin", builtinId: ADDRESS_BOOK },
};

/** A clause the address book keeps its entries under, beside the owner's. */
const ADDRESS_BOOK_CLAUSE = "address-book-private";

/** The builtin a messaging consumer publishes its descriptor with. */
const CONSUMER_WRITER = "messaging-consumer";

/** A pattern's verified handler, as a pattern run attributes its writes. */
const PATTERN: ImplementationIdentity = {
  kind: "verified",
  moduleIdentity: "sha256:composer-module",
  symbol: "composer",
  bindingPath: ["composer"],
};

const DESCRIPTOR = {
  operation: "send-message",
  endpointName: "Example Messenger",
  consumer: "example-messenger",
  parameters: {
    to: {
      kind: "destinations",
      min: 1,
      max: 1,
      integrity: [WRITTEN_BY_ADDRESS_BOOK],
    },
    body: { kind: "text", maxLength: 40 },
  },
  windowMs: 60_000,
  maxAttempts: 1,
};

const WRITTEN_BY_REVIEWED_INTENT = {
  type: CFC_ATOM_TYPE.TransformedBy,
  identity: { kind: "builtin", builtinId: REVIEWED_INTENT_WRITER },
};

/** Creates the renderer-side mark attached only by the trusted host. */
const trustedClick = (pattern = "ReviewedIntent") => {
  const event = {
    type: "click",
    provenance: { origin: "dom", trusted: true, ui: { pattern } },
  };
  markRendererTrustedEvent(event);
  return event;
};

/** `cell` reached through a link with no schema, in `runtime`. */
const schemaless = (runtime: Runtime, cell: Cell<unknown>): Cell<unknown> => {
  const { schema: _schema, ...link } = cell.getAsNormalizedFullLink();
  return runtime.getCellFromLink(link);
};

/** Verifies `record` against `descriptor`, the consumer's own. */
const verified = (record: Cell<unknown>, descriptor: unknown = DESCRIPTOR) =>
  verifyReviewedIntentRecord(
    record,
    parseReviewedIntentDescriptor(descriptor),
  );

/** The values a sender types on the surface. */
const text = (body: string) => ({ body });

/** The destinations a preview shows for `key`. */
const shown = (prepared: PreparedReviewedIntent, key = "to") => {
  const parameter = prepared.parameters[key];
  if (parameter?.kind !== "destinations") {
    throw new Error(`No destinations parameter \`${key}\``);
  }
  return parameter.destinations;
};

/** Rewrites Alice's address book entry as the address book. */
const changeAlice = async (
  fixture: {
    entry: (
      cause: string,
      address: JSONValue,
      options?: EntryOptions,
    ) => Promise<Cell<unknown>>;
  },
  address: string,
) => {
  await fixture.entry("contact-alice", address, {
    confidentiality: [cfcAtom.user(sender.did()), ADDRESS_BOOK_CLAUSE],
  });
};

/** How {@link setup}'s `entry` writes an address book entry. */
interface EntryOptions {
  /** Who writes it: the address book, or a pattern's handler. */
  readonly writer?: ImplementationIdentity;

  /** The confidentiality its schema declares. */
  readonly confidentiality?: readonly unknown[];

  /** Integrity its schema declares. */
  readonly addIntegrity?: readonly unknown[];

  /** Whether its schema claims it for its writer alone. */
  readonly claimed?: boolean;
}

const ADDRESS_BOOK_WRITER: ImplementationIdentity = {
  kind: "builtin",
  builtinId: ADDRESS_BOOK,
};

/**
 * The sender's runtime over one store, holding a consumer's descriptor, two
 * address book entries, an entry a pattern wrote, and a composer document
 * whose fields a pattern binds.
 */
const setup = async (descriptor: unknown = DESCRIPTOR) => {
  const storage = StorageManager.emulate({ as: sender });
  const created: Runtime[] = [];
  /** A runtime acting as `identity`, under `ceiling`, or none for `null`. */
  const runtimeFor = (
    identity: Identity,
    ceiling: readonly unknown[] | null = [
      cfcAtom.user(identity.did()),
      ADDRESS_BOOK_CLAUSE,
    ],
  ) => {
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: storage,
      trustSnapshotProvider: () => ({
        id: identity.did(),
        actingPrincipal: identity.did(),
      }),
      ...(ceiling === null
        ? {}
        : { cfcReadMaxConfidentiality: ceiling as never }),
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    created.push(runtime);
    return runtime;
  };
  const runtime = runtimeFor(sender);
  const home = sender.did();

  const publish = runtime.edit();
  setCfcImplementationIdentity(publish, {
    kind: "builtin",
    builtinId: CONSUMER_WRITER,
  });
  const descriptorCell = runtime.getCell(home, "messaging-descriptor", {
    type: "object",
    ifc: { writeAuthorizedBy: [CONSUMER_WRITER] },
  }, publish);
  descriptorCell.set(descriptor as never);
  // The sender's private notes, which every entry's writer reads first: a
  // writer's `TransformedBy` is minted only over a labeled read.
  const notes = runtime.getCell(home, "address-book-notes", {
    ifc: { confidentiality: [cfcAtom.user(home)] },
  } as never, publish);
  notes.set({ updated: 1 } as never);
  expect((await publish.commit()).error).toBeUndefined();

  /** Writes an address book entry at `cause`, as `options.writer`. */
  const entry = async (
    cause: string,
    address: JSONValue,
    {
      writer = ADDRESS_BOOK_WRITER,
      confidentiality = [cfcAtom.user(home)],
      addIntegrity = [],
      claimed = true,
    }: EntryOptions = {},
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    setCfcImplementationIdentity(tx, writer);
    notes.withTx(tx).get();
    const cell = runtime.getCell(home, cause, {
      ifc: {
        confidentiality,
        ...(addIntegrity.length > 0 ? { addIntegrity } : {}),
        ...(claimed && writer.kind === "builtin"
          ? { writeAuthorizedBy: [writer.builtinId] }
          : {}),
      },
    } as never, tx);
    cell.set(address as never);
    expect((await tx.commit()).error).toBeUndefined();
    return cell.withTx(undefined);
  };
  const alice = await entry("contact-alice", "tel:+15550100", {
    confidentiality: [cfcAtom.user(home), ADDRESS_BOOK_CLAUSE],
  });
  const bob = await entry("contact-bob", "tel:+15550111");
  const unattested = await entry("contact-unattested", "tel:+15550199", {
    writer: PATTERN,
  });

  // The pattern's own document: a field naming the chosen contact by link,
  // and a field the committed record's link goes to.
  const compose = runtime.edit();
  const composer = runtime.getCell(home, "composer", {
    type: "object",
    properties: {
      recipient: { asCell: ["readonly"] },
      outbox: {},
    },
  } as never, compose);
  composer.set({ recipient: alice, outbox: null } as never);
  expect((await compose.commit()).error).toBeUndefined();
  await storage.synced();

  const fixture = {
    storage,
    runtime,
    runtimeFor,
    descriptor: descriptorCell.withTx(undefined),
    alice,
    bob,
    unattested,
    entry,
    notes: notes.withTx(undefined),
    composer: composer.withTx(undefined),
    recipient: composer.withTx(undefined).key("recipient") as Cell<unknown>,
    result: composer.withTx(undefined).key("outbox") as Cell<unknown>,
    bindings(
      overrides: Partial<ReviewedIntentBindings> = {},
    ): ReviewedIntentBindings {
      return {
        descriptor: fixture.descriptor,
        parameters: { to: [fixture.recipient] },
        result: fixture.result,
        ...overrides,
      };
    },
    /** Rewrites the descriptor as the consumer. */
    async republish(value: unknown) {
      const tx = runtime.edit();
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: CONSUMER_WRITER,
      });
      fixture.descriptor.withTx(tx).set(value as never);
      expect((await tx.commit()).error).toBeUndefined();
    },
    async dispose() {
      await storage.synced();
      for (const runtime of created) await runtime.dispose();
      await storage.close();
    },
  };
  return fixture;
};

describe("reviewed-intent", () => {
  describe("commitReviewedIntent()", () => {
    it("writes a record whose fields equal the preview and the entered text", async () => {
      const fixture = await setup();
      try {
        const prepared = await prepareReviewedIntent(fixture.bindings());
        expect(prepared.actor).toBe(sender.did());
        expect(prepared.operation).toBe("send-message");
        expect(prepared.endpointName).toBe("Example Messenger");
        expect(prepared.consumer).toBe("example-messenger");
        expect(prepared.endpoint).toBe(hashStringOf(DESCRIPTOR as never));
        expect(prepared.parameters).toEqual({
          to: {
            kind: "destinations",
            destinations: [{
              address: "tel:+15550100",
              integrity: [WRITTEN_BY_ADDRESS_BOOK],
              source: {
                space: sender.did(),
                id: fixture.alice.getAsNormalizedFullLink().id,
                scope: "space",
                path: [],
              },
            }],
          },
          body: { kind: "text", maxLength: 40 },
        });
        expect(prepared.windowMs).toBe(60_000);
        expect(prepared.maxAttempts).toBe(1);

        const before = Date.now();
        const committed = await commitReviewedIntent(
          prepared.consent,
          trustedClick(),
          text("See you at noon"),
        );
        const record = verified(committed.record);
        const parameters = {
          to: shown(prepared),
          body: "See you at noon",
        };
        expect(record).toEqual({
          operation: prepared.operation,
          endpoint: prepared.endpoint,
          consumer: prepared.consumer,
          subject: sender.did(),
          parameters,
          payloadDigest: hashStringOf(parameters as never),
          idempotencyKey: record.idempotencyKey,
          at: record.at,
          exp: record.at + 60_000,
          maxAttempts: 1,
          evidence: { component: "cf-reviewed-intent" },
        });
        expect(record.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
        expect(record.at).toBeGreaterThanOrEqual(before);
        expect(committed.record.getAsNormalizedFullLink().space).toBe(
          sender.did(),
        );
      } finally {
        await fixture.dispose();
      }
    });

    it("links the record from the pattern's result cell", async () => {
      const fixture = await setup();
      try {
        const prepared = await prepareReviewedIntent(fixture.bindings());
        const committed = await commitReviewedIntent(
          prepared.consent,
          trustedClick(),
          text("On my way"),
        );
        const linked = fixture.result.resolveAsCell().getAsNormalizedFullLink();
        const record = committed.record.getAsNormalizedFullLink();
        expect([linked.space, linked.id, linked.path]).toEqual([
          record.space,
          record.id,
          [],
        ]);
        expect(verified(fixture.result).parameters.body)
          .toBe("On my way");
      } finally {
        await fixture.dispose();
      }
    });

    it("writes an actor-private receipt naming the record", async () => {
      const fixture = await setup();
      try {
        const prepared = await prepareReviewedIntent(fixture.bindings());
        const committed = await commitReviewedIntent(
          prepared.consent,
          trustedClick(),
          text("On my way"),
        );
        const record = verified(committed.record);
        expect(committed.receipt.getAsNormalizedFullLink().space).toBe(
          sender.did(),
        );
        expect(committed.receipt.get()).toEqual({
          record: committed.record.getAsNormalizedFullLink().id,
          payloadDigest: record.payloadDigest,
          at: record.at,
        });
        await fixture.storage.synced();
        const outsider = fixture.runtimeFor(other, [
          cfcAtom.user(other.did()),
          ADDRESS_BOOK_CLAUSE,
        ]);
        for (const written of [committed.receipt, committed.record]) {
          expect(() =>
            outsider.getCellFromLink(written.getAsNormalizedFullLink()).get()
          ).toThrow(/read ceiling/);
        }
      } finally {
        await fixture.dispose();
      }
    });

    it("joins the label of every destination into the record and the receipt", async () => {
      const fixture = await setup();
      try {
        const prepared = await prepareReviewedIntent(fixture.bindings());
        const committed = await commitReviewedIntent(
          prepared.consent,
          trustedClick(),
          text("On my way"),
        );
        await fixture.storage.synced();
        // The sender's own clause alone does not admit either: both carry the
        // address book's clause the destination did.
        const ownerOnly = fixture.runtimeFor(sender, [
          cfcAtom.user(sender.did()),
        ]);
        for (const written of [committed.receipt, committed.record]) {
          expect(
            fixture.runtime.getCellFromLink(written.getAsNormalizedFullLink())
              .get(),
          ).toBeDefined();
          expect(() =>
            ownerOnly.getCellFromLink(written.getAsNormalizedFullLink()).get()
          ).toThrow(/read ceiling/);
        }
      } finally {
        await fixture.dispose();
      }
    });

    it("sets `exp` by the descriptor's `windowMs` when it is under ten minutes, and by ten minutes otherwise", async () => {
      for (
        const [windowMs, expected] of [
          [60_000, 60_000],
          [10 * 60_000, 10 * 60_000],
          [60 * 60_000, 10 * 60_000],
        ]
      ) {
        const fixture = await setup({ ...DESCRIPTOR, windowMs });
        try {
          const prepared = await prepareReviewedIntent(fixture.bindings());
          expect(prepared.windowMs).toBe(expected);
          const committed = await commitReviewedIntent(
            prepared.consent,
            trustedClick(),
            text("Running late"),
          );
          const record = verified(committed.record, {
            ...DESCRIPTOR,
            windowMs,
          });
          expect(record.exp - record.at).toBe(expected);
        } finally {
          await fixture.dispose();
        }
      }
    });

    it("gives each consent its own record and idempotency key", async () => {
      const fixture = await setup();
      try {
        const records = [];
        for (const body of ["One", "Two"]) {
          const prepared = await prepareReviewedIntent(fixture.bindings());
          const committed = await commitReviewedIntent(
            prepared.consent,
            trustedClick(),
            text(body),
          );
          records.push({
            id: committed.record.getAsNormalizedFullLink().id,
            ...verified(committed.record),
          });
        }
        expect(records[0].id).not.toBe(records[1].id);
        expect(records[0].idempotencyKey).not.toBe(records[1].idempotencyKey);
      } finally {
        await fixture.dispose();
      }
    });

    it("keeps the record immutable to ordinary writes", async () => {
      const fixture = await setup();
      try {
        const prepared = await prepareReviewedIntent(fixture.bindings());
        const committed = await commitReviewedIntent(
          prepared.consent,
          trustedClick(),
          text("On my way"),
        );
        // Written through a cell with no schema, so that what refuses it is
        // the claim the record stores, not one this write declares.
        const tx = fixture.runtime.edit();
        setCfcImplementationIdentity(tx, PATTERN);
        schemaless(fixture.runtime, committed.record).withTx(tx).set(
          { operation: "send-message" } as never,
        );
        expect((await tx.commit()).error?.message).toContain(
          "writeAuthorizedBy",
        );
        expect(verified(committed.record).parameters.body)
          .toBe("On my way");
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses to prepare on a runtime that would write the record without the stamp", async () => {
      const fixture = await setup();
      const modes: {
        cfcEnforcementMode: CfcEnforcementMode;
        cfcFlowLabels: CfcFlowLabelsMode;
      }[] = [
        { cfcEnforcementMode: "enforce-strict", cfcFlowLabels: "off" },
        { cfcEnforcementMode: "enforce-strict", cfcFlowLabels: "observe" },
        { cfcEnforcementMode: "disabled", cfcFlowLabels: "persist" },
      ];
      const unstamped = modes.map((dials) =>
        new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager: fixture.storage,
          trustSnapshotProvider: () => ({
            id: sender.did(),
            actingPrincipal: sender.did(),
          }),
          cfcReadMaxConfidentiality: [
            cfcAtom.user(sender.did()),
            ADDRESS_BOOK_CLAUSE,
          ],
          ...dials,
        })
      );
      try {
        for (const runtime of unstamped) {
          const local = (cell: Cell<unknown>) =>
            runtime.getCellFromLink(cell.getAsNormalizedFullLink());
          await expect(prepareReviewedIntent({
            descriptor: local(fixture.descriptor),
            parameters: { to: [local(fixture.recipient)] },
            result: local(fixture.result),
          })).rejects.toThrow(/persists flow labels/);
        }
      } finally {
        for (const runtime of unstamped) await runtime.dispose();
        await fixture.dispose();
      }
    });

    it("leaves the result cell alone when the record's transaction writes it without the stamp", async () => {
      const fixture = await setup();
      const runtime = fixture.runtime;
      const edit = runtime.edit.bind(runtime);
      try {
        const prepared = await prepareReviewedIntent(fixture.bindings());
        // The runtime stops persisting flow labels once the receipt commits,
        // so the record's transaction persists none.
        runtime.edit = (...args: Parameters<typeof runtime.edit>) => {
          const tx = edit(...args);
          const commit = tx.commit.bind(tx);
          tx.commit = async () => {
            const landed = await commit();
            runtime.edit = edit;
            Object.defineProperty(runtime, "cfcFlowLabels", { value: "off" });
            return landed;
          };
          return tx;
        };
        await expect(
          commitReviewedIntent(prepared.consent, trustedClick(), text("Hi")),
        ).rejects.toThrow(/not written by the reviewed-intent builtin/);
        runtime.edit = edit;
        expect(fixture.result.get()).toBeNull();
      } finally {
        runtime.edit = edit;
        await fixture.dispose();
      }
    });

    it("refuses a value for a parameter the descriptor does not declare as entered, missing text, and text over its `maxLength`", async () => {
      const fixture = await setup();
      try {
        for (
          const [input, refusal] of [
            [{ body: "Hi", subject: "Hello" }, /does not declare/],
            [{ body: "Hi", to: "tel:+15550199" }, /does not declare/],
            [{}, /requires text for/],
            [{ body: 42 }, /requires text for/],
            [{ body: "x".repeat(41) }, /over 40 characters/],
            [undefined, /requires the entered values/],
          ] as const
        ) {
          const prepared = await prepareReviewedIntent(fixture.bindings());
          await expect(
            commitReviewedIntent(
              prepared.consent,
              trustedClick(),
              input as never,
            ),
          ).rejects.toThrow(refusal);
        }
        // A character outside the Basic Multilingual Plane counts once.
        const prepared = await prepareReviewedIntent(fixture.bindings());
        const committed = await commitReviewedIntent(
          prepared.consent,
          trustedClick(),
          text("🙂".repeat(40)),
        );
        expect(verified(committed.record).parameters.body)
          .toBe("🙂".repeat(40));
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses forged, foreign, and spent consent", async () => {
      const fixture = await setup();
      try {
        await expect(
          commitReviewedIntent(
            {} as ReviewedIntentConsent,
            trustedClick(),
            text("Hi"),
          ),
        ).rejects.toThrow(/unknown or already consumed/);
        // Another host operation's consent is not this one's.
        const share = prepareSnapshotShare(fixture.bob, {
          space: fixture.composer,
        });
        await expect(
          commitReviewedIntent(
            share.consent as never,
            trustedClick(),
            text("Hi"),
          ),
        ).rejects.toThrow(/unknown or already consumed/);
        // A consent is spent by a commit that succeeds and by one refused.
        const committed = await prepareReviewedIntent(fixture.bindings());
        await commitReviewedIntent(
          committed.consent,
          trustedClick(),
          text("Hi"),
        );
        const refused = await prepareReviewedIntent(fixture.bindings());
        await expect(
          commitReviewedIntent(refused.consent, undefined, text("Hi")),
        ).rejects.toThrow(/trusted host gesture/);
        for (const spent of [committed, refused]) {
          await expect(
            commitReviewedIntent(spent.consent, trustedClick(), text("Hi")),
          ).rejects.toThrow(/already consumed/);
        }
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a gesture the renderer did not mark, another surface's gesture, and no gesture", async () => {
      const fixture = await setup();
      try {
        for (
          const event of [
            {
              type: "click",
              provenance: {
                origin: "dom",
                trusted: true,
                ui: { pattern: "ReviewedIntent" },
              },
            },
            trustedClick("ShareSnapshot"),
            undefined,
          ]
        ) {
          const prepared = await prepareReviewedIntent(fixture.bindings());
          await expect(
            commitReviewedIntent(prepared.consent, event, text("Hi")),
          ).rejects.toThrow(/trusted host gesture/);
        }
        expect(fixture.result.get()).toBeNull();
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a destination whose value changed after review", async () => {
      const fixture = await setup();
      try {
        const prepared = await prepareReviewedIntent(fixture.bindings());
        await changeAlice(fixture, "tel:+15550122");
        await expect(
          commitReviewedIntent(prepared.consent, trustedClick(), text("Hi")),
        ).rejects.toThrow(/review is stale/);
        expect(fixture.result.get()).toBeNull();
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a destination the pattern rebound after review", async () => {
      const fixture = await setup();
      try {
        const prepared = await prepareReviewedIntent(fixture.bindings());
        const tx = fixture.runtime.edit();
        fixture.recipient.withTx(tx).set(fixture.bob as never);
        expect((await tx.commit()).error).toBeUndefined();
        await expect(
          commitReviewedIntent(prepared.consent, trustedClick(), text("Hi")),
        ).rejects.toThrow(/review is stale/);
        expect(fixture.result.get()).toBeNull();
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a descriptor changed after review", async () => {
      const fixture = await setup();
      try {
        const prepared = await prepareReviewedIntent(fixture.bindings());
        await fixture.republish({ ...DESCRIPTOR, endpointName: "Elsewhere" });
        await expect(
          commitReviewedIntent(prepared.consent, trustedClick(), text("Hi")),
        ).rejects.toThrow(/review is stale/);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a result cell the pattern pointed elsewhere after review", async () => {
      const fixture = await setup();
      try {
        // The pattern's result field is an alias for another of its cells.
        const tx = fixture.runtime.edit();
        const first = fixture.runtime.getCell(sender.did(), "first-outbox", {
          type: "object",
        }, tx);
        first.set({ slot: null });
        const second = fixture.runtime.getCell(sender.did(), "second-outbox", {
          type: "object",
        }, tx);
        second.set({ slot: null });
        const alias = fixture.runtime.getCell(sender.did(), "outbox-alias", {
          type: "object",
        }, tx);
        alias.set(
          { slot: first.key("slot").getAsWriteRedirectLink() } as never,
        );
        expect((await tx.commit()).error).toBeUndefined();
        const result = alias.withTx(undefined).key("slot") as Cell<unknown>;
        const prepared = await prepareReviewedIntent(
          fixture.bindings({ result }),
        );
        const retarget = fixture.runtime.edit();
        alias.withTx(retarget).key("slot").setRaw(
          second.key("slot").getAsWriteRedirectLink() as never,
        );
        expect((await retarget.commit()).error).toBeUndefined();
        await expect(
          commitReviewedIntent(prepared.consent, trustedClick(), text("Hi")),
        ).rejects.toThrow(/review is stale/);
        expect(first.withTx(undefined).key("slot").get()).toBeNull();
        expect(second.withTx(undefined).key("slot").get()).toBeNull();
      } finally {
        await fixture.dispose();
      }
    });

    it("leaves the record unlinked when the pattern points its result cell elsewhere after the record lands", async () => {
      const fixture = await setup();
      const runtime = fixture.runtime;
      const edit = runtime.edit.bind(runtime);
      try {
        const tx = runtime.edit();
        const first = runtime.getCell(sender.did(), "first-outbox", {
          type: "object",
        }, tx);
        first.set({ slot: null });
        const second = runtime.getCell(sender.did(), "second-outbox", {
          type: "object",
        }, tx);
        second.set({ slot: null });
        const alias = runtime.getCell(sender.did(), "outbox-alias", {
          type: "object",
        }, tx);
        alias.set(
          { slot: first.key("slot").getAsWriteRedirectLink() } as never,
        );
        expect((await tx.commit()).error).toBeUndefined();
        const result = alias.withTx(undefined).key("slot") as Cell<unknown>;
        const prepared = await prepareReviewedIntent(
          fixture.bindings({ result }),
        );
        // The second transaction that commits is the record's; once it has
        // landed, the pattern points the result cell at its other outbox.
        let commits = 0;
        runtime.edit = (...args: Parameters<typeof runtime.edit>) => {
          const opened = edit(...args);
          const commit = opened.commit.bind(opened);
          opened.commit = async () => {
            const landed = await commit();
            if (++commits === 2) {
              runtime.edit = edit;
              const retarget = edit();
              alias.withTx(retarget).key("slot").setRaw(
                second.key("slot").getAsWriteRedirectLink() as never,
              );
              expect((await retarget.commit()).error).toBeUndefined();
            }
            return landed;
          };
          return opened;
        };
        await expect(
          commitReviewedIntent(prepared.consent, trustedClick(), text("Hi")),
        ).rejects.toThrow(/review is stale/);
        expect(first.withTx(undefined).key("slot").get()).toBeNull();
        expect(second.withTx(undefined).key("slot").get()).toBeNull();
      } finally {
        runtime.edit = edit;
        await fixture.dispose();
      }
    });

    it("refuses a destination changed between its re-read and the record's transaction", async () => {
      const fixture = await setup();
      const runtime = fixture.runtime;
      const edit = runtime.edit.bind(runtime);
      try {
        const prepared = await prepareReviewedIntent(fixture.bindings());
        // The re-read's transactions are only read; the first that commits
        // is the receipt's, and the destination changes as it does.
        runtime.edit = (...args: Parameters<typeof runtime.edit>) => {
          const tx = edit(...args);
          const commit = tx.commit.bind(tx);
          tx.commit = async () => {
            runtime.edit = edit;
            await changeAlice(fixture, "tel:+15550133");
            return await commit();
          };
          return tx;
        };
        await expect(
          commitReviewedIntent(prepared.consent, trustedClick(), text("Hi")),
        ).rejects.toThrow(/changed before commit/);
        expect(fixture.result.get()).toBeNull();
      } finally {
        runtime.edit = edit;
        await fixture.dispose();
      }
    });

    it("refuses a destination changed after the record's transaction read it", async () => {
      const fixture = await setup();
      const runtime = fixture.runtime;
      const edit = runtime.edit.bind(runtime);
      try {
        const prepared = await prepareReviewedIntent(fixture.bindings());
        // The second transaction that commits is the record's; the
        // destination changes after its verifier reads, before it lands.
        let commits = 0;
        runtime.edit = (...args: Parameters<typeof runtime.edit>) => {
          const tx = edit(...args);
          const commit = tx.commit.bind(tx);
          tx.commit = async () => {
            if (++commits === 2) {
              runtime.edit = edit;
              await changeAlice(fixture, "tel:+15550133");
            }
            return await commit();
          };
          return tx;
        };
        await expect(
          commitReviewedIntent(prepared.consent, trustedClick(), text("Hi")),
        ).rejects.toThrow(/Reviewed intent failed/);
        expect(fixture.result.get()).toBeNull();
      } finally {
        runtime.edit = edit;
        await fixture.dispose();
      }
    });

    it("refuses an actor changed after review", async () => {
      const fixture = await setup();
      let acting = sender;
      const runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager: fixture.storage,
        trustSnapshotProvider: () => ({
          id: acting.did(),
          actingPrincipal: acting.did(),
        }),
        cfcReadMaxConfidentiality: [
          cfcAtom.user(sender.did()),
          ADDRESS_BOOK_CLAUSE,
        ],
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      });
      const edit = runtime.edit.bind(runtime);
      try {
        const local = (cell: Cell<unknown>) =>
          runtime.getCellFromLink(cell.getAsNormalizedFullLink());
        const prepared = await prepareReviewedIntent({
          descriptor: local(fixture.descriptor),
          parameters: { to: [local(fixture.recipient)] },
          result: local(fixture.result),
        });
        // The re-read is the sender's; the actor changes as the receipt is
        // committed, so the record's transaction is another actor's.
        runtime.edit = (...args: Parameters<typeof runtime.edit>) => {
          const tx = edit(...args);
          const commit = tx.commit.bind(tx);
          tx.commit = () => {
            runtime.edit = edit;
            acting = other;
            return commit();
          };
          return tx;
        };
        await expect(
          commitReviewedIntent(prepared.consent, trustedClick(), text("Hi")),
        ).rejects.toThrow(/actor changed after review/);
      } finally {
        runtime.edit = edit;
        await runtime.dispose();
        await fixture.dispose();
      }
    });
  });

  describe("prepareReviewedIntent()", () => {
    it("shows a destination by its attested value, reached through the pattern's link to it", async () => {
      const fixture = await setup();
      try {
        const prepared = await prepareReviewedIntent(
          fixture.bindings({ parameters: { to: [fixture.bob] } }),
        );
        expect(shown(prepared)).toEqual([{
          address: "tel:+15550111",
          integrity: [WRITTEN_BY_ADDRESS_BOOK],
          source: {
            space: sender.did(),
            id: fixture.bob.getAsNormalizedFullLink().id,
            scope: "space",
            path: [],
          },
        }]);
        const linked = await prepareReviewedIntent(fixture.bindings());
        expect(shown(linked)[0].address).toBe("tel:+15550100");
      } finally {
        await fixture.dispose();
      }
    });

    it("keeps only the atoms that satisfied the destination's patterns", async () => {
      const IMPORTED_BY = {
        type: CFC_ATOM_TYPE.TransformedBy,
        identity: { kind: "builtin", builtinId: "contact-import" },
      };
      const WITNESSED = {
        ...WRITTEN_BY_ADDRESS_BOOK,
        inputWitness: IMPORTED_BY,
      };
      const withIntegrity = (integrity: unknown[]) => ({
        ...DESCRIPTOR,
        parameters: {
          ...DESCRIPTOR.parameters,
          to: { ...DESCRIPTOR.parameters.to, integrity },
        },
      });
      const fixture = await setup();
      try {
        // The address book writes an entry from an imported one alone, so the
        // entry carries its writer's stamp twice: bare, and witnessing the
        // import.
        const runtime = fixture.runtime;
        const imported = runtime.edit();
        setCfcImplementationIdentity(imported, {
          kind: "builtin",
          builtinId: "contact-import",
        });
        fixture.notes.withTx(imported).get();
        const source = runtime.getCell(sender.did(), "imported-carol", {
          ifc: { confidentiality: [cfcAtom.user(sender.did())] },
        } as never, imported);
        source.set("tel:+15550155" as never);
        expect((await imported.commit()).error).toBeUndefined();
        const written = runtime.edit();
        setCfcImplementationIdentity(written, ADDRESS_BOOK_WRITER);
        source.withTx(written).get();
        const carol = runtime.getCell(sender.did(), "contact-carol", {
          ifc: {
            confidentiality: [cfcAtom.user(sender.did())],
            writeAuthorizedBy: [ADDRESS_BOOK],
          },
        } as never, written);
        carol.set("tel:+15550155" as never);
        expect((await written.commit()).error).toBeUndefined();
        const to = { parameters: { to: [carol.withTx(undefined)] } };

        const bare = await prepareReviewedIntent(fixture.bindings(to));
        expect(shown(bare)[0].integrity).toEqual([WRITTEN_BY_ADDRESS_BOOK]);

        await fixture.republish(withIntegrity([WITNESSED]));
        const witnessed = await prepareReviewedIntent(fixture.bindings(to));
        expect(shown(witnessed)[0].integrity).toEqual([WITNESSED]);
        const committed = await commitReviewedIntent(
          witnessed.consent,
          trustedClick(),
          text("Hi"),
        );
        expect(
          verified(committed.record, withIntegrity([WITNESSED])).parameters.to,
        ).toEqual(shown(witnessed));

        // A variable shared across patterns binds once: the writer and the
        // writer it witnesses must be the same, and here they are not.
        const writer = { kind: "builtin", builtinId: { var: "$writer" } };
        await fixture.republish(withIntegrity([
          { type: CFC_ATOM_TYPE.TransformedBy, identity: writer },
          {
            type: CFC_ATOM_TYPE.TransformedBy,
            inputWitness: {
              type: CFC_ATOM_TYPE.TransformedBy,
              identity: writer,
            },
          },
        ]));
        await expect(prepareReviewedIntent(fixture.bindings(to))).rejects
          .toThrow(/without the integrity its descriptor requires/);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a destination without the integrity its descriptor requires", async () => {
      const fixture = await setup();
      try {
        await expect(prepareReviewedIntent(
          fixture.bindings({ parameters: { to: [fixture.unattested] } }),
        )).rejects.toThrow(/without the integrity its descriptor requires/);
        // A pattern's own document whose schema declares the very atom the
        // descriptor requires does not carry it.
        const lookalike = await fixture.entry(
          "pattern-contact",
          "tel:+15550199",
          { writer: PATTERN, addIntegrity: [WRITTEN_BY_ADDRESS_BOOK] },
        );
        await expect(prepareReviewedIntent(
          fixture.bindings({ parameters: { to: [lookalike] } }),
        )).rejects.toThrow(/without the integrity its descriptor requires/);
      } finally {
        await fixture.dispose();
      }
    });

    it("counts only the integrity the runtime derived from who wrote the value, which another writer takes away", async () => {
      const fixture = await setup();
      try {
        const runtime = fixture.runtime;
        // The address book declares its own stamp on a whole book it writes
        // without reading anything, so the stamp is declared, not derived: a
        // statement in its schema, not a record of who wrote the value.
        const declare = runtime.edit();
        setCfcImplementationIdentity(declare, ADDRESS_BOOK_WRITER);
        const declared = runtime.getCell(sender.did(), "declared-book", {
          type: "object",
          ifc: {
            confidentiality: [cfcAtom.user(sender.did())],
            addIntegrity: [WRITTEN_BY_ADDRESS_BOOK],
          },
        } as never, declare);
        declared.set({ alice: "tel:+15550100" } as never);
        expect((await declare.commit()).error).toBeUndefined();
        // The address book writes another whole book after a labeled read, so
        // the book's root carries the stamp the runtime derives, which covers
        // each entry.
        const stamped = await fixture.entry("stamped-book", {
          alice: "tel:+15550100",
        }, { claimed: false });
        const entryIn = (book: Cell<unknown>, key: string) => ({
          parameters: { to: [book.key(key) as Cell<unknown>] },
        });
        const books = [declared.withTx(undefined), stamped];
        await expect(
          prepareReviewedIntent(fixture.bindings(entryIn(books[0], "alice"))),
        ).rejects.toThrow(/without the integrity its descriptor requires/);
        expect(
          shown(
            await prepareReviewedIntent(
              fixture.bindings(entryIn(books[1], "alice")),
            ),
          )[0].address,
        ).toBe("tel:+15550100");

        // A pattern adds an entry of its own to each book, through a cell
        // with no schema of its own; the stamped book's root stamp no longer
        // names one writer, so it covers neither entry.
        for (const book of books) {
          const added = runtime.edit();
          setCfcImplementationIdentity(added, PATTERN);
          fixture.bob.withTx(added).get();
          schemaless(runtime, book).withTx(added).key("mallory" as never).set(
            "tel:+15550666" as never,
          );
          expect((await added.commit()).error).toBeUndefined();
        }
        // In a book a pattern made, the address book's stamp on one entry it
        // wrote does not cover the pattern's entry beside it.
        const shared = await fixture.entry("pattern-book", {}, {
          writer: PATTERN,
        });
        const written = runtime.edit();
        setCfcImplementationIdentity(written, ADDRESS_BOOK_WRITER);
        fixture.notes.withTx(written).get();
        schemaless(runtime, shared).withTx(written).key("alice" as never).set(
          "tel:+15550100" as never,
        );
        expect((await written.commit()).error).toBeUndefined();
        const own = runtime.edit();
        setCfcImplementationIdentity(own, PATTERN);
        fixture.bob.withTx(own).get();
        schemaless(runtime, shared).withTx(own).key("mallory" as never).set(
          "tel:+15550666" as never,
        );
        expect((await own.commit()).error).toBeUndefined();
        expect(
          shown(
            await prepareReviewedIntent(
              fixture.bindings(entryIn(shared, "alice")),
            ),
          )[0].address,
        ).toBe("tel:+15550100");
        for (
          const [book, key] of [
            [books[0], "mallory"],
            [books[1], "mallory"],
            [books[1], "alice"],
            [shared, "mallory"],
          ] as const
        ) {
          await expect(
            prepareReviewedIntent(fixture.bindings(entryIn(book, key))),
          ).rejects.toThrow(/without the integrity its descriptor requires/);
        }
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a descriptor whose destination integrity a pattern could author, so a pattern's own document carrying it never passes", async () => {
      const authored = {
        ...DESCRIPTOR,
        parameters: {
          ...DESCRIPTOR.parameters,
          to: { ...DESCRIPTOR.parameters.to, integrity: ["verified-address"] },
        },
      };
      const fixture = await setup(authored);
      try {
        const lookalike = await fixture.entry(
          "pattern-verified",
          "tel:+15550199",
          { writer: PATTERN, addIntegrity: ["verified-address"] },
        );
        await expect(prepareReviewedIntent(
          fixture.bindings({ parameters: { to: [lookalike] } }),
        )).rejects.toThrow(/a pattern could author/);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a destination that holds a cell reference rather than a value", async () => {
      const fixture = await setup();
      try {
        await expect(prepareReviewedIntent(
          fixture.bindings({ parameters: { to: [fixture.composer] } }),
        )).rejects.toThrow(/destination to be JSON without cell references/);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a destination over the host's read ceiling, and over the actor's own without one", async () => {
      const fixture = await setup();
      try {
        // Another principal's address book entry, which the address book
        // wrote after reading that principal's own notes.
        const author = fixture.runtimeFor(other);
        const private_ = {
          ifc: { confidentiality: [cfcAtom.user(other.did())] },
        };
        const noted = author.edit();
        const notes = author.getCell(
          sender.did(),
          "other-notes",
          private_ as never,
          noted,
        );
        notes.set({ updated: 1 } as never);
        expect((await noted.commit()).error).toBeUndefined();
        const tx = author.edit();
        setCfcImplementationIdentity(tx, ADDRESS_BOOK_WRITER);
        notes.withTx(tx).get();
        const foreign = author.getCell(sender.did(), "foreign-contact", {
          ifc: {
            confidentiality: [cfcAtom.user(other.did())],
            writeAuthorizedBy: [ADDRESS_BOOK],
          },
        } as never, tx);
        foreign.set("tel:+15550144" as never);
        expect((await tx.commit()).error).toBeUndefined();
        await fixture.storage.synced();
        const link = foreign.getAsNormalizedFullLink();
        await expect(prepareReviewedIntent(
          fixture.bindings({
            parameters: { to: [fixture.runtime.getCellFromLink(link)] },
          }),
        )).rejects.toThrow(/read ceiling/);
        const unbounded = fixture.runtimeFor(sender, null);
        const bindings = fixture.bindings();
        await expect(prepareReviewedIntent({
          descriptor: unbounded.getCellFromLink(
            bindings.descriptor.getAsNormalizedFullLink(),
          ),
          parameters: { to: [unbounded.getCellFromLink(link)] },
          result: unbounded.getCellFromLink(
            bindings.result.getAsNormalizedFullLink(),
          ),
        })).rejects.toThrow(/authenticated actor's read ceiling/);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a destination for a parameter the descriptor does not declare", async () => {
      const fixture = await setup();
      try {
        for (const key of ["cc", "body"]) {
          await expect(prepareReviewedIntent(
            fixture.bindings({
              parameters: { to: [fixture.recipient], [key]: [fixture.bob] },
            }),
          )).rejects.toThrow(/does not declare/);
        }
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a number of destinations the descriptor does not allow", async () => {
      const fixture = await setup();
      try {
        for (const to of [[], [fixture.recipient, fixture.bob]]) {
          await expect(prepareReviewedIntent(
            fixture.bindings({ parameters: { to } }),
          )).rejects.toThrow(/between 1 and 1 destinations/);
        }
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a result cell inside a reviewed intent", async () => {
      const fixture = await setup();
      try {
        const prepared = await prepareReviewedIntent(fixture.bindings());
        const committed = await commitReviewedIntent(
          prepared.consent,
          trustedClick(),
          text("Hi"),
        );
        for (
          const result of [
            committed.record,
            committed.record.key("parameters").key("body"),
          ]
        ) {
          await expect(prepareReviewedIntent(
            fixture.bindings({ result: result as Cell<unknown> }),
          )).rejects.toThrow(/result cell inside a reviewed intent/);
        }
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a result cell whose writer claim would refuse the record's link", async () => {
      const fixture = await setup();
      try {
        const tx = fixture.runtime.edit();
        setCfcImplementationIdentity(tx, PATTERN);
        const outbox = fixture.runtime.getCell(sender.did(), "claimed-outbox", {
          type: "object",
          properties: {
            slot: { ifc: { writeAuthorizedBy: ["composer-handler"] } },
          },
        } as never, tx);
        outbox.set({} as never);
        expect((await tx.commit()).error).toBeUndefined();
        await expect(prepareReviewedIntent(
          fixture.bindings({
            result: outbox.withTx(undefined).key("slot") as Cell<unknown>,
          }),
        )).rejects.toThrow(/result cell that refuses the record's link/);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses an unauthenticated actor and handles from another runtime", async () => {
      const fixture = await setup();
      const anonymous = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager: fixture.storage,
        trustSnapshotProvider: () => ({
          id: "anonymous",
          actingPrincipal: "anonymous",
        }),
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      });
      try {
        const bindings = fixture.bindings();
        await expect(prepareReviewedIntent({
          descriptor: anonymous.getCellFromLink(
            bindings.descriptor.getAsNormalizedFullLink(),
          ),
          parameters: {
            to: [
              anonymous.getCellFromLink(fixture.bob.getAsNormalizedFullLink()),
            ],
          },
          result: anonymous.getCellFromLink(
            bindings.result.getAsNormalizedFullLink(),
          ),
        })).rejects.toThrow(/requires an authenticated actor/);
        await expect(prepareReviewedIntent(fixture.bindings({
          result: anonymous.getCellFromLink(
            bindings.result.getAsNormalizedFullLink(),
          ),
        }))).rejects.toThrow(/same runtime/);
      } finally {
        await anonymous.dispose();
        await fixture.dispose();
      }
    });
  });

  describe("parseReviewedIntentDescriptor()", () => {
    it("returns a descriptor whose digest is the record's `endpoint`", () => {
      const parsed = parseReviewedIntentDescriptor(DESCRIPTOR);
      expect(parsed).toEqual(DESCRIPTOR);
      expect(reviewedIntentEndpoint(parsed)).toBe(
        hashStringOf(DESCRIPTOR as never),
      );
    });

    it("refuses a parameter kind, a parameter member, or a descriptor member it does not know", () => {
      for (
        const descriptor of [
          {
            ...DESCRIPTOR,
            parameters: { ...DESCRIPTOR.parameters, photo: { kind: "image" } },
          },
          {
            ...DESCRIPTOR,
            parameters: {
              ...DESCRIPTOR.parameters,
              body: { kind: "text", maxLength: 40, pattern: "^[a-z]*$" },
            },
          },
          { ...DESCRIPTOR, requireBiometric: true },
          { ...DESCRIPTOR, destinationIntegrity: [WRITTEN_BY_ADDRESS_BOOK] },
        ]
      ) {
        expect(() => parseReviewedIntentDescriptor(descriptor)).toThrow(
          /cannot show|must hold exactly/,
        );
      }
    });

    it("refuses a destination integrity pattern whose atom type a pattern could author", () => {
      for (
        const pattern of [
          "verified-address",
          { type: "verified-address" },
          { type: { var: "$type" } },
          { kind: "represents-principal", subject: { var: "$who" } },
          {},
        ]
      ) {
        expect(() =>
          parseReviewedIntentDescriptor({
            ...DESCRIPTOR,
            parameters: {
              to: {
                ...DESCRIPTOR.parameters.to,
                integrity: [WRITTEN_BY_ADDRESS_BOOK, pattern],
              },
            },
          })
        ).toThrow(/a pattern could author/);
      }
    });

    it("refuses destinations declared without integrity, and malformed limits", () => {
      for (
        const descriptor of [
          {
            ...DESCRIPTOR,
            parameters: {
              to: { ...DESCRIPTOR.parameters.to, integrity: [] },
            },
          },
          {
            ...DESCRIPTOR,
            parameters: {
              to: { kind: "destinations", min: 1, max: 1 },
            },
          },
          {
            ...DESCRIPTOR,
            parameters: {
              to: { ...DESCRIPTOR.parameters.to, min: 2, max: 1 },
            },
          },
          { ...DESCRIPTOR, windowMs: 0 },
          { ...DESCRIPTOR, maxAttempts: 1.5 },
          { ...DESCRIPTOR, operation: "" },
        ]
      ) {
        expect(() => parseReviewedIntentDescriptor(descriptor)).toThrow(
          /Reviewed intent descriptor/,
        );
      }
    });
  });

  describe("verifyReviewedIntentRecord()", () => {
    /**
     * A record a pattern makes up, stored as a commit stores one, so that only
     * its stamp tells it apart.
     */
    const forged = (body: string) => {
      const parameters = {
        body,
        to: [{
          address: "tel:+15550199",
          integrity: [WRITTEN_BY_ADDRESS_BOOK],
          source: {
            space: sender.did(),
            id: "of:forged-contact",
            scope: "space",
            path: [],
          },
        }],
      };
      return {
        operation: "send-message",
        endpoint: hashStringOf(DESCRIPTOR as never),
        consumer: "example-messenger",
        subject: sender.did(),
        parameters: JSON.stringify(parameters),
        payloadDigest: hashStringOf(parameters as never),
        idempotencyKey: "a3c1d9e2-forged",
        at: 1_700_000_000_000,
        exp: 1_700_000_060_000,
        maxAttempts: 1,
        evidence: { component: "cf-reviewed-intent" },
      };
    };

    it("refuses a lookalike a pattern's own initialization declares written by the builtin", async () => {
      const fixture = await setup();
      try {
        const tx = fixture.runtime.edit();
        setCfcImplementationIdentity(tx, PATTERN);
        // A labeled read, so the pattern's writes carry its own stamp.
        fixture.bob.withTx(tx).get();
        const lookalike = fixture.runtime.getCell(
          sender.did(),
          "lookalike-record",
          {
            type: "object",
            default: forged("Send the code"),
            ifc: {
              confidentiality: [cfcAtom.user(sender.did())],
              writeAuthorizedBy: [REVIEWED_INTENT_WRITER],
            },
          } as never,
          tx,
        );
        fixture.result.withTx(tx).set(lookalike as never);
        expect((await tx.commit()).error).toBeUndefined();
        // The lookalike exists and stores the builtin as its only writer.
        expect(lookalike.withTx(undefined).getRaw()).toEqual(
          forged("Send the code") as never,
        );
        const overwrite = fixture.runtime.edit();
        setCfcImplementationIdentity(overwrite, PATTERN);
        lookalike.withTx(overwrite).set(forged("Other") as never);
        expect((await overwrite.commit()).error?.message).toContain(
          "writeAuthorizedBy",
        );
        for (const cell of [fixture.result, lookalike.withTx(undefined)]) {
          expect(() => verified(cell)).toThrow(
            /not written by the reviewed-intent builtin/,
          );
        }
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a copy a pattern makes of a genuine record", async () => {
      const fixture = await setup();
      try {
        const prepared = await prepareReviewedIntent(
          fixture.bindings({ parameters: { to: [fixture.bob] } }),
        );
        const committed = await commitReviewedIntent(
          prepared.consent,
          trustedClick(),
          text("Genuine"),
        );
        const tx = fixture.runtime.edit();
        setCfcImplementationIdentity(tx, PATTERN);
        const genuine = JSON.parse(
          JSON.stringify(committed.record.withTx(tx).get()),
        );
        const copy = fixture.runtime.getCell(sender.did(), "record-copy", {
          type: "object",
          ifc: { confidentiality: [cfcAtom.user(sender.did())] },
        }, tx);
        copy.set(genuine as never);
        expect((await tx.commit()).error).toBeUndefined();
        expect(copy.withTx(undefined).get()).toEqual(genuine as never);
        expect(() => verified(copy.withTx(undefined)))
          .toThrow(/not written by the reviewed-intent builtin/);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a lookalike whose schema declares the builtin's stamp itself", async () => {
      const fixture = await setup();
      try {
        const tx = fixture.runtime.edit();
        setCfcImplementationIdentity(tx, PATTERN);
        fixture.bob.withTx(tx).get();
        const lookalike = fixture.runtime.getCell(
          sender.did(),
          "stamped-lookalike",
          {
            type: "object",
            ifc: {
              confidentiality: [cfcAtom.user(sender.did())],
              addIntegrity: [WRITTEN_BY_REVIEWED_INTENT],
            },
          } as never,
          tx,
        );
        lookalike.set(forged("Send the code") as never);
        expect((await tx.commit()).error).toBeUndefined();
        expect(() => verified(lookalike.withTx(undefined)))
          .toThrow(/not written by the reviewed-intent builtin/);
      } finally {
        await fixture.dispose();
      }
    });

    /**
     * Stores `value` at `cause` in `space` with the stored label `entry`, as
     * only the runtime itself can.
     */
    const seeded = async (
      fixture: Awaited<ReturnType<typeof setup>>,
      space: string,
      cause: string,
      value: unknown,
      entry: Record<string, unknown>,
    ) => {
      const tx = fixture.runtime.edit();
      const cell = fixture.runtime.getCell(
        space as never,
        cause,
        undefined,
        tx,
      );
      writeSeedEnvelopeDoc(tx, space as never);
      seedStoredEnvelope(tx, {
        space: space as never,
        scope: "space",
        id: cell.getAsNormalizedFullLink().id,
        path: [],
      }, {
        value,
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: { version: 1, entries: [{ path: [], ...entry }] },
        },
      } as never);
      expect((await tx.commit()).error).toBeUndefined();
      return cell.withTx(undefined);
    };

    const stampedLabel = {
      confidentiality: [cfcAtom.user(sender.did())],
      integrity: [WRITTEN_BY_REVIEWED_INTENT],
    };

    it("refuses the builtin's stamp on a stored entry the runtime did not derive", async () => {
      const fixture = await setup();
      try {
        const declared = await seeded(
          fixture,
          sender.did(),
          "declared-stamp",
          forged("Send the code"),
          { label: stampedLabel, origin: "declared" },
        );
        expect(() => verified(declared)).toThrow(
          /not written by the reviewed-intent builtin/,
        );
        // The same entry as the runtime derives it verifies, which is what
        // makes the entry's origin the evidence.
        const derived = await seeded(
          fixture,
          sender.did(),
          "derived-stamp",
          forged("Send the code"),
          { label: stampedLabel, origin: "derived", observes: "value" },
        );
        expect(verified(derived).parameters.body).toBe(
          "Send the code",
        );
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a stamped record outside its subject's home space, whose digest does not match its parameters, or whose destination has no location", async () => {
      const fixture = await setup();
      try {
        const elsewhere = await seeded(
          fixture,
          other.did(),
          "stamped-elsewhere",
          forged("Send the code"),
          { label: stampedLabel, origin: "derived", observes: "value" },
        );
        expect(() => verified(elsewhere)).toThrow(
          /not in its subject's home space/,
        );
        const altered = await seeded(
          fixture,
          sender.did(),
          "stamped-altered",
          {
            ...forged("Send the code"),
            payloadDigest: forged("Something else").payloadDigest,
          },
          { label: stampedLabel, origin: "derived", observes: "value" },
        );
        expect(() => verified(altered)).toThrow(
          /does not match its parameters/,
        );
        // A destination whose location names no path to resolve it at again.
        const parameters = {
          body: "Send the code",
          to: [{
            address: "tel:+15550199",
            integrity: [WRITTEN_BY_ADDRESS_BOOK],
            source: { space: sender.did(), id: "of:forged-contact" },
          }],
        };
        const unplaced = await seeded(
          fixture,
          sender.did(),
          "stamped-unplaced",
          {
            ...forged("Send the code"),
            parameters: JSON.stringify(parameters),
            payloadDigest: hashStringOf(parameters as never),
          },
          { label: stampedLabel, origin: "derived", observes: "value" },
        );
        expect(() => verified(unplaced)).toThrow(
          /`parameters` are malformed/,
        );
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a location inside a genuine record", async () => {
      const fixture = await setup();
      try {
        const prepared = await prepareReviewedIntent(fixture.bindings());
        const committed = await commitReviewedIntent(
          prepared.consent,
          trustedClick(),
          text("Genuine"),
        );
        expect(() =>
          verified(
            committed.record.key("parameters") as Cell<unknown>,
          )
        ).toThrow(/document root/);
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a record checked against another descriptor, or one its descriptor would not have produced", async () => {
      const fixture = await setup();
      try {
        const prepared = await prepareReviewedIntent(fixture.bindings());
        const committed = await commitReviewedIntent(
          prepared.consent,
          trustedClick(),
          text("Genuine record"),
        );
        expect(() =>
          verified(committed.record, {
            ...DESCRIPTOR,
            endpointName: "Another endpoint",
          })
        ).toThrow(/not for this descriptor/);
        // Stamped records the commit never writes: what is checked beyond the
        // digest holds for every record the builtin writes.
        const destination = JSON.parse(forged("x").parameters).to[0];
        for (
          const [cause, change, refusal] of [
            ["long-window", { exp: 1_700_000_000_000 + 120_000 }, /window/],
            ["extra-key", {
              parameters: { body: "x", cc: "y", to: [destination] },
            }, /parameters/],
            ["long-body", {
              parameters: { body: "x".repeat(41), to: [destination] },
            }, /parameters/],
            [
              "other-integrity",
              {
                parameters: {
                  body: "x",
                  to: [{
                    ...destination,
                    integrity: [WRITTEN_BY_REVIEWED_INTENT],
                  }],
                },
              },
              /parameters/,
            ],
          ] as const
        ) {
          const base = forged("x");
          const parameters = "parameters" in change
            ? change.parameters
            : undefined;
          const record = await seeded(
            fixture,
            sender.did(),
            `stamped-${cause}`,
            {
              ...base,
              ...change,
              ...(parameters === undefined ? {} : {
                parameters: JSON.stringify(parameters),
                payloadDigest: hashStringOf(parameters as never),
              }),
            },
            { label: stampedLabel, origin: "derived", observes: "value" },
          );
          expect(() => verified(record)).toThrow(refusal);
        }
      } finally {
        await fixture.dispose();
      }
    });

    it("refuses a write into a genuine record at every depth", async () => {
      const fixture = await setup();
      try {
        const prepared = await prepareReviewedIntent(fixture.bindings());
        const committed = await commitReviewedIntent(
          prepared.consent,
          trustedClick(),
          text("Genuine"),
        );
        // Written through a cell with no schema, so that what refuses each
        // write is the claim the record stores, not one the write declares.
        const record = schemaless(fixture.runtime, committed.record) as Cell<
          Record<string, unknown>
        >;
        for (
          const [target, value] of [
            [record.key("parameters"), '{"body":"Tampered"}'],
            [record.key("payloadDigest"), "forged"],
            [record.key("added"), "forged"],
            [record.key("evidence").key("component"), "forged"],
            [record.key("evidence").key("added"), "forged"],
            [record.key("evidence"), {}],
          ] as const
        ) {
          const tx = fixture.runtime.edit();
          setCfcImplementationIdentity(tx, PATTERN);
          (target as Cell<unknown>).withTx(tx).set(value as never);
          expect((await tx.commit()).error?.message).toContain(
            "writeAuthorizedBy",
          );
        }
        expect(verified(committed.record).parameters.body)
          .toBe("Genuine");
      } finally {
        await fixture.dispose();
      }
    });
  });

  it("is not importable from a pattern", () => {
    expect(
      isAllowedAuthoredImportSpecifier(
        "@commonfabric/runner/cfc/reviewed-intent",
      ),
    ).toBe(false);
    const { runtimeExports } = getRuntimeModuleExports();
    expect(Object.keys(runtimeExports)).toContain("commonfabric/cfc");
    for (const namespace of Object.values(runtimeExports)) {
      for (const [name, value] of Object.entries(namespace as object)) {
        expect(name).not.toMatch(/ReviewedIntent/);
        expect([
          prepareReviewedIntent,
          commitReviewedIntent,
          verifyReviewedIntentRecord,
        ]).not.toContain(value);
      }
    }
  });
});
