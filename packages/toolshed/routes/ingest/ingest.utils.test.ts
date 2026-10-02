import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { type MemorySpace, parseLink, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import {
  appendToJournal,
  channelId,
  generateIngestSecret,
  getLastSeen,
  getRegistration,
  getRegistrationIndex,
  type IngestRegistration,
  isValidPartition,
  journalCell,
  MAX_BATCH,
  peekMintRequest,
  processIngest,
  saveRegistration,
  verifyIngestSecret,
} from "./ingest.utils.ts";

// Golden cell id for cause "location/2026-07-01" — pins the cross-repo cell
// address so a `FabricHash`-format change fails CI loudly (loom recomputes it).
const GOLDEN_ID = "of:fid1:d7_RmD4fNpTUheithVm0Q1Vha0Rn32c06qA_hOHE8x8";

// Golden channel id — rotate-in-place is a security property, so pin the exact
// derivation: a drift means "rotation" mints a NEW registration and leaves the
// old token live. A failure = coordinate a change, never just update the
// literal.
const GOLDEN_CHANNEL_ID = "ing_jMjaGfRO0Kg0BUegs9mzwImZ-CKcmlVw-wDbmV41_bs";

describe("ingest journal sink", () => {
  // The journal sink is the security-critical write path (durable, marked, into
  // a caller-provided space). These exercise it directly against an emulated
  // store (no ACL layer — see the cross-space test's caveat).

  let signer: Identity;
  let space: ReturnType<Identity["did"]>;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("ingest-test");
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://ingest-test.invalid"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  const ingestMarks = (docSpace: string, id: string): unknown[] => {
    const replica = storageManager.open(docSpace as MemorySpace)
      .replica as unknown as {
        getDocument(id: string): {
          cfc?: {
            labelMap?: {
              entries: { origin?: string; label: { integrity?: unknown[] } }[];
            };
          };
        } | undefined;
      };
    return (replica.getDocument(id)?.cfc?.labelMap?.entries ?? [])
      .filter((e) => e.origin === "external-ingest")
      .flatMap((e) => e.label.integrity ?? []);
  };
  const markType = (atom: unknown) => (atom as { type?: string })?.type;

  const reg = (
    overrides: Partial<IngestRegistration> = {},
  ): IngestRegistration => ({
    id: "ing_test",
    name: "test",
    space,
    causePrefix: "location",
    installId: "install-1",
    sink: "journal",
    secretHash: "unused",
    createdBy: space,
    createdAt: "2026-07-01T00:00:00.000Z",
    enabled: true,
    ...overrides,
  });

  it("durably appends records to a partition cell and mints the mark", async () => {
    const r = reg();
    await appendToJournal(runtime, r, "2026-07-01", [
      { point_id: "a", ts: 1 },
      { point_id: "b", ts: 2 },
    ]);

    const cell = journalCell(runtime, r, "2026-07-01");
    await cell.sync();
    expect(cell.get()).toEqual([{ point_id: "a", ts: 1 }, {
      point_id: "b",
      ts: 2,
    }]);

    const marks = ingestMarks(space, cell.getAsNormalizedFullLink().id);
    expect(marks.length).toBe(1);
    expect(markType(marks[0])).toBe(CFC_ATOM_TYPE.ExternalIngest);
    expect(marks[0]).toMatchObject({ channel: space, audience: "install-1" });
  });

  it("stores records value-for-value after JSON parse — no labs-added fields, strings kept", async () => {
    const r = reg();
    // lat/lng as exact decimal strings: labs must not reparse to float (values
    // round-trip through JSON unchanged; NOT raw-byte identical — the digest is
    // over the JSON serialization).
    const point = {
      point_id: "p1",
      ts: 123,
      lat: "37.123456",
      lng: "-122.654321",
      accuracy_m: 5,
      extra: { nested: true },
    };
    await appendToJournal(runtime, r, "2026-07-02", [point]);

    const cell = journalCell(runtime, r, "2026-07-02");
    await cell.sync();
    expect(cell.get()).toEqual([point]);
  });

  it("a never-written partition cell reads back ABSENT (undefined), not []", async () => {
    // The load-bearing tri-state invariant: absent (never captured) must be
    // distinguishable from empty. The schema must not inject a [] default.

    const cell = journalCell(runtime, reg(), "1999-01-01");
    await cell.sync();
    expect(cell.get()).toBeUndefined();
  });

  it("distinct partitions land in distinct cells", async () => {
    const r = reg();
    await appendToJournal(runtime, r, "2026-07-01", [{ point_id: "a" }]);
    await appendToJournal(runtime, r, "2026-07-02", [{ point_id: "b" }]);

    const c1 = journalCell(runtime, r, "2026-07-01");
    const c2 = journalCell(runtime, r, "2026-07-02");
    await c1.sync();
    await c2.sync();

    expect(c1.get()).toEqual([{ point_id: "a" }]);
    expect(c2.get()).toEqual([{ point_id: "b" }]);
    expect(c1.getAsNormalizedFullLink().id).not.toBe(
      c2.getAsNormalizedFullLink().id,
    );
  });

  it("writes into a DIFFERENT principal's space and marks it", async () => {
    // Mechanism proof: the operator runtime targets the registered (foreign)
    // space and mints there. CAVEAT: emulate has NO ACL layer, so this does NOT
    // prove a production memory server AUTHORIZES the cross-space commit — that
    // is the deploy-time probe (MEMORY_ACL_MODE), not a unit test.

    const other = await Identity.fromPassphrase("some-other-user");
    const otherSpace = other.did();
    const r = reg({ space: otherSpace, installId: "install-2" });

    await appendToJournal(runtime, r, "2026-07-01", [{ point_id: "z" }]);

    const cell = journalCell(runtime, r, "2026-07-01");
    await cell.sync();
    expect(cell.get()).toEqual([{ point_id: "z" }]);

    const marks = ingestMarks(otherSpace, cell.getAsNormalizedFullLink().id);
    expect(marks.length).toBe(1);
    expect(marks[0]).toMatchObject({
      channel: otherSpace,
      audience: "install-2",
    });
  });

  it("concurrent appends to the same partition don't lose each other", async () => {
    const r = reg();
    await Promise.all([
      appendToJournal(runtime, r, "2026-07-03", [{ point_id: "a" }]),
      appendToJournal(runtime, r, "2026-07-03", [{ point_id: "b" }]),
      appendToJournal(runtime, r, "2026-07-03", [{ point_id: "c" }]),
    ]);

    const cell = journalCell(runtime, r, "2026-07-03");
    await cell.sync();
    const ids = (cell.get() as { point_id: string }[]).map((p) => p.point_id)
      .sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("leaves the documents of earlier records in place when appending", async () => {
    // Each record in a journal is a document of its own, and the journal
    // cell holds a link to each. An append that wrote the earlier records
    // again would store every one of them under a new id on every POST, and
    // leave the copies it replaced behind.

    const r = reg();
    const cell = journalCell(runtime, r, "2026-07-06");
    const recordIds = async (): Promise<(string | undefined)[]> => {
      await cell.sync();
      const links = (cell.getRaw() ?? []) as readonly unknown[];
      return links.map((link) => parseLink(link, cell)?.id);
    };

    await appendToJournal(runtime, r, "2026-07-06", [{ point_id: "a" }]);
    const [first] = await recordIds();
    await appendToJournal(runtime, r, "2026-07-06", [
      { point_id: "b" },
      { point_id: "c" },
    ]);

    const after = await recordIds();
    expect(typeof first).toBe("string");
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(first);
    expect(new Set(after).size).toBe(3);
    expect(cell.get()).toEqual([
      { point_id: "a" },
      { point_id: "b" },
      { point_id: "c" },
    ]);
  });

  it("validates the partition segment", () => {
    expect(isValidPartition("2026-07-01")).toBe(true);
    expect(isValidPartition("v1.2_beta-3")).toBe(true);
    for (const bad of ["a/b", "", "x".repeat(65), "a b", "foo\tbar", "💥"]) {
      expect(isValidPartition(bad)).toBe(false);
    }
  });

  it("verifies bearer secrets in constant time", () => {
    const { secret, secretHash } = generateIngestSecret();
    expect(verifyIngestSecret(secret, secretHash)).toBe(true);
    expect(verifyIngestSecret("ingsec_wrong", secretHash)).toBe(false);
    expect(verifyIngestSecret(secret, "A".repeat(secretHash.length))).toBe(
      false,
    );
  });

  it("channelId is deterministic per (space, installId) — re-provisioning rotates in place", () => {
    const a = channelId("did:key:space1", "install-1");
    expect(channelId("did:key:space1", "install-1")).toBe(a);
    expect(channelId("did:key:space1", "install-2")).not.toBe(a);
    expect(channelId("did:key:space2", "install-1")).not.toBe(a);
    expect(a.startsWith("ing_")).toBe(true);
    // Pinned derivation (see GOLDEN_CHANNEL_ID).
    expect(a).toBe(GOLDEN_CHANNEL_ID);
  });

  it("round-trips a registration in the service space", async () => {
    const r = reg({ id: "ing_rt", secretHash: "abc123" });
    await saveRegistration(runtime, space, r);
    expect(await getRegistration(runtime, space, "ing_rt")).toEqual(r);
    expect(await getRegistration(runtime, space, "ing_missing")).toBeNull();
  });

  it("day-cell id is a stable function of the cause (cross-repo golden id)", async () => {
    // loom READS by recomputing this exact id from the cause string. If the
    // `FabricHash` format changes, this literal breaks CI loudly instead of
    // silently orphaning loom's reader.

    const cell = journalCell(runtime, reg(), "2026-07-01");
    await cell.sync();
    expect(cell.getAsNormalizedFullLink().id).toBe(GOLDEN_ID);
  });

  //
  // processIngest: the auth and validation contract
  //
  // Over the two helpers below. The claim on a request id that its writes
  // rest on is pinned in its own block within this region.
  //

  const savedReg = async (
    overrides: Partial<IngestRegistration> = {},
  ): Promise<{ r: IngestRegistration; secret: string }> => {
    const { secret, secretHash } = generateIngestSecret();
    const r = reg({ id: "ing_auth", secretHash, ...overrides });
    await saveRegistration(runtime, space, r);
    return { r, secret };
  };

  // Mirror the handler: serialize the body to JSON and let processIngest parse
  // it (after auth). `rt` overridable for the storage-error case.
  const call = (
    id: string,
    token: string,
    body: unknown,
    rt: Runtime = runtime,
  ) => processIngest(rt, space, id, token, JSON.stringify(body));

  it("processIngest: unknown / disabled / wrong-token all -> identical 401", async () => {
    const { r } = await savedReg({ id: "ing_ok" });
    await saveRegistration(
      runtime,
      space,
      reg({ id: "ing_off", secretHash: "unused", enabled: false }),
    );

    const unknown = await call("ing_unknown", "t", {
      partition: "2026-07-01",
      records: [{ x: 1 }],
    });
    const disabled = await call("ing_off", "t", {
      partition: "2026-07-01",
      records: [{ x: 1 }],
    });
    const wrong = await call("ing_ok", "ingsec_nope", {
      partition: "2026-07-01",
      records: [{ x: 1 }],
    });

    for (const res of [unknown, disabled, wrong]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Invalid request" });
    }
    // A wrong token wrote nothing.
    const cell = journalCell(runtime, r, "2026-07-01");
    await cell.sync();
    expect(cell.get()).toBeUndefined();
  });

  it("processIngest: storage lookup error -> 502 (not 401)", async () => {
    const broken = {
      getCell() {
        throw new Error("boom");
      },
    } as unknown as Runtime;
    const res = await call("ing_x", "t", {
      partition: "d",
      records: [{ x: 1 }],
    }, broken);
    expect(res.status).toBe(502);
  });

  it("processIngest: valid token -> 200 and durably appends", async () => {
    const { r, secret } = await savedReg({ id: "ing_write" });
    const res = await call("ing_write", secret, {
      partition: "2026-07-05",
      records: [{ point_id: "a" }, { point_id: "b" }],
    });
    expect(res).toEqual({ status: 200, body: { received: 2, appended: 2 } });
    const cell = journalCell(runtime, r, "2026-07-05");
    await cell.sync();
    expect(cell.get()).toEqual([{ point_id: "a" }, { point_id: "b" }]);
  });

  it("processIngest: hostile / missing partition -> 400, no write", async () => {
    const { secret } = await savedReg({ id: "ing_part" });
    for (const bad of ["../x", "", "a/b", "..", "."]) {
      const res = await call("ing_part", secret, {
        partition: bad,
        records: [{ x: 1 }],
      });
      expect(res.status).toBe(400);
    }
    const missing = await call("ing_part", secret, {
      records: [{ x: 1 }],
    });
    expect(missing.status).toBe(400);
  });

  it("processIngest: bad records shape -> 400", async () => {
    const { secret } = await savedReg({ id: "ing_rec" });
    const bodies: unknown[] = [
      { partition: "d", records: [] },
      { partition: "d", records: "nope" },
      { partition: "d", records: [1, 2] },
      { partition: "d", records: [null] },
      { partition: "d", records: [["nested"]] },
      { partition: "d" },
    ];
    for (const body of bodies) {
      const res = await call("ing_rec", secret, body);
      expect(res.status).toBe(400);
    }
  });

  it("processIngest: over-cap batch -> 413", async () => {
    const { secret } = await savedReg({ id: "ing_cap" });
    const records = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ i }));
    const res = await call("ing_cap", secret, {
      partition: "2026-07-06",
      records,
    });
    expect(res.status).toBe(413);
  });

  it("processIngest: a link sigil anywhere in a record -> 400, nothing written", async () => {
    // A link sigil is a non-null, non-array object, so it satisfies the entire
    // record contract — and the runtime interprets it on WRITE, storing a live
    // reference instead of the text. That would make journal entries mutable
    // after the fact and leave the ExternalIngest mark attesting to a digest of
    // the sigil rather than to anything a reader resolves through it.

    const { secret } = await savedReg({ id: "ing_sigil" });
    const link = {
      "/": {
        "link@1": {
          id: "of:somewhere-else",
          space,
          path: [],
        },
      },
    };

    for (
      const [where, records] of [
        ["the record itself", [link]],
        ["a nested value", [{ reading: link }]],
        ["inside an array", [{ readings: [1, link] }]],
        ["buried deep", [{ a: { b: { c: [{ d: link }] } } }]],
        ["one record among valid ones", [{ x: 1 }, { y: link }, { z: 3 }]],
      ] as const
    ) {
      const res = await call("ing_sigil", secret, {
        partition: "2026-07-07",
        records,
      });
      expect(res.status, `link in ${where}`).toBe(400);
    }

    // Nothing from any of those attempts landed.
    const stored = journalCell(
      runtime,
      await getRegistration(runtime, space, "ing_sigil") as IngestRegistration,
      "2026-07-07",
    );
    await stored.sync();
    await runtime.storageManager.synced();
    expect(stored.get()).toBeUndefined();

    // And an ordinary record on the same channel still works, so the check
    // rejects links rather than anything object-shaped.
    const ok = await call("ing_sigil", secret, {
      partition: "2026-07-07",
      records: [{ nested: { deep: [1, 2, { fine: true }] } }],
    });
    expect(ok.status).toBe(200);
  });

  it("processIngest: bad token + malformed body stays a uniform 401 (not 400)", async () => {
    await savedReg({ id: "ing_mal" });
    // Malformed JSON with a wrong token must NOT leak a 400 — auth runs first.
    const res = await processIngest(
      runtime,
      space,
      "ing_mal",
      "ingsec_wrong",
      "{not json",
    );
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid request" });
  });

  it("processIngest: valid token + malformed body -> 400", async () => {
    const { secret } = await savedReg({ id: "ing_mal2" });
    const res = await processIngest(
      runtime,
      space,
      "ing_mal2",
      secret,
      "{not json",
    );
    expect(res.status).toBe(400);
  });

  const REPAIR_BODY = { partition: "2026-07-01", records: [{ x: 1 }] };

  describe("the 403 re-pair departure", () => {
    // The one deliberate departure from blanket 401 equalization. It is
    // reachable ONLY with a correct token, so it leaks nothing to a guesser —
    // and it is what lets a beacon that was offline across a rotation know to
    // re-pair instead of dropping its buffer or retrying a "broken server"
    // forever.

    it("processIngest: VALID token + disabled -> 403 re-pair, no write", async () => {
      const { secret, r } = await savedReg({ id: "ing_dis" });
      await saveRegistration(runtime, space, { ...r, enabled: false });

      const res = await call("ing_dis", secret, REPAIR_BODY);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).toContain("re-pair");

      const cell = journalCell(runtime, r, "2026-07-01");
      await cell.sync();
      expect(cell.get()).toBeUndefined();
    });

    it("processIngest: VALID token + revoked -> 403 re-pair", async () => {
      const { secret, r } = await savedReg({ id: "ing_rev" });
      await saveRegistration(runtime, space, {
        ...r,
        enabled: false,
        revoked: { at: new Date().toISOString(), by: "did:key:zOwner" },
      });
      expect((await call("ing_rev", secret, REPAIR_BODY)).status).toBe(403);
    });

    it("processIngest: VALID token + past expiresAt -> 403, no write", async () => {
      const { secret, r } = await savedReg({ id: "ing_exp" });
      await saveRegistration(runtime, space, {
        ...r,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });

      const res = await call("ing_exp", secret, REPAIR_BODY);
      expect(res.status).toBe(403);

      const cell = journalCell(runtime, r, "2026-07-01");
      await cell.sync();
      expect(cell.get()).toBeUndefined();
    });

    it("processIngest: VALID token + unparseable expiresAt -> 403 (fails closed)", async () => {
      // A corrupted expiry must not silently become "no expiry": Date.parse
      // yields NaN and every NaN comparison is false, so the naive check fails
      // OPEN.

      const { secret, r } = await savedReg({ id: "ing_nan" });
      await saveRegistration(runtime, space, { ...r, expiresAt: "not-a-date" });
      expect((await call("ing_nan", secret, REPAIR_BODY)).status).toBe(403);
    });
  });

  describe("request claims", () => {
    // A request id is consumed by the transaction that writes the registration,
    // so it is spent only by a write that actually landed.

    // A fixed clock: `peekMintRequest` defaults to real time, so a claim
    // written at this instant would otherwise read as long expired and the
    // assertions would pass for the wrong reason.
    const NOW = 1_000_000;

    const claimed = (
      id: string,
      requestId: string,
      owner = "did:key:zA",
      now = NOW,
    ) =>
      saveRegistration(
        runtime,
        space,
        reg({ id, owner, revision: 1 }),
        null,
        { owner, requestId, channel: id, now },
      );

    it("rejects a replay and names the channel the id was used for", async () => {
      await claimed("ing_first", "r1");
      // A different channel, same id: the error must name the ORIGINAL.
      await expect(claimed("ing_second", "r1")).rejects.toThrow(
        /ing_first/,
      );
    });

    it("forgets a claim once it falls outside the replay window", async () => {
      await claimed("ing_a", "r1");
      const later = NOW + 60 * 60_000;
      expect(
        await peekMintRequest(runtime, space, "did:key:zA", "r1", later),
      ).toBeNull();
    });

    it("scopes claims per owner", async () => {
      await claimed("ing_a", "same", "did:key:zA");
      // A different owner is unaffected by the first one's ids.
      await claimed("ing_b", "same", "did:key:zB");
      expect(await peekMintRequest(runtime, space, "did:key:zB", "same", NOW))
        .toBe("ing_b");
      // ...and the first owner's id is still theirs.
      expect(await peekMintRequest(runtime, space, "did:key:zA", "same", NOW))
        .toBe("ing_a");
    });

    it("does not consume the id when the write is refused", async () => {
      // The point of doing this inside the transaction: a write that loses its
      // precondition must not consume the id, or the idempotency key becomes
      // the one thing that does not survive the failure it exists to make
      // retryable.

      await saveRegistration(runtime, space, reg({ id: "ing_x", revision: 1 }));

      // Precondition says "must not exist", but it does — so this loses.
      await expect(
        saveRegistration(
          runtime,
          space,
          reg({ id: "ing_x", owner: "did:key:zA", revision: 1 }),
          null,
          {
            owner: "did:key:zA",
            requestId: "r-retry",
            channel: "ing_x",
            now: NOW,
          },
        ),
      ).rejects.toThrow();

      // The id is still free, so an honest retry works.
      expect(
        await peekMintRequest(runtime, space, "did:key:zA", "r-retry", NOW),
      ).toBeNull();
    });
  });

  it("processIngest: VALID token + future expiresAt -> 200", async () => {
    const { secret, r } = await savedReg({ id: "ing_live" });
    await saveRegistration(runtime, space, {
      ...r,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect((await call("ing_live", secret, REPAIR_BODY)).status).toBe(200);
  });

  it("processIngest: WRONG token + disabled -> still an equalized 401", async () => {
    // The equalization that MUST survive: a guesser probing a disabled channel
    // still cannot distinguish it from an unknown one.

    const { r } = await savedReg({ id: "ing_dis2" });
    await saveRegistration(runtime, space, { ...r, enabled: false });

    const disabled = await call("ing_dis2", "ingsec_nope", REPAIR_BODY);
    const unknown = await call("ing_nosuch", "ingsec_nope", REPAIR_BODY);
    expect(disabled.status).toBe(401);
    expect(disabled.body).toEqual(unknown.body);
  });

  it("processIngest: wrong-sink channel -> identical 401, no write", async () => {
    const { secret, r } = await savedReg({ id: "ing_stream" });
    // Force a non-journal sink at rest (a future stream channel).
    await saveRegistration(runtime, space, {
      ...r,
      sink: "stream",
    } as unknown as IngestRegistration);
    const res = await call("ing_stream", secret, {
      partition: "2026-07-01",
      records: [{ x: 1 }],
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid request" });
    const cell = journalCell(runtime, r, "2026-07-01");
    await cell.sync();
    expect(cell.get()).toBeUndefined();
  });

  //
  // Registration and last-seen bookkeeping
  //

  it("saveRegistration indexes ids exactly once", async () => {
    await saveRegistration(runtime, space, reg({ id: "ing_i1" }));
    await saveRegistration(runtime, space, reg({ id: "ing_i2" }));
    await saveRegistration(runtime, space, reg({ id: "ing_i1" })); // re-provision
    const idx = await getRegistrationIndex(runtime, space);
    expect(idx.filter((x) => x === "ing_i1").length).toBe(1);
    expect(idx).toContain("ing_i1");
    expect(idx).toContain("ing_i2");
  });

  it("last-seen bumps on successful ingest, unchanged on auth failure", async () => {
    const { secret } = await savedReg({ id: "ing_seen" });
    expect(await getLastSeen(runtime, space, "ing_seen")).toBeNull();

    const ok = await call("ing_seen", secret, {
      partition: "2026-07-07",
      records: [{ x: 1 }],
    });
    expect(ok.status).toBe(200);
    const seen = await getLastSeen(runtime, space, "ing_seen");
    expect(seen).not.toBeNull();
    expect(Number.isNaN(Date.parse(seen as string))).toBe(false);

    // A wrong token must not touch last-seen.
    await call("ing_seen", "ingsec_wrong", {
      partition: "2026-07-07",
      records: [{ x: 1 }],
    });
    expect(await getLastSeen(runtime, space, "ing_seen")).toBe(seen);
  });
});
