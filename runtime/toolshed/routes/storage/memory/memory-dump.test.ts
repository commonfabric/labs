// deno-lint-ignore-file cf-imports/no-inline-module-import -- the environment
// is parsed once, as env.ts loads, so the variables this file sets must be set
// before the router pulls it in.

// Integration tests for the state-inspector remote dump endpoint.
//
// env is parsed once at module load, so we set the MEMORY_DUMP_* vars and a
// temp MEMORY_DIR BEFORE dynamically importing the router. Every static import
// here is env-free, so env.ts first evaluates inside the dynamic import below.
//
// The fixture is seeded through the SAME `resolveSpaceStoreUrl` + the SAME
// `memoryEngineStoreUrl` the live server uses, so it lands at the exact path the
// route resolves (directory mode nests one `engine-v3/` deeper than MEMORY_DIR).

import { expect } from "@std/expect";
import * as Path from "@std/path";
import { afterAll, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { resolveSpaceStoreUrl } from "@commonfabric/memory/v2/storage-path";
import { signFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import { Database } from "@db/sqlite";

const SQLITE_MAGIC = "SQLite format 3\0";
const DUMP_BASE = "/api/storage/memory/dump";
const SPACE = "did:key:z6MkDumpEndpointTestSpace000000000000000000000000";

const tmp = await Deno.makeTempDir({ prefix: "cf-dump-it-" });
const allowed = await Identity.fromPassphrase("dump endpoint allowed signer");
const stranger = await Identity.fromPassphrase("dump endpoint stranger signer");

Deno.env.set("MEMORY_DIR", Path.toFileUrl(`${tmp}/`).href);
Deno.env.set("MEMORY_DUMP_ENABLED", "true");
Deno.env.set("MEMORY_DUMP_DIDS", allowed.did());

const { createTestApp } = await import("@/lib/create-app.ts");
const { default: dumpRouter } = await import("./memory-dump.index.ts");
// The store the server uses; seed the fixture exactly where the route reads.
const { memoryEngineStoreUrl } = await import("@/routes/storage/memory.ts");
const app = createTestApp(dumpRouter);

{
  const storePath = Path.fromFileUrl(
    resolveSpaceStoreUrl(memoryEngineStoreUrl, SPACE as MemorySpace),
  );
  await Deno.mkdir(Path.dirname(storePath), { recursive: true });
  const db = new Database(storePath);
  db.exec("CREATE TABLE probe (n INTEGER)");
  db.exec("INSERT INTO probe (n) VALUES (42)");
  db.close();
}

function sign(path: string, signer: Identity): Promise<Headers> {
  return signFirstPartyHttpRequest({
    url: new URL(path, "http://localhost"),
    method: "GET",
    signer,
  });
}

afterAll(async () => {
  await Deno.remove(tmp, { recursive: true }).catch(() => {});
});

describe("memory dump endpoint", () => {
  it("rejects unsigned requests with 401", async () => {
    const res = await app.request(DUMP_BASE);
    await res.body?.cancel();
    expect(res.status).toBe(401);
  });

  it("rejects a signed request from a non-allowlisted DID with 403", async () => {
    const res = await app.request(DUMP_BASE, {
      headers: await sign(DUMP_BASE, stranger),
    });
    await res.body?.cancel();
    expect(res.status).toBe(403);
  });

  it("lists spaces for an allowlisted DID", async () => {
    const res = await app.request(DUMP_BASE, {
      headers: await sign(DUMP_BASE, allowed),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      spaces: { space: string; sizeBytes: number }[];
    };
    const found = body.spaces.find((s) => s.space === SPACE);
    expect(found).toBeDefined();
    expect(found!.sizeBytes).toBeGreaterThan(0);
  });

  it("dumps a consistent SQLite snapshot for an allowlisted DID", async () => {
    const path = `${DUMP_BASE}/${encodeURIComponent(SPACE)}`;
    const res = await app.request(path, { headers: await sign(path, allowed) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Valid SQLite file header.
    expect(new TextDecoder().decode(bytes.slice(0, 16))).toBe(SQLITE_MAGIC);

    // And it round-trips: the snapshot opens and carries our probe row.
    const out = await Deno.makeTempFile({ suffix: ".sqlite" });
    try {
      await Deno.writeFile(out, bytes);
      const db = new Database(out, { readonly: true });
      try {
        const row = db.prepare("SELECT n FROM probe").get<{ n: number }>();
        expect(row?.n).toBe(42);
      } finally {
        db.close();
      }
    } finally {
      await Deno.remove(out).catch(() => {});
    }
  });

  it("returns 404 for an unknown space", async () => {
    const path = `${DUMP_BASE}/${encodeURIComponent("did:key:zNope")}`;
    const res = await app.request(path, { headers: await sign(path, allowed) });
    await res.body?.cancel();
    expect(res.status).toBe(404);
  });

  it("blocks path traversal in the space id with 404", async () => {
    const path = `${DUMP_BASE}/${encodeURIComponent("../../../etc/passwd")}`;
    const res = await app.request(path, { headers: await sign(path, allowed) });
    await res.body?.cancel();
    expect(res.status).toBe(404);
  });

  it("returns 500 when the snapshot fails (corrupt store file)", async () => {
    // Seed a file at the canonical store path that is NOT a valid SQLite DB, so
    // `VACUUM INTO` throws → the route reports 500 rather than serving garbage.
    const bad = "did:key:z6MkDumpEndpointTestCorrupt00000000000000000000";
    const badPath = Path.fromFileUrl(
      resolveSpaceStoreUrl(memoryEngineStoreUrl, bad as MemorySpace),
    );
    await Deno.writeTextFile(badPath, "this is not a sqlite database");
    const path = `${DUMP_BASE}/${encodeURIComponent(bad)}`;
    const res = await app.request(path, { headers: await sign(path, allowed) });
    await res.body?.cancel();
    expect(res.status).toBe(500);
  });

  it("cleans the snapshot temp dir when serving fails after VACUUM", async () => {
    // Force the post-VACUUM open to fail; the (potentially large) snapshot in
    // the temp dir must not leak.
    const probe = Deno.makeTempDirSync();
    const tmpRoot = Path.dirname(probe);
    Deno.removeSync(probe);
    const dumpDirs = () =>
      new Set(
        [...Deno.readDirSync(tmpRoot)]
          .map((e) => e.name).filter((n) => n.startsWith("cf-dump-")),
      );
    const before = dumpDirs();
    const realOpen = Deno.open;
    Deno.open = ((p: string | URL, o?: Deno.OpenOptions) => {
      if (String(p).includes("cf-dump-")) {
        return Promise.reject(new Deno.errors.PermissionDenied("forced"));
      }
      return realOpen(p, o);
    }) as typeof Deno.open;
    try {
      const path = `${DUMP_BASE}/${encodeURIComponent(SPACE)}`;
      const res = await app.request(path, {
        headers: await sign(path, allowed),
      });
      await res.body?.cancel();
      expect(res.status).toBe(500);

      // And the sibling failure: open succeeds but stat fails — the fd must be
      // closed and the temp dir still cleaned before the 500.
      let closed = false;
      Deno.open = ((p: string | URL, o?: Deno.OpenOptions) => {
        if (String(p).includes("cf-dump-")) {
          return Promise.resolve(
            {
              stat: () => Promise.reject(new Deno.errors.NotFound("forced")),
              close: () => {
                closed = true;
              },
            } as unknown as Deno.FsFile,
          );
        }
        return realOpen(p, o);
      }) as typeof Deno.open;
      const res2 = await app.request(path, {
        headers: await sign(path, allowed),
      });
      await res2.body?.cancel();
      expect(res2.status).toBe(500);
      expect(closed).toBe(true);
    } finally {
      Deno.open = realOpen;
    }
    // No new cf-dump-* temp dir survives the failed requests.
    const leaked = [...dumpDirs()].filter((d) => !before.has(d));
    expect(leaked).toEqual([]);
  });
});
