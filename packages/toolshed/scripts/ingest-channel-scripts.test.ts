import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  channelId,
  getRegistration,
  getRegistrationIndex,
  type IngestRegistration,
  saveRegistration,
} from "@/routes/ingest/ingest.utils.ts";
import {
  collectRows,
  defaultRuntime as auditRuntime,
  main as auditMain,
  recoverIds,
  render,
  runAudit,
} from "./audit-ingest-channels.ts";
import {
  main as provisionMain,
  provisionChannel,
} from "./provision-ingest-channel.ts";
import {
  defaultRuntime as retireRuntime,
  main as retireMain,
  retireChannels,
  runRetire,
  USAGE,
} from "./retire-ingest-channels.ts";

describe("ingest channel operator scripts", () => {
  // The operator scripts behind the retirement procedure — audit, retire, and
  // the break-glass provision path. They are the only tooling that makes a
  // trust-condition cutover answerable, so the selection logic — what gets
  // retired, what is skipped, what the audit reports — is worth pinning even
  // though the entrypoints themselves are thin.

  let signer: Identity;
  let serviceSpace: string;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  const reg = (over: Partial<IngestRegistration> = {}): IngestRegistration => ({
    id: "ing_a",
    name: "a",
    space: "did:key:z6MkspaceAAAA",
    causePrefix: "location",
    installId: "phone-1",
    kind: "device",
    secretHash: "hash",
    createdBy: serviceSpace,
    createdAt: "2026-08-01T00:00:00.000Z",
    enabled: true,
    ...over,
  });

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("ingest-scripts-test");
    serviceSpace = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://scripts-test.invalid"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("audits every registered channel, with owner and state", async () => {
    await saveRegistration(runtime, serviceSpace, reg({ owner: "did:key:zA" }));
    await saveRegistration(
      runtime,
      serviceSpace,
      reg({
        id: "ing_b",
        installId: "phone-2",
        enabled: false,
        revoked: { at: "2026-08-02T00:00:00.000Z", by: "did:key:zA" },
      }),
    );

    const rows = await collectRows(runtime, serviceSpace);
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.id === "ing_a")?.state).toBe("active");
    expect(rows.find((r) => r.id === "ing_b")?.state).toBe("revoked");
    expect(rows.find((r) => r.id === "ing_b")?.revokedAt).toBe(
      "2026-08-02T00:00:00.000Z",
    );
  });

  it("marks a channel with no verified owner", async () => {
    // Operator-provisioned channels have no verified owner, and they are
    // exactly the ones no user can revoke for themselves — so the audit must
    // name them.

    await saveRegistration(runtime, serviceSpace, reg());
    const rows = await collectRows(runtime, serviceSpace);
    expect(rows[0].owner).toBe("<operator-provisioned>");
  });

  describe("recovering a channel the index never learned about", () => {
    // A channel can exist that the audit index never learned about. An audit
    // that walks only the index cannot find it — repairing an index by
    // enumerating that same index only ever confirms what is already there —
    // and the affected space's owner cannot see or revoke it.

    const space = "did:key:z6MkspaceAAAA";
    const installId = "lost-phone";
    const lost = () => channelId(space, installId);

    // The state under recovery: a live registration cell and no index entry
    // anywhere.
    const orphan = async () => {
      await saveRegistration(
        runtime,
        serviceSpace,
        reg({ id: lost(), space, installId, owner: "did:key:zA" }),
      );
      const empty = { type: "array", items: { type: "string" } } as const;
      const cells = [
        "cf:ingest:index:2026-08",
        `cf:ingest:by-owner:did:key:zA`,
        `cf:ingest:by-space:${space}`,
      ].map((cause) =>
        runtime.getCell<string[]>(serviceSpace as never, cause, empty)
      );
      for (const c of cells) await c.sync();
      await runtime.storageManager.synced();
      const res = await runtime.editWithRetry((tx) => {
        for (const c of cells) c.withTx(tx).set([]);
      });
      expect(res.error).toBeUndefined();
    };

    it("is invisible to a plain audit", async () => {
      await orphan();
      expect(await getRegistrationIndex(runtime, serviceSpace)).not.toContain(
        lost(),
      );
      expect(await collectRows(runtime, serviceSpace)).toEqual([]);
    });

    it("is found and reindexed from the operator's provisioning record", async () => {
      // The id is derived from (space, installId), and the operator chose both
      // when they provisioned it — so their own record is an exact probe.

      await orphan();
      const candidates = recoverIds(
        `# a channel we know we handed out\n${space} ${installId}\n`,
      );
      expect(candidates).toEqual([lost()]);

      const rows = await collectRows(runtime, serviceSpace, true, candidates);
      expect(rows.map((r) => r.id)).toEqual([lost()]);

      // Reindexed, so every later audit finds it without the record.
      expect(await getRegistrationIndex(runtime, serviceSpace)).toContain(
        lost(),
      );
      expect((await collectRows(runtime, serviceSpace)).map((r) => r.id))
        .toEqual([lost()]);
    });

    it("reports a candidate that resolves to nothing by omitting it", async () => {
      const rows = await collectRows(runtime, serviceSpace, false, [
        channelId(space, "never-existed"),
      ]);
      expect(rows).toEqual([]);
    });

    it("refuses a malformed recovery record rather than guessing", () => {
      expect(() => recoverIds("did:key:zSpaceOnly\n")).toThrow("--recover");
    });
  });

  it("renders both human and JSON output", async () => {
    await saveRegistration(runtime, serviceSpace, reg({ owner: "did:key:zA" }));
    const rows = await collectRows(runtime, serviceSpace);

    const human = render(rows, false).join("\n");
    expect(human).toContain("ing_a");
    expect(human).toContain("1 channel(s), 1 active.");

    const json = JSON.parse(render(rows, true).join("\n"));
    expect(json.channels[0].id).toBe("ing_a");

    expect(render([], false).join("\n")).toContain("none.");
  });

  it("retires nothing unless confirmed", async () => {
    await saveRegistration(runtime, serviceSpace, reg());

    const dry = await retireChannels(runtime, serviceSpace, { reason: "why" });
    expect(dry.retired.length).toBe(1);

    // Dry run means dry: the registration is untouched.
    const stored = await getRegistration(runtime, serviceSpace, "ing_a");
    expect(stored?.enabled).toBe(true);
    expect(stored?.revoked).toBeUndefined();
  });

  it("retires with an attributable reason when confirmed", async () => {
    await saveRegistration(runtime, serviceSpace, reg());

    const done = await retireChannels(runtime, serviceSpace, {
      reason: "space-key-derivation-fix",
      confirm: true,
      now: new Date("2026-08-05T00:00:00.000Z"),
    });
    expect(done.retired.length).toBe(1);

    const stored = await getRegistration(runtime, serviceSpace, "ing_a");
    expect(stored?.enabled).toBe(false);
    // An operator retirement must stay distinguishable from a user's own
    // revoke in the trail.
    expect(stored?.revoked?.by).toBe("operator:space-key-derivation-fix");
    expect(stored?.revoked?.at).toBe("2026-08-05T00:00:00.000Z");
  });

  it("skips channels that are already revoked, and is idempotent", async () => {
    await saveRegistration(runtime, serviceSpace, reg());
    await retireChannels(runtime, serviceSpace, {
      reason: "first",
      confirm: true,
    });

    // Re-running is the documented remedy for the non-atomic window, so it has
    // to be safe: nothing retired again, and the original reason preserved.
    const again = await retireChannels(runtime, serviceSpace, {
      reason: "second",
      confirm: true,
    });
    expect(again.retired.length).toBe(0);
    expect(again.skipped).toBe(1);
    expect((await getRegistration(runtime, serviceSpace, "ing_a"))?.revoked?.by)
      .toBe("operator:first");
  });

  it("advances the revision so a stale write cannot undo a retirement", async () => {
    // A rotate that read the registration before the sweep reached it must not
    // still satisfy its own precondition afterwards and undo the retirement.

    await saveRegistration(runtime, serviceSpace, reg());
    const stale = await getRegistration(runtime, serviceSpace, "ing_a");

    await retireChannels(runtime, serviceSpace, {
      reason: "cutover",
      confirm: true,
    });

    await expect(
      saveRegistration(
        runtime,
        serviceSpace,
        { ...stale!, enabled: true, revision: (stale!.revision ?? 0) + 1 },
        stale!.revision ?? 0,
      ),
    ).rejects.toThrow();

    const after = await getRegistration(runtime, serviceSpace, "ing_a");
    expect(after?.enabled).toBe(false);
    expect(after?.revoked?.by).toBe("operator:cutover");
  });

  it("scopes to one space when asked", async () => {
    await saveRegistration(runtime, serviceSpace, reg());
    await saveRegistration(
      runtime,
      serviceSpace,
      reg({ id: "ing_b", space: "did:key:z6MkspaceBBBB" }),
    );

    const plan = await retireChannels(runtime, serviceSpace, {
      reason: "scoped",
      space: "did:key:z6MkspaceBBBB",
      confirm: true,
    });
    expect(plan.retired.map((r) => r.id)).toEqual(["ing_b"]);
    expect((await getRegistration(runtime, serviceSpace, "ing_a"))?.enabled)
      .toBe(true);
  });

  it("runAudit renders the whole command output", async () => {
    await saveRegistration(runtime, serviceSpace, reg({ owner: "did:key:zA" }));
    expect((await runAudit(runtime, serviceSpace, {})).join("\n")).toContain(
      "1 channel(s), 1 active.",
    );
    const json = JSON.parse(
      (await runAudit(runtime, serviceSpace, { json: true })).join("\n"),
    );
    expect(json.channels.length).toBe(1);
  });

  it("runRetire reports a dry run and a confirmed run differently", async () => {
    await saveRegistration(runtime, serviceSpace, reg());

    const dry = (await runRetire(runtime, serviceSpace, { reason: "r" }))
      .join("\n");
    expect(dry).toContain("would retire  ing_a");
    expect(dry).toContain("Would retire 1 channel(s); 0 already revoked.");
    expect(dry).toContain("Dry run — nothing written.");

    const done = (await runRetire(runtime, serviceSpace, {
      reason: "r",
      confirm: true,
    })).join("\n");
    expect(done).toContain("retiring  ing_a");
    expect(done).toContain("Retired 1 channel(s)");
    // The confirmed run has to tell the operator what owners do next.
    expect(done).toContain("cf ingest mint");
  });

  it("the usage text names the flag that makes the trail meaningful", () => {
    expect(USAGE).toContain("--reason");
    expect(USAGE).toContain("space-key-derivation-fix");
  });

  describe("entrypoints", () => {
    // The command entrypoints: argv parsing, the exit code, and the output
    // sink. Each gets its OWN runtime because `main` disposes what it is
    // handed, and a spread copy is not an option — `Runtime` reads private
    // class fields.

    const freshRuntime = async () => {
      const owner = await Identity.fromPassphrase(
        `entrypoint-${crypto.randomUUID()}`,
      );
      const sm = StorageManager.emulate({ as: owner });
      const rt = new Runtime({
        apiUrl: new URL("https://scripts-entry.invalid"),
        storageManager: sm,
      });
      return { rt, space: owner.did() };
    };

    it("the default runtime factories construct and dispose cleanly", async () => {
      // The factory each script uses when nobody injects one. Constructing it
      // opens no connection — sessions are created lazily on first space access
      // — so this stays a unit test while still pinning that the wiring is
      // valid.

      for (const make of [auditRuntime, retireRuntime]) {
        const rt = make();
        await rt.dispose();
      }
    });

    it("audit main parses --json and exits 0", async () => {
      const { rt, space } = await freshRuntime();
      await saveRegistration(rt, space, reg({ owner: "did:key:zA" }));
      const lines: string[] = [];
      expect(
        await auditMain(["--json"], () => rt, space, (l) => lines.push(l)),
      ).toBe(0);
      expect(JSON.parse(lines.join("\n")).channels.length).toBe(1);
    });

    it("retire main refuses without --reason and prints usage", async () => {
      // The reason is what makes the audit trail say WHY, so omitting it must
      // not quietly retire everything with a blank attribution.

      const { rt, space } = await freshRuntime();
      const errors: string[] = [];
      expect(
        await retireMain([], () => rt, space, () => {}, (l) => errors.push(l)),
      ).toBe(2);
      expect(errors.join("\n")).toContain("--reason");
      await rt.dispose();
    });

    it("retire main is a dry run by default and writes with --confirm", async () => {
      const dry = await freshRuntime();
      await saveRegistration(dry.rt, dry.space, reg());
      const lines: string[] = [];
      expect(
        await retireMain(
          ["--reason", "why"],
          () => dry.rt,
          dry.space,
          (l) => lines.push(l),
        ),
      ).toBe(0);
      expect(lines.join("\n")).toContain("Dry run — nothing written.");

      const wet = await freshRuntime();
      await saveRegistration(wet.rt, wet.space, reg());
      expect(
        await retireMain(
          ["--reason", "why", "--confirm"],
          () => wet.rt,
          wet.space,
          () => {},
        ),
      ).toBe(0);
    });
  });

  it("preserves revocation history across a retire cycle", async () => {
    // Values read back from a cell are deep-frozen and do not round-trip when
    // spread into a new object, so the history has to be rebuilt to survive a
    // second retirement.

    await saveRegistration(
      runtime,
      serviceSpace,
      reg({
        revocations: [{ at: "2026-07-01T00:00:00.000Z", by: "did:key:zA" }],
      }),
    );
    await retireChannels(runtime, serviceSpace, {
      reason: "keeps-history",
      confirm: true,
    });

    const stored = await getRegistration(runtime, serviceSpace, "ing_a");
    expect(stored?.revocations?.length).toBe(1);
    expect(stored?.revocations?.[0].by).toBe("did:key:zA");
  });

  describe("provision-ingest-channel", () => {
    // The break-glass path. It bypasses the ownership check entirely, so the
    // lifecycle state it carries forward is the only thing standing between an
    // operator re-provision and silently un-revoking a retired channel,
    // dropping its history, or issuing a credential that never expires.

    const SPACE = "did:key:z6MkspaceProvisionAAAA";
    const provision = (over: Record<string, unknown> = {}) =>
      provisionChannel(runtime, serviceSpace, {
        space: SPACE,
        installId: "phone-1",
        ...over,
      });

    it("refuses bad input before touching storage", async () => {
      for (
        const bad of [
          { space: "" },
          { space: "not-a-did" },
          { installId: "bad id" },
          { installId: "." },
          { causePrefix: ".." },
        ]
      ) {
        const outcome = await provision(bad);
        expect(outcome.ok, JSON.stringify(bad)).toBe(false);
        expect(outcome.ok === false && outcome.code).toBe(2);
      }
      expect(await getRegistrationIndex(runtime, serviceSpace)).toEqual([]);
    });

    it("always sets an expiry, so break-glass cannot mint a forever token", async () => {
      expect((await provision()).ok).toBe(true);
      const stored = await getRegistration(
        runtime,
        serviceSpace,
        channelId(SPACE, "phone-1"),
      );
      expect(stored?.expiresAt).toBeDefined();
      expect(Date.parse(stored!.expiresAt!)).toBeGreaterThan(Date.now());
    });

    it("carries lifecycle state forward and records the rotation", async () => {
      const id = channelId(SPACE, "phone-y");
      await saveRegistration(
        runtime,
        serviceSpace,
        reg({
          id,
          space: SPACE,
          installId: "phone-y",
          secretHash: "old-hash",
          owner: "did:key:zOwner",
          enabled: false,
          revoked: { at: "2026-08-02T00:00:00.000Z", by: "did:key:zRevoker" },
          revision: 4,
        }),
      );

      expect((await provision({ installId: "phone-y" })).ok).toBe(true);
      const after = await getRegistration(runtime, serviceSpace, id);
      // Re-authorized, but the record of the revocation survives...
      expect(after?.enabled).toBe(true);
      expect(after?.revoked).toBeUndefined();
      expect(after?.revocations?.length).toBe(1);
      expect(after?.revocations?.[0].by).toBe("did:key:zRevoker");
      // ...along with the owner, so it stays in that owner's list...
      expect(after?.owner).toBe("did:key:zOwner");
      // ...and the re-pair signal, so the old device gets 403 not a blank 401.
      expect(after?.previousSecretHash).toBe("old-hash");
      expect(after?.revision).toBe(5);
    });

    it("refuses to repoint an existing channel's cause-prefix without --force", async () => {
      const id = channelId(SPACE, "phone-z");
      expect((await provision({ installId: "phone-z" })).ok).toBe(true);
      const blocked = await provision({
        installId: "phone-z",
        causePrefix: "elsewhere",
      });
      expect(blocked.ok).toBe(false);
      expect(blocked.ok === false && blocked.message).toContain("--force");
      expect((await getRegistration(runtime, serviceSpace, id))?.causePrefix)
        .toBe("location");

      // --force repoints it, which is the documented escape hatch.
      expect(
        (await provision({
          installId: "phone-z",
          causePrefix: "elsewhere",
          force: true,
        })).ok,
      ).toBe(true);
      expect((await getRegistration(runtime, serviceSpace, id))?.causePrefix)
        .toBe("elsewhere");
    });

    it("fails visibly instead of overwriting a concurrent write", async () => {
      // A trusted action should conflict visibly rather than silently undo a
      // security action someone else just took. Two provisions racing the same
      // channel both read one revision and both write against it, so exactly
      // one must lose — which is the code-1 branch.

      const id = channelId(SPACE, "phone-race");
      await saveRegistration(
        runtime,
        serviceSpace,
        reg({ id, space: SPACE, installId: "phone-race", revision: 2 }),
      );

      // A barrier, so the interleaving is forced rather than hoped for. Both
      // provisions must finish READING before either is allowed to WRITE —
      // otherwise a fast first call completes outright, the second reads the
      // revision it just wrote, and both succeed. `saveRegistration` is the
      // only thing that reaches `editWithRetry`, so holding there holds
      // exactly at the read/write seam.
      let arrived = 0;
      let release!: () => void;
      const bothHaveRead = new Promise<void>((r) => (release = r));
      const barrier = new Proxy(runtime, {
        get(target, prop, receiver) {
          if (prop === "editWithRetry") {
            return async (...args: unknown[]) => {
              if (++arrived === 2) release();
              await bothHaveRead;
              return await (target as unknown as {
                editWithRetry: (...a: unknown[]) => Promise<unknown>;
              }).editWithRetry(...args);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as typeof runtime;

      const race = (installId: string) =>
        provisionChannel(barrier, serviceSpace, { space: SPACE, installId });
      const outcomes = await Promise.all([
        race("phone-race"),
        race("phone-race"),
      ]);
      const won = outcomes.filter((o) => o.ok);
      const lost = outcomes.filter((o) => !o.ok);
      expect(won.length).toBe(1);
      expect(lost.length).toBe(1);
      const loser = lost[0];
      expect(loser.ok === false && loser.code).toBe(1);
      expect(loser.ok === false && loser.message).toContain(
        "Nothing was written",
      );

      // One write landed, not two.
      expect((await getRegistration(runtime, serviceSpace, id))?.revision)
        .toBe(3);
    });

    it("preserves a revocation it re-authorizes over", async () => {
      // Distinct from the race above: re-provisioning a channel someone has
      // already revoked is allowed — it is an operator re-authorizing it — but
      // the record of that revocation has to survive.

      const id = channelId(SPACE, "phone-revoked");
      await saveRegistration(
        runtime,
        serviceSpace,
        reg({ id, space: SPACE, installId: "phone-revoked", revision: 2 }),
      );
      const stale = await getRegistration(runtime, serviceSpace, id);
      await saveRegistration(
        runtime,
        serviceSpace,
        {
          ...stale!,
          enabled: false,
          revoked: { at: "2026-08-03T00:00:00.000Z", by: "did:key:zAlice" },
          revision: 3,
        },
        2,
      );

      expect((await provision({ installId: "phone-revoked" })).ok).toBe(true);
      const after = await getRegistration(runtime, serviceSpace, id);
      expect(after?.enabled).toBe(true);
      expect(after?.revision).toBe(4);
      expect(after?.revocations?.[0].by).toBe("did:key:zAlice");
    });

    it("rejects bad input without ever constructing a runtime", async () => {
      // Building a runtime reads MEMORY_URL, so validating after it turned a
      // plain usage error into an uncaught construction failure — the two
      // things an operator most needs to tell apart.

      const errors: string[] = [];
      const explode = () => {
        throw new Error("runtime must not be constructed for invalid input");
      };
      for (const args of [[], ["--space", "nope", "--install-id", "a"]]) {
        expect(
          await provisionMain(
            args,
            explode,
            "did:key:zX",
            () => {},
            (l) => errors.push(l),
          ),
        ).toBe(2);
      }
      expect(errors.length).toBe(2);
    });

    it("main returns 2 and prints usage with no arguments", async () => {
      const errors: string[] = [];
      const owner = await Identity.fromPassphrase(
        `prov-${crypto.randomUUID()}`,
      );
      const sm = StorageManager.emulate({ as: owner });
      const rt = new Runtime({
        apiUrl: new URL("https://provision-entry.invalid"),
        storageManager: sm,
      });
      expect(
        await provisionMain(
          [],
          () => rt,
          owner.did(),
          () => {},
          (l) => errors.push(l),
        ),
      ).toBe(2);
      expect(errors.join("\n")).toContain("--install-id");
    });
  });
});
