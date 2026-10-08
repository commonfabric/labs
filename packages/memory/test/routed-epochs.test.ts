/** Durable link epochs and revocations: a router cannot revive client authority. */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { stub } from "@std/testing/mock";
import { RoutedEpochStore } from "../v2/routed-epochs.ts";
import { ROUTED_PROOF_HORIZON_SECONDS } from "../v2/routed-wire.ts";
const MIB = 1024 * 1024;
const RETENTION = ROUTED_PROOF_HORIZON_SECONDS;
const epoch = (i: number) => i.toString(16).padStart(32, "0");

Deno.test("a restart keeps epochs and revocations and drops an earlier ledger's claims", async () => {
  const directory = Deno.makeTempDirSync(), path = `${directory}/ledger`;
  const [router, revoked] = await Promise.all(
    [81, 82].map(async (seed) =>
      (await Identity.fromRaw(new Uint8Array(32).fill(seed))).did()
    ),
  );
  const now = Math.floor(Date.now() / 1000);
  // A ledger as an earlier toolshed left it, with a client proof recorded.
  const claim = JSON.stringify([
    "claim",
    router,
    "stage-test",
    revoked,
    "11".repeat(32),
    "22".repeat(32),
    epoch(1),
    "44".repeat(16),
    now + 600,
    false,
  ]);
  Deno.writeTextFileSync(
    path,
    `${JSON.stringify(["epoch", router, epoch(1)])}\n${claim}\n`,
  );
  let store = new RoutedEpochStore(path);
  try {
    assert(!Deno.readTextFileSync(path).includes('"claim"'));
    // The epoch closed with the restart and stays unusable for the
    // retention period.
    assertThrows(() => store.consume(router, epoch(1), now));
    store.consume(router, epoch(2), now);
    store.consume(revoked, epoch(3), now);
    store.revoke(revoked);
    assertThrows(() => store.consume(revoked, epoch(4), now));
    store.close();
    store = new RoutedEpochStore(path);
    assertThrows(() => store.consume(router, epoch(1), now));
    assertThrows(() => store.consume(router, epoch(2), now));
    assertThrows(() => store.consume(revoked, epoch(4), now));
    assert(store.revoked(revoked) && !store.revoked(router));
    store.consume(router, epoch(5), now);
  } finally {
    store.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("epoch compaction remains restartable and durability failure stays latched", async () => {
  const directory = Deno.makeTempDirSync(), path = `${directory}/ledger`;
  const router = (await Identity.fromRaw(new Uint8Array(32).fill(85))).did();
  let store = new RoutedEpochStore(path);
  try {
    store.consume(router, "11".repeat(16));
    const record = Deno.readTextFileSync(path);
    const fill = () =>
      Deno.writeTextFileSync(
        path,
        record.repeat(Math.ceil(17 * MIB / record.length)),
        { append: true },
      );
    fill();
    store.consume(router, "55".repeat(16));
    assert(Deno.statSync(path).size < MIB);
    store.close();
    store = new RoutedEpochStore(path);
    assertThrows(() => store.consume(router, "55".repeat(16)));
    fill();
    Deno.mkdirSync(`${path}.next`);
    assertThrows(() => store.consume(router, "66".repeat(16)));
    assertEquals(store.healthy, false);
    Deno.removeSync(`${path}.next`);
    assertThrows(() => store.consume(router, "77".repeat(16)));
  } finally {
    store.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("truncated authority ledger fails closed", () => {
  const directory = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(`${directory}/ledger`, '["epoch"');
    assertThrows(() => new RoutedEpochStore(`${directory}/ledger`));
  } finally {
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("failed durable ledger replacement leaves authority fail-closed", async () => {
  const directory = Deno.makeTempDirSync(), path = `${directory}/ledger`;
  const router = (await Identity.fromRaw(new Uint8Array(32).fill(87))).did();
  const store = new RoutedEpochStore(path);
  try {
    store.consume(router, "11".repeat(16));
    const record = Deno.readTextFileSync(path);
    Deno.writeTextFileSync(
      path,
      record.repeat(Math.ceil(17 * 1024 * 1024 / record.length)),
      { append: true },
    );
    using _replacement = stub(Deno, "renameSync", () => {
      throw new Deno.errors.PermissionDenied(
        "Injected durable replacement failure",
      );
    });
    assertThrows(
      () => store.consume(router, "22".repeat(16)),
      Deno.errors.PermissionDenied,
    );
    assertEquals(store.healthy, false);
    assertThrows(() => store.consume(router, "33".repeat(16)));
  } finally {
    store.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("closed link epochs are forgotten once every proof bound to them expired", async () => {
  const directory = Deno.makeTempDirSync(), path = `${directory}/ledger`;
  const router = (await Identity.fromRaw(new Uint8Array(32).fill(88))).did();
  const now = Math.floor(Date.now() / 1000);
  let store = new RoutedEpochStore(path);
  try {
    for (let i = 0; i < 1024; i++) {
      store.consume(router, epoch(i), now);
      store.retire(router, epoch(i), now);
    }
    // A live or recently closed epoch is never reused, and the bound holds.
    assertThrows(() => store.consume(router, epoch(5), now + RETENTION - 1));
    assertThrows(() => store.consume(router, epoch(1024), now + RETENTION - 1));
    // After the retention period the closed epochs free the bound.
    store.consume(router, epoch(1024), now + RETENTION);
    store.consume(router, epoch(5), now + RETENTION);
    store.close();
    // Retirement times survive restart. Epoch 7 closed long ago, epoch 8 just
    // now; no link survives a restart, so the live epoch 9 retires at load.
    store = new RoutedEpochStore(`${directory}/second`);
    for (const i of [7, 8, 9]) store.consume(router, epoch(i), now);
    store.retire(router, epoch(7), now - RETENTION - 1);
    store.retire(router, epoch(8), now);
    store.close();
    store = new RoutedEpochStore(`${directory}/second`);
    store.consume(router, epoch(7), now);
    assertThrows(() => store.consume(router, epoch(8), now));
    assertThrows(() => store.consume(router, epoch(9), now));
    // It retired when the store loaded, a moment after `now`.
    store.consume(
      router,
      epoch(9),
      Math.floor(Date.now() / 1000) + RETENTION + 1,
    );
  } finally {
    store.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("a ledger from before retirement records retires its epochs at load", async () => {
  const directory = Deno.makeTempDirSync(), path = `${directory}/ledger`;
  const router = (await Identity.fromRaw(new Uint8Array(32).fill(90))).did();
  Deno.writeTextFileSync(
    path,
    Array.from(
      { length: 1024 },
      (_, i) => `${JSON.stringify(["epoch", router, epoch(i)])}\n`,
    ).join(""),
  );
  const store = new RoutedEpochStore(path);
  try {
    const loaded = Math.floor(Date.now() / 1000);
    assertThrows(() => store.consume(router, epoch(1024), loaded));
    store.consume(router, epoch(1024), loaded + RETENTION + 1);
  } finally {
    store.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("a ledger past its bound is refused at load", () => {
  const directory = Deno.makeTempDirSync(), path = `${directory}/ledger`;
  try {
    // An earlier toolshed's claim lines are skipped at load, so only the
    // bound refuses this ledger.
    Deno.writeTextFileSync(
      path,
      '["claim",0]\n'.repeat(Math.ceil((32 * MIB + 1) / 12)),
    );
    assertThrows(() => new RoutedEpochStore(path));
  } finally {
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("an append after compaction is checked against the compacted size", async () => {
  const directory = Deno.makeTempDirSync(), path = `${directory}/ledger`;
  const router = (await Identity.fromRaw(new Uint8Array(32).fill(96))).did();
  const store = new RoutedEpochStore(path);
  try {
    store.consume(router, epoch(1));
    // Lines the store no longer holds fill the file to 16 bytes short of its
    // bound: the next append compacts it first, then fits.
    const fill = 32 * MIB - 16 - Deno.statSync(path).size;
    Deno.writeTextFileSync(path, `${" ".repeat(fill - 1)}\n`, {
      append: true,
    });
    store.consume(router, epoch(3));
    assert(store.healthy);
    assert(Deno.statSync(path).size < MIB);
  } finally {
    store.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("retirement and revocation survive compaction and reload", async () => {
  const directory = Deno.makeTempDirSync(), path = `${directory}/ledger`;
  const [router, revoked] = await Promise.all(
    [91, 92].map(async (seed) =>
      (await Identity.fromRaw(new Uint8Array(32).fill(seed))).did()
    ),
  );
  const now = Math.floor(Date.now() / 1000);
  let store = new RoutedEpochStore(path);
  try {
    store.consume(router, epoch(1), now);
    store.consume(router, epoch(2), now);
    store.retire(router, epoch(2), now);
    // Retiring again, or an unknown epoch, records nothing.
    store.retire(router, epoch(2), now + 5);
    store.retire(router, epoch(99), now);
    store.consume(revoked, epoch(3), now);
    store.revoke(revoked);
    // A forgotten epoch consumed again leaves a repeated line until compaction.
    store.consume(router, epoch(4), now - 2 * RETENTION);
    store.retire(router, epoch(4), now - 2 * RETENTION);
    store.consume(router, epoch(4), now);
    // Force compaction, then check every kind of record survived it.
    const record = Deno.readTextFileSync(path).split("\n")[0] + "\n";
    Deno.writeTextFileSync(
      path,
      record.repeat(Math.ceil(17 * MIB / record.length)),
      { append: true },
    );
    store.consume(router, epoch(5), now);
    assert(Deno.statSync(path).size < MIB);
    assertThrows(() => store.consume(router, epoch(4), now));
    store.close();
    store = new RoutedEpochStore(path);
    assertThrows(() => store.consume(router, epoch(1), now));
    assertThrows(() => store.consume(router, epoch(2), now + RETENTION - 1));
    store.consume(router, epoch(2), now + RETENTION);
    assertThrows(() => store.consume(revoked, epoch(6), now));
  } finally {
    store.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("an epoch left live by a crash is retired once and keeps that time", async () => {
  const directory = Deno.makeTempDirSync(), path = `${directory}/ledger`;
  const router = (await Identity.fromRaw(new Uint8Array(32).fill(94))).did();
  const epoch = "ab".repeat(16);
  let store = new RoutedEpochStore(path);
  try {
    store.consume(router, epoch);
    store.close();
    const retires = () =>
      Deno.readTextFileSync(path).split("\n").filter((line) =>
        line.startsWith('["retire"')
      );
    for (let i = 0; i < 3; i++) {
      store = new RoutedEpochStore(path);
      store.close();
      assertEquals(retires().length, 1);
    }
    store = new RoutedEpochStore(path);
  } finally {
    store.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("an earlier toolshed's ledger near its bound compacts as it loads and keeps admitting links", async () => {
  // An earlier toolshed recorded client proofs here, within the same 32 MiB
  // bound; a restart past half of it once reached the bound before the next
  // compaction.
  const directory = Deno.makeTempDirSync(), path = `${directory}/ledger`;
  const router = (await Identity.fromRaw(new Uint8Array(32).fill(95))).did();
  const claim = JSON.stringify([
    "claim",
    router,
    "d".repeat(200),
    router,
    "11".repeat(32),
    "22".repeat(32),
    epoch(1),
    "44".repeat(16),
    1,
    false,
  ]) + "\n";
  Deno.writeTextFileSync(
    path,
    JSON.stringify(["epoch", router, epoch(1)]) + "\n" +
      claim.repeat(Math.floor((32 * MIB - 4096) / claim.length)),
  );
  // Durability is not under test here; fsync would make the churn slow.
  using _sync = stub(Deno.FsFile.prototype, "syncDataSync");
  let store = new RoutedEpochStore(path);
  try {
    assert(Deno.statSync(path).size < MIB);
    // Link churn: each epoch closes and is forgotten after the retention
    // period, and the file never reaches its bound. It ran in the past, so
    // the restart below finds every epoch forgotten.
    let now = Math.floor(Date.now() / 1000) - 80000 - RETENTION;
    for (let i = 2; i < 80000; i++) {
      now += 1;
      store.consume(router, epoch(i), now);
      store.retire(router, epoch(i), now);
    }
    // About 17 MiB of records were appended, so the file compacted.
    assert(store.healthy);
    assert(Deno.statSync(path).size <= 16 * MIB + 4096);
    store.close();
    store = new RoutedEpochStore(path);
    assert(Deno.statSync(path).size < MIB);
  } finally {
    store.close();
    Deno.removeSync(directory, { recursive: true });
  }
});
