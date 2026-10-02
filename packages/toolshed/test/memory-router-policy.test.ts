import { assert, assertEquals, assertThrows } from "@std/assert";
import { Identity } from "@commonfabric/identity";
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
