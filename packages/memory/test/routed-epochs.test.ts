/** Durable proof custody: a router cannot move or revive client authorization. */
import { assertEquals, assertThrows } from "@std/assert";
import { Identity } from "@commonfabric/identity";
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
