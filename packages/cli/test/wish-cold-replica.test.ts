import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import { resolveWish } from "../lib/wish.ts";

// A `cf wish` invocation is a COLD replica: a fresh process whose runtime has
// synced nothing, reading home records another session persisted. The
// emulated single-manager fixture in wish.test.ts seeds records the reading
// runtime already holds, so it never exercises that path. These tests share
// one loopback server between a writer and a cold reader.

const userIdentity = await Identity.fromPassphrase("cf-wish-cold-test-user");
const profileSpaceDid =
  (await Identity.fromPassphrase("cf-wish-cold-test-profile-space")).did();

describe("cf wish headless read on a cold replica", () => {
  let server: ReturnType<typeof newLoopbackServer> | undefined;
  const managers: EmulatedStorageManager[] = [];
  const runtimes: Runtime[] = [];

  // Each test starts its own server and picks the fan-out cadence: 0 spreads
  // frames at once, a delay makes every catch-up a wait, which is what a
  // deployed server is.
  function startServer(refreshDelayMs = 0): void {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: refreshDelayMs });
  }

  function connect(): Runtime {
    if (server === undefined) throw new Error("startServer() first");
    const storageManager = EmulatedStorageManager.connectTo(server, {
      as: userIdentity,
    });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    managers.push(storageManager);
    runtimes.push(runtime);
    return runtime;
  }

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
      await runtime.dispose({ closeStorage: false });
    }
    for (const manager of managers.splice(0)) await manager.close();
    await server?.close();
    server = undefined;
  });

  // The live home shape: `defaultPattern.profiles` lists the profile (a link
  // into its own space), `defaultProfile` names it, and `mru` is a LINK to a
  // separate document holding an empty list — the record a cold reader has
  // no reason to hold until the selector follows the link.
  async function seedProfile(runtime: Runtime): Promise<void> {
    let tx = runtime.edit();
    const profileSpaceCell = runtime.getSpaceCell(
      profileSpaceDid,
      undefined,
      tx,
    );
    const profileDefaultCell = runtime.getCell(
      profileSpaceDid,
      "profile-default",
      undefined,
      tx,
    );
    profileDefaultCell.set({
      name: "Ada Lovelace",
      initialNameApplied: "Ada Lovelace",
      avatar: "ada.png",
      bio: "Mathematician & first programmer.",
      elements: [],
    });
    profileSpaceCell.key("defaultPattern").set(profileDefaultCell);
    await tx.commit();
    await runtime.idle();

    tx = runtime.edit();
    const homeSpaceCell = runtime.getHomeSpaceCell(tx);
    const homeDefaultCell = runtime.getCell(
      userIdentity.did(),
      "home-default-profile-link",
      undefined,
      tx,
    );
    const profileLink = runtime.getCell(
      profileSpaceDid,
      "profile-default",
      undefined,
      tx,
    );
    const mruCell = runtime.getCell<unknown[]>(
      userIdentity.did(),
      "home-mru",
      undefined,
      tx,
    );
    mruCell.set([]);
    homeDefaultCell.key("profiles").set([profileLink]);
    homeDefaultCell.key("defaultProfile").set(profileLink);
    homeDefaultCell.key("mru").set(mruCell);
    // deno-lint-ignore no-explicit-any
    (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
  }

  it("resolves #profileName from a replica that never synced the home records", async () => {
    startServer();
    const writer = connect();
    await seedProfile(writer);

    const reader = connect();
    const { result, error } = await resolveWish(reader, userIdentity.did(), {
      query: "#profileName",
    });
    expect(error).toBeUndefined();
    expect(result).toBe("Ada Lovelace");
  });

  for (const count of [2, 3]) {
    for (const query of ["#profile", "#profileName"]) {
      it(`resolves ${query} when a cold roster lists ${count} profiles`, async () => {
        startServer();
        const writer = connect();
        await seedProfile(writer);
        const profiles = [writer.getCell(profileSpaceDid, "profile-default")];
        for (let i = 1; i < count; i++) {
          const space =
            (await Identity.fromPassphrase(`cf-wish-cold-profile-${i}`)).did();
          const tx = writer.edit();
          const profile = writer.getCell(space, "profile-default");
          profile.withTx(tx).set({
            name: `Other profile ${i}`,
            initialNameApplied: `Other profile ${i}`,
            avatar: "",
            bio: "",
            elements: [],
          });
          expect((await tx.commit()).error).toBeUndefined();
          profiles.push(profile);
        }
        const tx = writer.edit();
        writer.getCell(
          userIdentity.did(),
          "home-default-profile-link",
          undefined,
          tx,
        )
          .key("profiles").set(profiles);
        expect((await tx.commit()).error).toBeUndefined();
        await writer.storageManager.synced();

        const reader = connect();
        const { result, error } = await resolveWish(
          reader,
          userIdentity.did(),
          { query },
        );
        expect(error).toBeUndefined();
        if (query === "#profile") {
          expect(result).toMatchObject({ name: "Ada Lovelace" });
        } else expect(result).toBe("Ada Lovelace");
      });
    }
  }

  for (const missingFirst of [false, true]) {
    it(`uses the healthy default when another profile is absent (missingFirst=${missingFirst})`, async () => {
      startServer();
      const writer = connect();
      await seedProfile(writer);
      const missingSpace =
        (await Identity.fromPassphrase("cf-wish-missing-profile")).did();
      const healthy = writer.getCell(profileSpaceDid, "profile-default");
      const missing = writer.getCell(missingSpace, "absent-profile");
      const tx = writer.edit();
      writer.getCell(
        userIdentity.did(),
        "home-default-profile-link",
        undefined,
        tx,
      )
        .key("profiles").set(
          missingFirst ? [missing, healthy] : [healthy, missing],
        );
      expect((await tx.commit()).error).toBeUndefined();
      await writer.storageManager.synced();
      const { result, error } = await resolveWish(
        connect(),
        userIdentity.did(),
        { query: "#profileName" },
      );
      expect(error).toBeUndefined();
      expect(result).toBe("Ada Lovelace");
    });
  }

  it("settles through several cold layers when every catch-up is a wait", async () => {
    // The lookup follows links a layer at a time — the home root, the
    // default-pattern record, the profile in its own space, the MRU list —
    // and on a cold replica each layer costs a refused commit, a catch-up,
    // and a re-run. With frames spread on a delay the catch-ups take real
    // time, and a fixed sequence of idle/sync steps ends before the rounds
    // do; the read must wait for the lookup to settle instead.
    startServer(150);
    const writer = connect();
    await seedProfile(writer);

    const reader = connect();
    const { result, error } = await resolveWish(reader, userIdentity.did(), {
      query: "#profileName",
    });
    expect(error).toBeUndefined();
    expect(result).toBe("Ada Lovelace");
  });

  it("does not present an earlier invocation's answer as this one's", async () => {
    startServer();
    // Invocation 1, before any profile exists: the honest answer is the
    // no-profile error, and it is committed as wish state.
    const first = connect();
    const before = await resolveWish(first, userIdentity.did(), {
      query: "#profileName",
    });
    expect(before.error).toBe("No profile exists yet");
    await first.storageManager.synced();

    // The profile is created in another session.
    const writer = connect();
    await seedProfile(writer);

    // Invocation 2, cold: must answer for the current state, never with the
    // error invocation 1 committed.
    const reader = connect();
    const { result, error } = await resolveWish(reader, userIdentity.did(), {
      query: "#profileName",
    });
    expect(error).toBeUndefined();
    expect(result).toBe("Ada Lovelace");
  });
});
