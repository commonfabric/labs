import { assert, assertEquals, assertThrows } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { BASE58_ALPHABET } from "@commonfabric/memory/v2/routed-directory";
import { identity } from "@/lib/identity.ts";
import { MemoryRouterPolicy } from "@/routes/storage/memory-router.ts";

Deno.test("private Memory policy refuses public/wildcard addresses and unknown ownership", async () => {
  const router = await Identity.fromRaw(new Uint8Array(32).fill(17));
  const space = await Identity.fromRaw(new Uint8Array(32).fill(18));
  const root = Deno.makeTempDirSync();
  try {
    const directory = `${root}/directory.json`;
    Deno.writeTextFileSync(
      directory,
      JSON.stringify({
        version: 1,
        deployment: "test",
        toolsheds: [{ did: identity.did() }],
        spaces: { [space.did()]: { toolshed: 0, epoch: 1 } },
      }),
    );
    const config = {
      version: 1,
      deployment: "test",
      hostname: "10.0.0.2",
      port: 8444,
      certificate: `${root}/public.crt`,
      key: `${root}/key`,
      directory,
      epochLedger: `${root}/epochs`,
      routers: { [router.did()]: ["10.0.0.1"] },
    };
    const path = `${root}/config.json`;
    const write = (value: unknown) =>
      Deno.writeTextFileSync(path, JSON.stringify(value));
    write(config);
    const policy = new MemoryRouterPolicy(path);
    assertEquals(policy.ownership(space.did()), 1);
    assertEquals(policy.ownership(router.did()), undefined);
    const stamp = Deno.statSync(directory).mtime!;
    const moved = JSON.parse(Deno.readTextFileSync(directory));
    moved.spaces[space.did()].epoch = 2;
    Deno.writeTextFileSync(directory, JSON.stringify(moved));
    Deno.utimeSync(directory, stamp, stamp);
    assertEquals(policy.ownership(space.did()), 2);
    // Another same-size rewrite in that tick, with no lookup until the file
    // has settled: a stamp recorded before settling could hide it.
    moved.spaces[space.did()].epoch = 3;
    Deno.writeTextFileSync(directory, JSON.stringify(moved));
    Deno.utimeSync(directory, stamp, stamp);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assertEquals(policy.ownership(space.did()), 3);
    assertEquals(policy.ownership(space.did()), 3);
    for (
      const hostname of [
        "0.0.0.0",
        "8.8.8.8",
        "private.example",
        "10.00.0.2",
        "10.0.0.256",
        "::",
      ]
    ) {
      write({ ...config, hostname });
      assertThrows(() => new MemoryRouterPolicy(path));
    }
    for (const peer of ["0.0.0.0", "8.8.8.8", "10.0.0.256", "10.00.0.1"]) {
      write({ ...config, routers: { [router.did()]: [peer] } });
      assertThrows(() => new MemoryRouterPolicy(path));
    }
    Deno.removeSync(directory);
    assertEquals(policy.ownership(space.did()), undefined);
    assertEquals(policy.available, false);
    assert(policy.config.routers.has(router.did()));
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("private Memory policy places unlisted spaces by the directory's rule", async () => {
  const router = await Identity.fromRaw(new Uint8Array(32).fill(17));
  const peer = await Identity.fromRaw(new Uint8Array(32).fill(19));
  const dids = await Promise.all(
    [20, 21, 22, 23, 24, 25, 26, 27].map(async (seed) =>
      (await Identity.fromRaw(new Uint8Array(32).fill(seed))).did()
    ),
  );
  // The rule sends DIDs ending like `there` to the peer and the rest here.
  const here = dids[0];
  const there = dids.find((did) => did.at(-1) !== here.at(-1))!;
  const listedThere = dids.find((did) =>
    did !== here && did.at(-1) !== there.at(-1)
  )!;
  const lastCharacter = Object.fromEntries(
    [...BASE58_ALPHABET].map((c) => [c, c === there.at(-1) ? 1 : 0]),
  );
  const root = Deno.makeTempDirSync();
  try {
    const directory = `${root}/directory.json`;
    const base = {
      version: 1,
      deployment: "test",
      toolsheds: [{ did: identity.did() }, { did: peer.did() }],
      spaces: { [listedThere]: { toolshed: 1, epoch: 1 } } as Record<
        string,
        { toolshed: number; epoch: number }
      >,
      unlisted: { epoch: 4, last_character: lastCharacter },
    };
    const place = (value: unknown) =>
      Deno.writeTextFileSync(directory, JSON.stringify(value));
    place(base);
    const path = `${root}/config.json`;
    Deno.writeTextFileSync(
      path,
      JSON.stringify({
        version: 1,
        deployment: "test",
        hostname: "10.0.0.2",
        port: 8444,
        certificate: `${root}/public.crt`,
        key: `${root}/key`,
        directory,
        epochLedger: `${root}/epochs`,
        routers: { [router.did()]: ["10.0.0.1"] },
      }),
    );
    const policy = new MemoryRouterPolicy(path);
    assertEquals(policy.ownership(here), 4);
    assertEquals(policy.ownership(there), undefined);
    // A listing wins over the rule, wherever it points.
    assertEquals(policy.ownership(listedThere), undefined);
    // `ownership` trusts its caller to pass a canonical DID; `owns` does
    // not, and refuses strings the rule alone would place here.
    assert(policy.owns(here));
    assert(!policy.owns(there));
    const last = here.at(-1)!;
    for (const space of [`of:${last}`, `did:key:z6Mk${last}`, here + last]) {
      assertEquals(policy.ownership(space), 4);
      assert(!policy.owns(space));
    }
    // A string with a DID's shape but no valid point is owned, so the
    // per-turn check stays cheap, but is never created.
    const shaped = `did:key:z6Mk${"1".repeat(43)}${last}`;
    assert(policy.owns(shaped));
    assert(!policy.creates(shaped));

    // Listing a DID the rule already sends to the peer changes nothing here.
    const fenced = policy.generation;
    place({
      ...base,
      spaces: { ...base.spaces, [there]: { toolshed: 1, epoch: 1 } },
    });
    assertEquals(policy.ownership(there), undefined);
    assertEquals(policy.generation, fenced);
    // Listing one the rule placed here moves it, and fences.
    place({
      ...base,
      spaces: { ...base.spaces, [here]: { toolshed: 1, epoch: 5 } },
    });
    assertEquals(policy.ownership(here), undefined);
    assertEquals(policy.generation, fenced + 1);
    // Unlisting it returns it to the rule, and fences again.
    place(base);
    assertEquals(policy.ownership(here), 4);
    assertEquals(policy.generation, fenced + 2);
    // Only a DID the rule places here may be created here: a listed space's
    // store must already be in place.
    assert(policy.creates(here));
    assert(!policy.creates(there));
    assert(!policy.creates(listedThere));
    place({
      ...base,
      spaces: { ...base.spaces, [here]: { toolshed: 0, epoch: 5 } },
    });
    assertEquals(policy.ownership(here), 5);
    assert(!policy.creates(here));
    place(base);
    // The rule and this toolshed's index are read once: another rule, none,
    // or a reordering that moves this toolshed leaves the snapshot
    // unavailable until a restart, and the original restores it.
    const { unlisted: _rule, ...listedOnly } = base;
    for (
      const changed of [
        { ...base, unlisted: { epoch: 6, last_character: lastCharacter } },
        listedOnly,
        { ...base, toolsheds: [base.toolsheds[1], base.toolsheds[0]] },
      ]
    ) {
      place(changed);
      assertEquals(policy.ownership(here), undefined);
      assertEquals(policy.available, false);
      place(base);
      assertEquals(policy.ownership(here), 4);
      assertEquals(policy.available, true);
    }
    // A toolshed added after this one changes nothing here, and neither does
    // swapping two others.
    const added = await Identity.fromRaw(new Uint8Array(32).fill(28));
    const three = [...base.toolsheds, { did: added.did() }];
    for (const toolsheds of [three, [three[0], three[2], three[1]]]) {
      place({ ...base, toolsheds });
      assertEquals(policy.ownership(here), 4);
      assertEquals(policy.available, true);
    }
    place(base);
    // A null rule is no rule, as it is to the router. Without a rule this
    // toolshed's index is not frozen, as before the rule existed: a
    // reordering moves listed placements, which the router refuses until it
    // restarts.
    place({ ...listedOnly, unlisted: null });
    const unruled = new MemoryRouterPolicy(path);
    assert(unruled.ownership(here) === undefined);
    place({
      ...listedOnly,
      toolsheds: [base.toolsheds[1], base.toolsheds[0]],
    });
    assertEquals(unruled.ownership(listedThere), 1);
    assertEquals(unruled.available, true);
    // Adding a rule is a change like any other: refused until a restart.
    place(base);
    assertEquals(unruled.ownership(here), undefined);
    assertEquals(unruled.available, false);

    const { z: _z, ...missing } = lastCharacter;
    for (
      const unlisted of [
        { epoch: 4, last_character: missing },
        { epoch: 4, last_character: { ...lastCharacter, "0": 0 } },
        { epoch: 4, last_character: { ...lastCharacter, z: 2 } },
        { epoch: 4, last_character: { ...lastCharacter, z: -1 } },
        { epoch: 4, last_character: { ...lastCharacter, z: "0" } },
        { epoch: 0, last_character: lastCharacter },
        { epoch: 1.5, last_character: lastCharacter },
        { epoch: "4", last_character: lastCharacter },
        { epoch: 4, last_character: lastCharacter, toolshed: 0 },
        { epoch: 4 },
        [],
      ]
    ) {
      place({ ...base, unlisted });
      assertThrows(() => new MemoryRouterPolicy(path));
    }
    place({ ...base, placements: {} });
    assertThrows(() => new MemoryRouterPolicy(path));
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
