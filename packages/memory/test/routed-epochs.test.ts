/** Durable proof custody: a router cannot move or revive client authorization. */
import { assertEquals, assertThrows } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { stub } from "@std/testing/mock";
import { RoutedEpochStore } from "../v2/routed-epochs.ts";
Deno.test("proof binding and release survive toolshed restart", async () => {
  const directory = Deno.makeTempDirSync();
  const router = (await Identity.fromRaw(new Uint8Array(32).fill(81))).did();
  const principal = (await Identity.fromRaw(new Uint8Array(32).fill(82))).did();
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    router,
    principal,
    deployment: "stage-test",
    challenge: "11".repeat(32),
    digest: "22".repeat(32),
    epoch: "33".repeat(16),
    context: "44".repeat(16),
    exp: now + 600,
  };
  let store = new RoutedEpochStore(`${directory}/ledger`);
  try {
    store.consume(router, claim.epoch);
    store.claim(claim, now);
    store.claim(claim, now);
    assertThrows(() =>
      store.claim({ ...claim, context: "55".repeat(16) }, now)
    );
    assertThrows(() => store.claim({ ...claim, digest: "66".repeat(32) }, now));
    store.consume(router, "77".repeat(16));
    assertThrows(() => store.claim({ ...claim, epoch: "77".repeat(16) }, now));
    store.close();
    store = new RoutedEpochStore(`${directory}/ledger`);
    assertThrows(() => store.consume(router, claim.epoch));
    assertThrows(() =>
      store.claim({ ...claim, context: "55".repeat(16) }, now)
    );
    const other = { ...claim, deployment: "other-deployment" };
    store.claim(other, now);
    store.release(
      router,
      claim.deployment,
      claim.epoch,
      claim.context,
      principal,
      now,
    );
    assertThrows(() => store.claim(claim, now));
    store.claim(other, now);
    store.claim({
      ...claim,
      challenge: "88".repeat(32),
      digest: "99".repeat(32),
    }, now);
    store.close();
    store = new RoutedEpochStore(`${directory}/ledger`);
    assertThrows(() => store.claim(claim, now));
    store.revoke(router);
    store.close();
    store = new RoutedEpochStore(`${directory}/ledger`);
    assertThrows(() => store.consume(router, "aa".repeat(16)));
  } finally {
    store.close();
    Deno.removeSync(directory, { recursive: true });
  }
});
Deno.test("epoch compaction remains restartable and durability failure stays latched", async () => {
  const directory = Deno.makeTempDirSync(), path = `${directory}/ledger`;
  const router = (await Identity.fromRaw(new Uint8Array(32).fill(85))).did();
  const principal = (await Identity.fromRaw(new Uint8Array(32).fill(86))).did();
  let store = new RoutedEpochStore(path);
  try {
    store.consume(router, "11".repeat(16));
    store.claim({
      router,
      principal,
      deployment: "test",
      challenge: "22".repeat(32),
      digest: "33".repeat(32),
      epoch: "11".repeat(16),
      context: "44".repeat(16),
      exp: 101,
    }, 100);
    const record = Deno.readTextFileSync(path).split("\n")[1] + "\n";
    const fill = () =>
      Deno.writeTextFileSync(
        path,
        record.repeat(Math.ceil(17 * 1024 * 1024 / record.length)),
        { append: true },
      );
    fill();
    store.consume(router, "55".repeat(16));
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

Deno.test("closed link epochs are forgotten only after every proof bound to them expired", async () => {
  const directory = Deno.makeTempDirSync(), path = `${directory}/ledger`;
  const router = (await Identity.fromRaw(new Uint8Array(32).fill(88))).did();
  const principal = (await Identity.fromRaw(new Uint8Array(32).fill(89))).did();
  const now = Math.floor(Date.now() / 1000);
  const epoch = (i: number) => i.toString(16).padStart(32, "0");
  const retention = 3600 + 60 + 120;
  let store = new RoutedEpochStore(path);
  try {
    // A long claim keeps its epoch recorded past the retention period.
    store.consume(router, epoch(0), now);
    store.claim({
      router,
      principal,
      deployment: "test",
      challenge: "22".repeat(32),
      digest: "33".repeat(32),
      epoch: epoch(0),
      context: "44".repeat(16),
      exp: now + 2 * retention,
    }, now);
    store.retire(router, epoch(0), now);
    for (let i = 1; i < 1024; i++) {
      store.consume(router, epoch(i), now);
      store.retire(router, epoch(i), now);
    }
    // A live or recently closed epoch is never reused, and the bound holds.
    assertThrows(() => store.consume(router, epoch(5), now + retention - 1));
    assertThrows(() => store.consume(router, epoch(1024), now + retention - 1));
    // After the retention period the closed epochs free the bound.
    store.consume(router, epoch(1024), now + retention);
    assertThrows(() => store.consume(router, epoch(0), now + retention));
    store.consume(router, epoch(5), now + retention);
    store.close();
    // Retirement times survive restart. Epoch 7 closed long ago, epoch 8 just
    // now; no link survives a restart, so the live epoch 9 retires at load.
    store = new RoutedEpochStore(`${directory}/second`);
    for (const i of [7, 8, 9]) store.consume(router, epoch(i), now);
    store.retire(router, epoch(7), now - retention - 1);
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
      Math.floor(Date.now() / 1000) + retention + 1,
    );
  } finally {
    store.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("a ledger from before retirement records retires its epochs at load", async () => {
  const directory = Deno.makeTempDirSync(), path = `${directory}/ledger`;
  const router = (await Identity.fromRaw(new Uint8Array(32).fill(90))).did();
  const epoch = (i: number) => i.toString(16).padStart(32, "0");
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
    store.consume(router, epoch(1024), loaded + 3600 + 60 + 120 + 1);
  } finally {
    store.close();
    Deno.removeSync(directory, { recursive: true });
  }
});
