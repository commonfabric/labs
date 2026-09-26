import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import {
  commitSnapshotShare,
  prepareSnapshotShare,
  type SnapshotShareConsent,
} from "../src/cfc/share-snapshot.ts";
import { markRendererTrustedEvent } from "../src/cfc/ui-contract.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const visitor = await Identity.fromPassphrase("snapshot-share-visitor");
const owner = await Identity.fromPassphrase("snapshot-share-owner");
const third = await Identity.fromPassphrase("snapshot-share-third");

/** Creates the renderer-side mark attached only by the trusted host. */
const trustedClick = () => {
  const event = {
    type: "click",
    provenance: {
      origin: "dom",
      trusted: true,
      ui: { pattern: "ShareSnapshot" },
    },
  };
  markRendererTrustedEvent(event);
  return event;
};

/** Creates three readers of one store with a private book and attested owner. */
const setup = async () => {
  const storage = StorageManager.emulate({ as: visitor });
  const runtimes = [visitor, owner, third].map((identity) =>
    new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: storage,
      trustSnapshotProvider: () => ({
        id: identity.did(),
        actingPrincipal: identity.did(),
      }),
      cfcReadMaxConfidentiality: [cfcAtom.user(identity.did())],
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    })
  );
  const [reader, author] = runtimes;
  const authorTx = author.edit();
  authorTx.setCfcImplementationIdentity({
    kind: "builtin",
    builtinId: "snapshot-owner",
  });
  const recipient = author.getCell(visitor.did(), "owner-descriptor", {
    type: "object",
    additionalProperties: false,
    ifc: {
      ownerPrincipal: owner.did(),
      addIntegrity: [{ kind: "represents-principal", subject: owner.did() }],
      writeAuthorizedBy: ["snapshot-owner"],
    },
  }, authorTx);
  recipient.set({});
  expect((await authorTx.commit()).error).toBeUndefined();
  const tx = reader.edit();
  const source = reader.getCell<{ title: string; author: string }>(
    visitor.did(),
    "selected-book",
    {
      type: "object",
      properties: { title: { type: "string" }, author: { type: "string" } },
      required: ["title", "author"],
      ifc: { confidentiality: [cfcAtom.user(visitor.did())] },
    },
    tx,
  );
  source.set({ title: "Solaris", author: "Stanisław Lem" });
  expect((await tx.commit()).error).toBeUndefined();
  await source.sync();
  await recipient.sync();
  await storage.synced();
  return {
    source: source.withTx(undefined),
    recipient: reader.getCellFromLink(recipient.getAsNormalizedFullLink()),
    runtimes,
    storage,
    async dispose() {
      await storage.synced();
      for (const runtime of runtimes) await runtime.dispose();
      await storage.close();
    },
  };
};

