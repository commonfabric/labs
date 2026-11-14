import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import type { Identity } from "@commonfabric/identity";

import {
  alice,
  bob,
  custodyRoom as setup,
  type CustodyRoomFixture as Fixture,
  mallory,
  MODULE,
  OTHER_MODULE,
  otherArtifact,
  PROJECT,
  S,
} from "./support/custody-room.ts";
import {
  type CustodyAnswerWatchUpdate,
  type CustodyRoom,
  publishCustodyAnswer,
  watchCustodyAnswer,
} from "../src/cfc/custody-seal.ts";
import type { Cell } from "../src/cell.ts";
import type { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";

// A custody room releases one answer per instance. Its projector is
// reactive: pointed at other input, or run again, it computes again, and a
// room rendering it would show each result its rule releases. The seal
// publishes the answer once into a create-only slot the room renders, so the
// answer published for an instance never changes after the first publication.
// Which instance a room renders is its bindings' to say, which the room's
// members can write; the custody seal spec says what that leaves open.

/** Writes `value` into `cell` as a member's own code. */
const writeAsMember = async (
  fixture: Fixture,
  cell: Cell<unknown>,
  value: (runtime: Runtime, tx: IExtendedStorageTransaction) => unknown,
  schema: unknown = { type: "object" },
) => {
  const runtime = fixture.runtimes.get(mallory)!;
  const local = runtime.getCellFromLink(
    cell.getAsNormalizedFullLink(),
    schema as never,
  );
  await local.sync();
  const written = await runtime.editWithRetry((tx) => {
    setCfcImplementationIdentity(tx, {
      kind: "verified",
      moduleIdentity: "sha256:member-code",
      symbol: "repoint",
      bindingPath: ["repoint"],
    });
    local.withTx(tx).set(value(runtime, tx) as never);
  });
  expect(written.error).toBeUndefined();
};

/** {@link writeAsMember}, answering the refusal's message if refused. */
const attemptAsMember = async (
  fixture: Fixture,
  cell: Cell<unknown>,
  write: (local: Cell<unknown>, runtime: Runtime) => void,
): Promise<string | undefined> => {
  const runtime = fixture.runtimes.get(mallory)!;
  // Through the member's own handle: no schema, so nothing the seal's
  // handle declares comes with it.
  const local = runtime.getCellFromLink({
    ...cell.getAsNormalizedFullLink(),
    schema: undefined,
  });
  await local.sync();
  const written = await runtime.editWithRetry((tx) => {
    setCfcImplementationIdentity(tx, {
      kind: "verified",
      moduleIdentity: "sha256:member-code",
      symbol: "rewrite",
      bindingPath: ["rewrite"],
    });
    write(local.withTx(tx), runtime);
  });
  return written.error === undefined
    ? undefined
    : String(written.error.message);
};

describe("custody answers", () => {
  const boxOf = (fixture: Fixture) =>
    fixture.runtimes.get(alice)!.getCell(S, "room-cells").key("box");
  const outputOf = (fixture: Fixture) =>
    fixture.runtimes.get(alice)!.getCell(S, "custody-room-choice");

  it("publishes the first honest answer, and later runs change nothing shown", async () => {
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", box);
      const { box: realBox, entryKey } = await fixture.seal(bob, "sushi", box);
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      expect(await fixture.shown(mallory)).toBeUndefined();
      const { value } = await fixture.publish(bob, output);
      expect(value).toBe("sushi");
      expect(await fixture.shown(mallory)).toBe("sushi");

      // A member's code points the box at a record repeating Alice's entry
      // beside one it made up, and the projector runs again.
      const record = fixture.runtimes.get(mallory)!.getCell(S, "crafted");
      await writeAsMember(fixture, record, (runtime, tx) => ({
        real: runtime.getCellFromLink(
          { ...realBox.getAsNormalizedFullLink(), path: [entryKey] },
          undefined,
          tx,
        ),
        madeUp: { stance: { choice: "tacos" } },
      }), { type: "object", ifc: { confidentiality: [cfcAtom.space(S)] } });
      expect(await fixture.project(bob, record, output)).toBe("no agreement");
      await expect(fixture.publish(bob, output)).rejects.toThrow(
        "already published",
      );
      // And again over the honest box: the answer is what it was.
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      await expect(fixture.publish(alice, output)).rejects.toThrow(
        "already published",
      );
      expect(await fixture.shown(mallory)).toBe("sushi");
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses an answer the policy does not release", async () => {
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", box);
      const { box: realBox, entryKey } = await fixture.seal(bob, "sushi", box);
      // The projector reads a record repeating Bob's entry: no witness.
      const record = fixture.runtimes.get(mallory)!.getCell(S, "repeated");
      await writeAsMember(fixture, record, (runtime, tx) => {
        const entry = runtime.getCellFromLink(
          { ...realBox.getAsNormalizedFullLink(), path: [entryKey] },
          undefined,
          tx,
        );
        return { first: entry, second: entry };
      }, { type: "object", ifc: { confidentiality: [cfcAtom.space(S)] } });
      expect(await fixture.project(bob, record, output)).toBe("sushi");
      await expect(fixture.publish(bob, output)).rejects.toThrow(
        "releases to the seal",
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a value that never carried the room's policy", async () => {
    // A member's code names a cell of its own, labeled for the room's
    // readers, as the answer: its label admits the room, but no rule of the
    // policy released it.
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      await fixture.seal(alice, "sushi", box);
      await fixture.seal(bob, "sushi", box);
      const forged = fixture.runtimes.get(mallory)!.getCell(S, "forged");
      await writeAsMember(
        fixture,
        forged,
        () => "tacos",
        { type: "string", ifc: { confidentiality: [cfcAtom.space(S)] } },
      );
      await expect(fixture.publish(mallory, forged)).rejects.toThrow(
        "releases to the seal",
      );
      const output = outputOf(fixture);
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      expect((await fixture.publish(bob, output)).value).toBe("sushi");
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a value whose policy and witness a member's schema declared", async () => {
    // A member's code writes a made-up answer into a cell whose schema
    // declares the room's policy and the witnessed projector's integrity.
    // Declared integrity is not a derivation: the value has no witness.
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      await fixture.seal(alice, "sushi", box);
      const { instance } = await fixture.seal(bob, "sushi", box);
      const forged = fixture.runtimes.get(mallory)!.getCell(S, "declared");
      await writeAsMember(fixture, forged, () => "tacos", {
        type: "string",
        ifc: {
          confidentiality: [{
            ...fixture.policy,
            subject: { __ctOwningSpace: true },
          }],
          integrity: [{
            type: CFC_ATOM_TYPE.TransformedBy,
            identity: {
              kind: "verified",
              moduleIdentity: MODULE,
              symbol: "projectChoice",
              bindingPath: ["projectChoice"],
            },
            inputWitness: {
              type: CFC_ATOM_TYPE.TransformedBy,
              identity: {
                kind: "builtin",
                builtinId: "cfc-custody-seal",
                instance,
              },
            },
          }],
        },
      });
      await expect(fixture.publish(mallory, forged)).rejects.toThrow(
        "releases to the seal",
      );
      const output = outputOf(fixture);
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      expect((await fixture.publish(bob, output)).value).toBe("sushi");
    } finally {
      await fixture.dispose();
    }
  });

  it("cannot label an answer for another policy's rule to release", async () => {
    // A member's own code reads the sealed box (so what it computes carries
    // the seal's witness) and labels its result with a clause naming the
    // room's policy OR one of its own whose rule releases anything, so that
    // rule, not the room's, would drop the room's clause. Writer fit refuses
    // the write: the box's entries carry the room's policy, and a clause
    // that also admits another policy is weaker than it.
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", box);
      await fixture.seal(bob, "sushi", box);
      const other = cfcAtom.modulePolicyRef(
        OTHER_MODULE,
        "releaseAnything",
        otherArtifact.policyDigest,
        S,
      );
      const result = await fixture.project(bob, box, output, {
        anyOf: [
          { ...fixture.policy, subject: { __ctOwningSpace: true } },
          { ...other, subject: { __ctOwningSpace: true } },
        ],
      }, {
        kind: "verified",
        moduleIdentity: "sha256:member-code",
        symbol: "projectChoice",
        bindingPath: ["projectChoice"],
      });
      expect(result).toEqual({
        refused: expect.stringContaining("writer-fit confidentiality misfit"),
      });
      // The honest projector still publishes over the same box.
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      expect((await fixture.publish(bob, output)).value).toBe("sushi");
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses an answer slot other code wrote first, and shows nothing from it", async () => {
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", box);
      const { instance } = await fixture.seal(bob, "sushi", box);
      // The slot's address derives from the policy and the instance, which
      // any room reader can compute.
      await writeAsMember(
        fixture,
        fixture.runtimes.get(mallory)!.getCell(S, {
          custodyAnswer: { policy: fixture.policy, instance },
        }),
        () => ({ instance, answer: "tacos" }),
      );
      await expect(fixture.shown(bob)).rejects.toThrow(
        "slot the seal did not write",
      );
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      await expect(fixture.publish(bob, output)).rejects.toThrow(
        "slot the seal did not write",
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("keeps a published answer as the seal wrote it, whatever a member writes beneath it", async () => {
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", box);
      await fixture.seal(bob, "sushi", box);
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      const { instance, answer: slot } = await fixture.publish(bob, output);
      expect(await fixture.shown(mallory)).toBe("sushi");
      const writes: [string, (local: Cell<unknown>) => void][] = [
        ["the answer", (local) => local.key("answer").set("tacos")],
        ["the instance", (local) => local.key("instance").set("other")],
        ["a key beside them", (local) => local.key("extra").set("tacos")],
        [
          "an object in place of the answer",
          (local) => local.key("answer").set({ choice: "tacos" } as never),
        ],
        // A claim whose schema names a type governs writes of that type.
        [
          "a string in place of the slot",
          (local) => local.set("tacos" as never),
        ],
        [
          "a list in place of the slot",
          (local) => local.set(["tacos"] as never),
        ],
        [
          "another slot in place of this one",
          (local) => local.set({ instance, answer: "tacos" } as never),
        ],
      ];
      // The slot's claim is stored with it, so every write is refused, the
      // primitive over its root included, and the slot still shows what the
      // seal wrote.
      for (const [what, write] of writes) {
        const refused = await attemptAsMember(fixture, slot, write);
        expect({ what, refused }).toEqual({
          what,
          refused: expect.stringContaining("writeAuthorizedBy"),
        });
        expect({ what, shown: await fixture.shown(mallory) }).toEqual({
          what,
          shown: "sushi",
        });
      }
      // And through a write redirect a member's own cell holds.
      const redirect = fixture.runtimes.get(mallory)!.getCell(S, "to-answer");
      await writeAsMember(
        fixture,
        redirect,
        (runtime, tx) =>
          runtime.getCellFromLink(
            { ...slot.getAsNormalizedFullLink(), path: ["answer"] },
            undefined,
            tx,
          ).getAsWriteRedirectLink(),
      );
      const throughRedirect = await attemptAsMember(
        fixture,
        redirect,
        (local) => local.set("tacos" as never),
      );
      expect(throughRedirect).toEqual(
        expect.stringContaining("writeAuthorizedBy"),
      );
      expect(await fixture.shown(mallory)).toBe("sushi");
      expect(instance).toBeDefined();
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses quietly while the projector has computed nothing", async () => {
    // Every seat has sealed but the projector has not run yet: its output
    // holds nothing, which is not yet an answer, and is refused the way an
    // answer the policy does not release is.
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      await fixture.seal(alice, "sushi", box);
      await fixture.seal(bob, "sushi", box);
      const output = outputOf(fixture);
      await expect(fixture.publish(bob, output)).rejects.toThrow(
        "releases to the seal",
      );
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      expect((await fixture.publish(bob, output)).value).toBe("sushi");
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses an answer before every seat has sealed", async () => {
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", box);
      expect(await fixture.project(alice, box, output)).toBe("sushi");
      await expect(fixture.publish(alice, output)).rejects.toThrow(
        "every seat to have sealed",
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a policy that releases anything without the seal's witness", async () => {
    const fixture = await setup({ witnessed: false });
    try {
      const box = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", box);
      await fixture.seal(bob, "sushi", box);
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      await expect(fixture.publish(bob, output)).rejects.toThrow(
        "requires the seal's witness",
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a policy whose rule releases the projection to the room's readers", async () => {
    // Readable by the room's readers, a projection that a member's code
    // points at input of its own keeps its earlier witnessed stamp while its
    // answer does not change, and says whether that input yields the
    // released answer. Only a policy releasing to the seal is published.
    const fixture = await setup({ toSeal: false });
    try {
      const box = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", box);
      await fixture.seal(bob, "sushi", box);
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      await expect(fixture.publish(bob, output)).rejects.toThrow(
        "releases only to the seal",
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses an answer computed over an earlier instance's box", async () => {
    // An earlier instance may have had other members; its answer is not this
    // instance's to release.
    const fixture = await setup();
    try {
      const first = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", first);
      await fixture.seal(bob, "sushi", first);

      await fixture.setTerms("Where should we eat tomorrow?");
      const second = fixture.runtimes.get(alice)!.getCell(S, "room-cells").key(
        "second",
      );
      await fixture.seal(alice, "tacos", second);
      await fixture.seal(bob, "tacos", second);
      // The projector reads the earlier instance's genuine box.
      expect(await fixture.project(bob, first, output)).toBe("sushi");
      await expect(fixture.publish(bob, output)).rejects.toThrow(
        "releases to the seal",
      );
      expect(await fixture.project(bob, second, output)).toBe("tacos");
      expect((await fixture.publish(bob, output)).value).toBe("tacos");
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses an answer that is not a scalar, and publishes the scalar the same projection computes", async () => {
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", box);
      await fixture.seal(bob, "sushi", box);
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      // The room's projector, over the same box, writing a record instead.
      const runtime = fixture.runtimes.get(bob)!;
      const local = runtime.getCellFromLink(box.getAsNormalizedFullLink());
      const record = runtime.getCell(S, "custody-room-record", {
        type: "object",
        ifc: {
          confidentiality: [{
            ...fixture.policy,
            subject: { __ctOwningSpace: true },
          }],
        },
      } as never);
      await record.sync();
      const written = await runtime.editWithRetry((tx) => {
        setCfcImplementationIdentity(tx, PROJECT);
        const entries = (local.withTx(tx).get() ?? {}) as Record<
          string,
          unknown
        >;
        record.withTx(tx).set({ count: Object.keys(entries).length } as never);
      });
      expect(written.error).toBeUndefined();

      await expect(fixture.publish(bob, record)).rejects.toThrow(
        "Custody answer requires a value the room's policy releases to the seal",
      );
      expect((await fixture.publish(bob, output)).value).toBe("sushi");
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses an output held by another runtime", async () => {
    const fixture = await setup();
    try {
      await expect(
        publishCustodyAnswer(
          fixture.room(alice),
          fixture.runtimes.get(bob)!.getCell(S, "custody-room-choice"),
        ),
      ).rejects.toThrow("Custody seal handles must belong to the same runtime");
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses an answer whose room changed while it was being published", async () => {
    // The terms change after the room was inspected and before the
    // publishing transaction runs, which re-reads what the inspection read.
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", box);
      await fixture.seal(bob, "sushi", box);
      expect(await fixture.project(alice, box, output)).toBe("sushi");
      const runtime = fixture.runtimes.get(alice)!;
      const original = runtime.editWithRetry.bind(runtime);
      runtime.editWithRetry = (async (
        ...args: Parameters<Runtime["editWithRetry"]>
      ) => {
        runtime.editWithRetry = original;
        await fixture.setTerms("Where should we eat tomorrow?");
        return await original(...args);
      }) as Runtime["editWithRetry"];
      await expect(fixture.publish(alice, output)).rejects.toThrow(
        "Custody answer's room changed while publishing",
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses an answer whose publication the store refuses", async () => {
    const fixture = await setup();
    try {
      const box = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", box);
      await fixture.seal(bob, "sushi", box);
      expect(await fixture.project(bob, box, output)).toBe("sushi");
      // The room is refused once the answer is checked and about to commit.
      const runtime = fixture.runtimes.get(bob)!;
      const original = runtime.editWithRetry.bind(runtime);
      runtime.editWithRetry = ((
        ...args: Parameters<Runtime["editWithRetry"]>
      ) => {
        runtime.editWithRetry = original;
        fixture.refuse(S);
        return original(...args);
      }) as Runtime["editWithRetry"];
      await expect(fixture.publish(bob, output)).rejects.toThrow(
        "Custody answer failed",
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("publishes again for a fresh instance", async () => {
    const fixture = await setup();
    try {
      const first = boxOf(fixture);
      const output = outputOf(fixture);
      await fixture.seal(alice, "sushi", first);
      await fixture.seal(bob, "sushi", first);
      expect(await fixture.project(bob, first, output)).toBe("sushi");
      const earlier = await fixture.publish(bob, output);

      await fixture.setTerms("Where should we eat tomorrow?");
      // A seal for this instance does not write into the earlier instance's
      // custody documents, its answer slot or its anchor.
      for (const kind of ["custodyAnswer", "custodyAnchor"] as const) {
        const earlierDoc = fixture.runtimes.get(alice)!.getCell(S, {
          [kind]: { policy: fixture.policy, instance: earlier.instance },
        });
        await expect(fixture.seal(alice, "tacos", earlierDoc.key("x")))
          .rejects.toThrow("only from a cell that holds nothing else");
      }
      const second = fixture.runtimes.get(alice)!.getCell(S, "room-cells").key(
        "second",
      );
      await fixture.seal(alice, "tacos", second);
      await fixture.seal(bob, "tacos", second);
      expect(await fixture.project(bob, second, output)).toBe("tacos");
      const later = await fixture.publish(bob, output);
      expect(later.instance).not.toBe(earlier.instance);
      expect(await fixture.shown(mallory)).toBe("tacos");
      expect(later.answer.getAsNormalizedFullLink().id).not.toBe(
        earlier.answer.getAsNormalizedFullLink().id,
      );
    } finally {
      await fixture.dispose();
    }
  });

  describe("watching", () => {
    /**
     * Watches the room as `identity`'s host does, and answers each report
     * that satisfies a test, resolved by the watch's own report rather than
     * by polling.
     */
    const watch = (
      fixture: Fixture,
      identity: Identity,
      output: Cell<unknown>,
      room: CustodyRoom = fixture.room(identity),
    ) => {
      const runtime = fixture.runtimes.get(identity)!;
      const reports: CustodyAnswerWatchUpdate[] = [];
      let waiting:
        | {
          test: (update: CustodyAnswerWatchUpdate) => boolean;
          resolve: (update: CustodyAnswerWatchUpdate) => void;
        }
        | undefined;
      const cancel = watchCustodyAnswer(
        room,
        runtime.getCellFromLink(output.getAsNormalizedFullLink()),
        (update) => {
          reports.push(update);
          if (waiting?.test(update)) {
            waiting.resolve(update);
            waiting = undefined;
          }
        },
      );
      return {
        reports,
        cancel,
        /** The first report from now on that `test` admits. */
        until(test: (update: CustodyAnswerWatchUpdate) => boolean) {
          const { promise, resolve } = Promise.withResolvers<
            CustodyAnswerWatchUpdate
          >();
          waiting = { test, resolve };
          return promise;
        },
      };
    };
    const published = (update: CustodyAnswerWatchUpdate) =>
      update.status === "published";

    it("publishes once the last seat seals, though the projected answer does not change", async () => {
      // The projector answers before every seat has sealed, and its answer
      // is the same once the last one has, so nothing the projected answer
      // does says the room is ready: the box does.

      const fixture = await setup();
      try {
        const box = boxOf(fixture);
        const output = outputOf(fixture);
        await fixture.seal(alice, "sushi", box);
        expect(await fixture.project(alice, box, output)).toBe("sushi");
        const watching = watch(fixture, bob, output);
        try {
          await watching.until((update) => update.status === "pending");
          expect(watching.reports.every((update) => !("error" in update)))
            .toBe(true);

          const shown = watching.until(published);
          await fixture.seal(bob, "sushi", box);
          const update = await shown;

          expect(update).toMatchObject({
            status: "published",
            publishedHere: true,
            value: "sushi",
          });
          expect(await fixture.shown(mallory)).toBe("sushi");
        } finally {
          watching.cancel();
        }
      } finally {
        await fixture.dispose();
      }
    });

    it("reports an answer another member published as not its own", async () => {
      const fixture = await setup();
      try {
        const box = boxOf(fixture);
        const output = outputOf(fixture);
        await fixture.seal(alice, "sushi", box);
        await fixture.seal(bob, "sushi", box);
        expect(await fixture.project(bob, box, output)).toBe("sushi");
        const { instance } = await fixture.publish(bob, output);
        const watching = watch(fixture, mallory, output);
        try {
          expect(await watching.until(published)).toMatchObject({
            status: "published",
            instance,
            publishedHere: false,
            value: "sushi",
          });
        } finally {
          watching.cancel();
        }
      } finally {
        await fixture.dispose();
      }
    });

    it("reports pending, with no error, while the room has not proposed", async () => {
      const fixture = await setup();
      try {
        const runtime = fixture.runtimes.get(bob)!;
        const watching = watch(fixture, bob, outputOf(fixture), {
          terms: runtime.getCell(S, "terms-not-yet-proposed"),
          policy: fixture.policy,
        });
        try {
          expect(await watching.until(() => true)).toEqual({
            status: "pending",
          });
        } finally {
          watching.cancel();
        }
      } finally {
        await fixture.dispose();
      }
    });

    it("follows the room's terms to a fresh instance, which has published nothing", async () => {
      const fixture = await setup();
      try {
        const box = boxOf(fixture);
        const output = outputOf(fixture);
        await fixture.seal(alice, "sushi", box);
        await fixture.seal(bob, "sushi", box);
        expect(await fixture.project(bob, box, output)).toBe("sushi");
        const watching = watch(fixture, bob, output);
        try {
          const first = await watching.until(published);
          const fresh = watching.until((update) => update.status === "pending");
          await fixture.setTerms("Where should we eat tomorrow?");
          expect(await fresh).toEqual({ status: "pending" });
          expect(first).toMatchObject({ publishedHere: true });
        } finally {
          watching.cancel();
        }
      } finally {
        await fixture.dispose();
      }
    });

    it("reports a policy the seal will not publish under as an error", async () => {
      const fixture = await setup({ witnessed: false });
      try {
        const box = boxOf(fixture);
        const output = outputOf(fixture);
        await fixture.seal(alice, "sushi", box);
        await fixture.seal(bob, "sushi", box);
        const watching = watch(fixture, bob, output);
        try {
          const update = await watching.until(() => true);
          expect(update.status).toBe("pending");
          expect("error" in update && update.error).toContain(
            "requires a policy whose every rule requires the seal's witness",
          );
        } finally {
          watching.cancel();
        }
      } finally {
        await fixture.dispose();
      }
    });
  });
});