describe("cfc-share-snapshot", () => {
  it("previews the authenticated actor's private value without a runtime-wide read ceiling", async () => {
    const fixture = await setup();
    const unbounded = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: fixture.storage,
      trustSnapshotProvider: () => ({
        id: visitor.did(),
        actingPrincipal: visitor.did(),
      }),
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    try {
      const source = unbounded.getCellFromLink(
        fixture.source.getAsNormalizedFullLink(),
      );
      const recipient = unbounded.getCellFromLink(
        fixture.recipient.getAsNormalizedFullLink(),
      );
      const prepared = prepareSnapshotShare(source, { user: recipient });
      expect(prepared.value).toEqual({
        title: "Solaris",
        author: "Stanisław Lem",
      });
      expect(prepared.audience).toEqual(cfcAtom.user(owner.did()));
      const shared = await commitSnapshotShare(
        prepared.consent,
        trustedClick(),
      );
      expect(shared.get()).toEqual(prepared.value);
    } finally {
      await unbounded.dispose();
      await fixture.dispose();
    }
  });

  it("refuses an unbounded host's preview of another user's private value", async () => {
    const fixture = await setup();
    const unbounded = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: fixture.storage,
      trustSnapshotProvider: () => ({
        id: visitor.did(),
        actingPrincipal: visitor.did(),
      }),
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    try {
      const author = fixture.runtimes[1];
      const linkedTx = author.edit();
      const linked = author.getCell(visitor.did(), "unshared-book", {
        ifc: { confidentiality: [cfcAtom.user(owner.did())] },
      }, linkedTx);
      linked.set("The linked title");
      expect((await linkedTx.commit()).error).toBeUndefined();
      const tx = author.edit();
      const privateBook = author.getCell(visitor.did(), "author-private-book", {
        type: "object",
        properties: { reference: { asCell: ["readonly"] } },
        ifc: { confidentiality: [cfcAtom.user(owner.did())] },
      }, tx);
      privateBook.set({
        reference: linked,
      });
      expect((await tx.commit()).error).toBeUndefined();
      await privateBook.sync();
      expect(() =>
        prepareSnapshotShare(
          unbounded.getCellFromLink(privateBook.getAsNormalizedFullLink()),
          {
            user: unbounded.getCellFromLink(
              fixture.recipient.getAsNormalizedFullLink(),
            ),
          },
        )
      ).toThrow(/authenticated actor's read ceiling/);
    } finally {
      await unbounded.dispose();
      await fixture.dispose();
    }
  });

  it("refuses a missing source value without creating a share", async () => {
    const fixture = await setup();
    try {
      const absent = fixture.runtimes[0].getCell(
        visitor.did(),
        "absent-source",
      );
      expect(() => prepareSnapshotShare(absent, { user: fixture.recipient }))
        .toThrow(/JSON values without cell references/);
    } finally {
      await fixture.dispose();
    }
  });

  it("copies JSON primitives without granting public access", async () => {
    const fixture = await setup();
    const runtime = fixture.runtimes[0];
    try {
      for (const [index, value] of [null, true, 42].entries()) {
        const tx = runtime.edit();
        const source = runtime.getCell(visitor.did(), `primitive-${index}`, {
          ifc: { confidentiality: [cfcAtom.user(visitor.did())] },
        }, tx);
        source.set(value);
        expect((await tx.commit()).error).toBeUndefined();
        await source.sync();
        const prepared = prepareSnapshotShare(source.withTx(undefined), {
          user: fixture.recipient,
        });
        expect(prepared.value).toBe(value);
        const shared = await commitSnapshotShare(
          prepared.consent,
          trustedClick(),
        );
        await fixture.storage.synced();
        expect(
          fixture.runtimes[1].getCellFromLink(shared.getAsNormalizedFullLink())
            .get(),
        )
          .toBe(value);
        expect(() =>
          fixture.runtimes[2].getCellFromLink(shared.getAsNormalizedFullLink())
            .get()
        )
          .toThrow(/read ceiling/);
      }
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a selected value containing an opaque cell reference", async () => {
    const fixture = await setup();
    const runtime = fixture.runtimes[0];
    try {
      const tx = runtime.edit();
      const source = runtime.getCell(visitor.did(), "selection-with-link", {
        type: "object",
        properties: { book: { asCell: ["readonly"] } },
      }, tx);
      source.set({ book: fixture.source });
      expect((await tx.commit()).error).toBeUndefined();
      await source.sync();
      expect(() =>
        prepareSnapshotShare(source.withTx(undefined), {
          user: fixture.recipient,
        })
      ).toThrow(/JSON values without cell references/);
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses an actor changed between validation and publication", async () => {
    const fixture = await setup();
    let preparations = 0;
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: fixture.storage,
      trustSnapshotProvider: () => {
        const identity = ++preparations <= 2 ? visitor : owner;
        return { id: identity.did(), actingPrincipal: identity.did() };
      },
      cfcReadMaxConfidentiality: [cfcAtom.user(visitor.did())],
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    try {
      const prepared = prepareSnapshotShare(
        runtime.getCellFromLink(fixture.source.getAsNormalizedFullLink()),
        {
          user: runtime.getCellFromLink(
            fixture.recipient.getAsNormalizedFullLink(),
          ),
        },
      );
      await expect(commitSnapshotShare(prepared.consent, trustedClick()))
        .rejects.toThrow(/actor changed after review/);
    } finally {
      await runtime.dispose();
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
      const source = anonymous.getCellFromLink(
        fixture.source.getAsNormalizedFullLink(),
      );
      const recipient = anonymous.getCellFromLink(
        fixture.recipient.getAsNormalizedFullLink(),
      );
      expect(() => prepareSnapshotShare(source, { user: recipient }))
        .toThrow(/authenticated actor/);
      expect(() =>
        prepareSnapshotShare(fixture.source, {
          user: fixture.runtimes[1].getCellFromLink(
            fixture.recipient.getAsNormalizedFullLink(),
          ),
        })
      ).toThrow(/same runtime/);
    } finally {
      await anonymous.dispose();
      await fixture.dispose();
    }
  });

  it("refuses append bindings from another runtime before granting consent", async () => {
    const fixture = await setup();
    try {
      const foreign = fixture.runtimes[1].getCellFromLink(
        fixture.source.getAsNormalizedFullLink(),
      );
      const audience = { user: fixture.recipient };
      expect(() =>
        prepareSnapshotShare(fixture.source, audience, {
          recommended: foreign,
          received: fixture.source,
        })
      ).toThrow(/append targets must use the source runtime/);
      expect(() =>
        prepareSnapshotShare(fixture.source, audience, {
          recommended: fixture.source,
          received: foreign,
        })
      ).toThrow(/append targets must use the source runtime/);
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a space audience whose address is not a DID", async () => {
    const fixture = await setup();
    try {
      const invalid = fixture.runtimes[0].getCell(
        "not-a-did" as ReturnType<typeof visitor.did>,
        "audience",
      );
      expect(() => prepareSnapshotShare(fixture.source, { space: invalid }))
        .toThrow(/space DID/);
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a preview when the transaction has no read journal", async () => {
    const fixture = await setup();
    const runtime = fixture.runtimes[0];
    const edit = runtime.edit.bind(runtime);
    try {
      runtime.edit = (...args: Parameters<typeof runtime.edit>) => {
        const tx = edit(...args);
        Object.defineProperty(tx, "getReadActivities", { value: undefined });
        return tx;
      };
      expect(() =>
        prepareSnapshotShare(fixture.source, {
          user: fixture.recipient,
        })
      ).toThrow(/verifiable read journal/);
    } finally {
      runtime.edit = edit;
      await fixture.dispose();
    }
  });

  it("shares a new snapshot with the reader and originator while preserving the private source", async () => {
    const fixture = await setup();
    try {
      const prepared = prepareSnapshotShare(fixture.source, {
        user: fixture.recipient,
      });
      expect(prepared.value).toEqual({
        title: "Solaris",
        author: "Stanisław Lem",
      });
      expect(prepared.audience).toEqual(cfcAtom.user(owner.did()));
      const shared = await commitSnapshotShare(
        prepared.consent,
        trustedClick(),
      );
      await fixture.storage.synced();
      expect(shared.getAsNormalizedFullLink().id).not.toBe(
        fixture.source.getAsNormalizedFullLink().id,
      );
      for (const runtime of fixture.runtimes.slice(0, 2)) {
        expect(runtime.getCellFromLink(shared.getAsNormalizedFullLink()).get())
          .toEqual(prepared.value);
      }
      expect(() =>
        fixture.runtimes[2].getCellFromLink(shared.getAsNormalizedFullLink())
          .get()
      ).toThrow(/read ceiling/);
      expect(() =>
        fixture.runtimes[1].getCellFromLink(
          fixture.source.getAsNormalizedFullLink(),
        ).get()
      ).toThrow(/read ceiling/);
    } finally {
      await fixture.dispose();
    }
  });
  it("refuses forged, untrusted, and replayed consent", async () => {
    const fixture = await setup();
    try {
      await expect(
        commitSnapshotShare({} as SnapshotShareConsent, trustedClick()),
      )
        .rejects.toThrow(/unknown or already consumed/);
      const untrusted = prepareSnapshotShare(fixture.source, {
        user: fixture.recipient,
      });
      await expect(commitSnapshotShare(untrusted.consent, {
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: { pattern: "ShareSnapshot" },
        },
      })).rejects.toThrow(/trusted host share gesture/);
      const genuine = prepareSnapshotShare(fixture.source, {
        user: fixture.recipient,
      });
      await commitSnapshotShare(genuine.consent, trustedClick());
      await expect(commitSnapshotShare(genuine.consent, trustedClick()))
        .rejects.toThrow(/already consumed/);
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a changed value after the reader reviewed it", async () => {
    const fixture = await setup();
    try {
      const prepared = prepareSnapshotShare(fixture.source, {
        user: fixture.recipient,
      });
      const tx = fixture.runtimes[0].edit();
      fixture.source.withTx(tx).key("title").set("A different private title");
      expect((await tx.commit()).error).toBeUndefined();
      await fixture.storage.synced();
      await expect(commitSnapshotShare(prepared.consent, trustedClick()))
        .rejects.toThrow(/review is stale/);
      expect(prepared.value).toEqual({
        title: "Solaris",
        author: "Stanisław Lem",
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a recipient whose only attestation a link carried", async () => {
    // A document whose root holds a link to the owner's descriptor carries
    // that descriptor's attestation as a link's entry, which names whom the
    // linked document represents, not this one.
    const fixture = await setup();
    try {
      const tx = fixture.runtimes[0].edit();
      const linking = fixture.runtimes[0].getCell(
        visitor.did(),
        "link-carried-recipient",
        undefined,
        tx,
      );
      writeSeedEnvelopeDoc(tx, visitor.did());
      seedStoredEnvelope(tx, {
        space: visitor.did(),
        id: linking.getAsNormalizedFullLink().id,
        type: "application/json",
        path: [],
      }, {
        value: {},
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: {
                integrity: [{
                  kind: "represents-principal",
                  subject: owner.did(),
                }],
              },
              origin: "link",
            }],
          },
        },
      });
      expect((await tx.commit()).error).toBeUndefined();
      await linking.sync();
      expect(() =>
        prepareSnapshotShare(fixture.source, {
          user: linking.withTx(undefined),
        })
      ).toThrow(/one persisted principal attestation/);
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a recipient changed after review", async () => {
    const fixture = await setup();
    try {
      const target = { user: fixture.recipient };
      const prepared = prepareSnapshotShare(fixture.source, target);
      const tx = fixture.runtimes[0].edit();
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "snapshot-owner",
      });
      const another = fixture.runtimes[0].getCell(
        visitor.did(),
        "other-recipient",
        {
          type: "object",
          ifc: {
            ownerPrincipal: visitor.did(),
            writeAuthorizedBy: ["snapshot-owner"],
            addIntegrity: [{
              kind: "represents-principal",
              subject: visitor.did(),
            }],
          },
        },
        tx,
      );
      another.set({});
      expect((await tx.commit()).error).toBeUndefined();
      await another.sync();
      target.user = another.withTx(undefined);
      await expect(commitSnapshotShare(prepared.consent, trustedClick()))
        .rejects.toThrow(/review is stale/);
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses authored recipient claims without persisted attestation", async () => {
    const fixture = await setup();
    try {
      const tx = fixture.runtimes[0].edit();
      const target = fixture.runtimes[0].getCell(visitor.did(), "unattested", {
        type: "object",
      }, tx);
      target.set({});
      expect((await tx.commit()).error).toBeUndefined();
      await target.sync();
      const forged = target.withTx(undefined).asSchema({
        ifc: {
          addIntegrity: [{
            kind: "represents-principal",
            subject: owner.did(),
          }],
        },
      });
      expect(() => prepareSnapshotShare(fixture.source, { user: forged }))
        .toThrow(/persisted principal attestation/);
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses clauses that the actor does not own and the recipient cannot read", async () => {
    const fixture = await setup();
    const broad = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: fixture.storage,
      cfcReadMaxConfidentiality: [
        cfcAtom.user(owner.did()),
        cfcAtom.space(owner.did()),
        cfcAtom.user(visitor.did()),
        "private-policy",
      ],
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    try {
      for (
        const [index, clause] of [
          cfcAtom.user(owner.did()),
          cfcAtom.space(owner.did()),
          { anyOf: [cfcAtom.user(visitor.did()), cfcAtom.user(owner.did())] },
          "private-policy",
        ].entries()
      ) {
        const tx = broad.edit();
        const protectedValue = broad.getCell(
          visitor.did(),
          `other-secret-${index}`,
          {
            type: "string",
            ifc: { confidentiality: [clause] },
          },
          tx,
        );
        protectedValue.set("not yours to release");
        expect((await tx.commit()).error).toBeUndefined();
        await protectedValue.sync();
        const target = broad.getCellFromLink(
          fixture.recipient.getAsNormalizedFullLink(),
        );
        expect(() =>
          prepareSnapshotShare(protectedValue.withTx(undefined), {
            space: target,
          })
        )
          .toThrow(/only the authenticated actor/);
      }
    } finally {
      await broad.dispose();
      await fixture.dispose();
    }
  });

  it("copies a private library for a reviewed space audience", async () => {
    const fixture = await setup();
    try {
      const prepared = prepareSnapshotShare(fixture.source, {
        space: fixture.recipient,
      });
      expect(prepared.audience).toEqual(cfcAtom.space(visitor.did()));
      const shared = await commitSnapshotShare(
        prepared.consent,
        trustedClick(),
      );
      await fixture.storage.synced();
      const spaceReader = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager: fixture.storage,
        cfcReadMaxConfidentiality: [cfcAtom.space(visitor.did())],
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      });
      try {
        expect(
          spaceReader.getCellFromLink(shared.getAsNormalizedFullLink()).get(),
        ).toEqual(prepared.value);
        expect(() =>
          spaceReader.getCellFromLink(fixture.source.getAsNormalizedFullLink())
            .get()
        ).toThrow(/read ceiling/);
      } finally {
        await spaceReader.dispose();
      }
    } finally {
      await fixture.dispose();
    }
  });

  it("keeps the shared copy immutable to ordinary writes", async () => {
    const fixture = await setup();
    try {
      const prepared = prepareSnapshotShare(fixture.source, {
        user: fixture.recipient,
      });
      const shared = await commitSnapshotShare(
        prepared.consent,
        trustedClick(),
      );
      await fixture.storage.synced();
      const tx = fixture.runtimes[0].edit();
      shared.withTx(tx).set({ title: "Replacement", author: "Mallory" });
      const result = await tx.commit();
      expect(result.error?.message).toContain("writeAuthorizedBy");
      expect(shared.get()).toEqual(prepared.value);
    } finally {
      await fixture.dispose();
    }
  });
  it("refuses a source changed between validation and publication", async () => {
    const fixture = await setup();
    const runtime = fixture.runtimes[0];
    const edit = runtime.edit.bind(runtime);
    try {
      const prepared = prepareSnapshotShare(fixture.source, {
        user: fixture.recipient,
      });
      let edits = 0;
      runtime.edit = (...args: Parameters<typeof runtime.edit>) => {
        const tx = edit(...args);
        if (++edits === 2) {
          const commit = tx.commit.bind(tx);
          tx.commit = async () => {
            const change = edit();
            fixture.source.withTx(change).key("title").set(
              "Changed after verification",
            );
            expect((await change.commit()).error).toBeUndefined();
            await fixture.storage.synced();
            return await commit();
          };
        }
        return tx;
      };
      await expect(commitSnapshotShare(prepared.consent, trustedClick()))
        .rejects.toThrow(/Snapshot share failed/);
    } finally {
      runtime.edit = edit;
      await fixture.dispose();
    }
  });
  it("retains a shared library clause while releasing only the visitor's private clause", async () => {
    const fixture = await setup();
    const invitationSpace = visitor.did();
    const reader = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: fixture.storage,
      cfcReadMaxConfidentiality: [
        cfcAtom.user(visitor.did()),
        cfcAtom.space(invitationSpace),
      ],
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    const thirdMember = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: fixture.storage,
      trustSnapshotProvider: () => ({
        id: third.did(),
        actingPrincipal: third.did(),
      }),
      cfcReadMaxConfidentiality: [
        cfcAtom.user(third.did()),
        cfcAtom.space(invitationSpace),
      ],
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    try {
      const tx = reader.edit();
      const suggestions = reader.getCell(
        invitationSpace,
        "library-informed-suggestions",
        {
          type: "object",
          properties: { title: { type: "string" } },
          ifc: {
            confidentiality: [cfcAtom.user(visitor.did()), {
              anyOf: [
                cfcAtom.user(owner.did()),
                cfcAtom.space(invitationSpace),
              ],
            }],
          },
        },
        tx,
      );
      suggestions.set({ title: "Solaris" });
      expect((await tx.commit()).error).toBeUndefined();
      await suggestions.sync();
      const target = reader.getCellFromLink(
        fixture.recipient.getAsNormalizedFullLink(),
      );
      const prepared = prepareSnapshotShare(suggestions.withTx(undefined), {
        user: target,
      });
      const shared = await commitSnapshotShare(
        prepared.consent,
        trustedClick(),
      );
      await fixture.storage.synced();
      expect(reader.getCellFromLink(shared.getAsNormalizedFullLink()).get())
        .toEqual({ title: "Solaris" });
      expect(
        fixture.runtimes[1].getCellFromLink(shared.getAsNormalizedFullLink())
          .get(),
      ).toEqual({ title: "Solaris" });
      expect(() =>
        thirdMember.getCellFromLink(shared.getAsNormalizedFullLink()).get()
      ).toThrow(/read ceiling/);
      const createOutsider = thirdMember.edit();
      createOutsider.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "snapshot-owner",
      });
      const outsider = thirdMember.getCell(
        invitationSpace,
        "outsider-descriptor",
        {
          type: "object",
          ifc: {
            ownerPrincipal: third.did(),
            writeAuthorizedBy: ["snapshot-owner"],
            addIntegrity: [{
              kind: "represents-principal",
              subject: third.did(),
            }],
          },
        },
        createOutsider,
      );
      outsider.set({});
      expect((await createOutsider.commit()).error).toBeUndefined();
      await outsider.sync();
      expect(() =>
        prepareSnapshotShare(suggestions.withTx(undefined), {
          user: reader.getCellFromLink(outsider.getAsNormalizedFullLink()),
        })
      ).toThrow(/already admit the recipient/);
    } finally {
      await reader.dispose();
      await thirdMember.dispose();
      await fixture.dispose();
    }
  });
});
