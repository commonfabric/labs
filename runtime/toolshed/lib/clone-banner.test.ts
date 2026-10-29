// The banner's contract: it fires for a served clone, stays quiet for an
// ordinary store, and never blocks startup — a diagnostic that took the server
// down would trade a cosmetic problem for an outage.

import { assert, assertEquals } from "@std/assert";
import { toFileUrl } from "@std/path";
import env from "@/env.ts";
import {
  announceCloneIfServed,
  cloneBanner,
  storeRootPath,
} from "@/lib/clone-banner.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const MARKER_BODY =
  `This directory is a CLONE of space did:key:z6MkExample, not production.\n` +
  `Taken 2026-07-27T12:00:00.000Z from /snapshots/estuary.sqlite\n` +
  `Reset it with: cf space reset /clones/topics\n`;

async function withStore(
  run: (dir: string) => Promise<void> | void,
  options: { marker?: string } = {},
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "clone-banner-test-" });
  try {
    if (options.marker !== undefined) {
      await Deno.writeTextFile(`${dir}/.cf-clone`, options.marker);
    }
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a served clone is announced with its provenance", async () => {
  await withStore((dir) => {
    const banner = cloneBanner({ memoryDir: toFileUrl(`${dir}/`).href })!;
    assert(banner !== null, "a marked store must produce a banner");
    assert(banner.includes("NOT PRODUCTION"));
    // The provenance from the marker is what makes the warning actionable:
    // which space, taken when, from where, and how to reset it.
    assert(banner.includes("did:key:z6MkExample"));
    assert(banner.includes("/snapshots/estuary.sqlite"));
    assert(banner.includes("cf space reset /clones/topics"));
  }, { marker: MARKER_BODY });
});

Deno.test("announcing a clone emits the banner exactly once", async () => {
  // `announceCloneIfServed` is what `startServer` calls, so its emitting path
  // is the one production takes — the other cases here exercise `cloneBanner`
  // underneath it.
  await withStore((dir) => {
    const lines: string[] = [];
    announceCloneIfServed(
      { memoryDir: toFileUrl(`${dir}/`).href },
      (m) => lines.push(m),
    );
    assertEquals(lines.length, 1);
    assert(lines[0].includes("NOT PRODUCTION"));
    assert(lines[0].includes("did:key:z6MkExample"));
  }, { marker: MARKER_BODY });
});

Deno.test("an ordinary store says nothing", async () => {
  await withStore((dir) => {
    assertEquals(cloneBanner({ memoryDir: toFileUrl(`${dir}/`).href }), null);

    const lines: string[] = [];
    announceCloneIfServed(
      { memoryDir: toFileUrl(`${dir}/`).href },
      (m) => lines.push(m),
    );
    assertEquals(lines, [], "no banner, no output");
  });
});

Deno.test("single-file mode looks beside the database file", async () => {
  // DB_PATH names a file; the marker lives in its directory.
  await withStore((dir) => {
    assertEquals(storeRootPath({ dbPath: `${dir}/store.sqlite` }), dir);
    const banner = cloneBanner({ dbPath: `${dir}/store.sqlite` });
    assert(banner !== null && banner.includes("NOT PRODUCTION"));
  }, { marker: MARKER_BODY });
});

Deno.test("DB_PATH wins over MEMORY_DIR, as it does in the engine", async () => {
  await withStore(async (marked) => {
    await withStore((plain) => {
      // Single-file mode is selected by DB_PATH; MEMORY_DIR is then unused, so
      // the banner must follow DB_PATH or it would report the wrong store.
      assertEquals(
        storeRootPath({
          memoryDir: toFileUrl(`${plain}/`).href,
          dbPath: `${marked}/s.sqlite`,
        }),
        marked,
      );
    });
  }, { marker: MARKER_BODY });
});

Deno.test("a store configuration it cannot interpret is not an error", async () => {
  // MEMORY_DIR comes from the environment and may be junk, remote, or absent.
  // None of that should stop a server from starting.
  assertEquals(storeRootPath({}), null);
  assertEquals(storeRootPath({ memoryDir: "file://[not-a-url" }), null);
  assertEquals(storeRootPath({ memoryDir: "relative/path" }), null);
  assertEquals(storeRootPath({ memoryDir: "https://example.com/store" }), null);
  assertEquals(cloneBanner({ memoryDir: "file://[not-a-url" }), null);

  // A directory that does not exist at all is simply not a clone.
  assertEquals(cloneBanner({ memoryDir: "file:///no/such/store/" }), null);

  // A bare absolute path (not a URL) is still usable.
  await withStore((dir) => {
    assertEquals(storeRootPath({ memoryDir: dir }), dir);
    assert(cloneBanner({ memoryDir: dir }) !== null);
  }, { marker: MARKER_BODY });
});

Deno.test("an unreadable marker does not take the server down", async () => {
  // A directory where the marker file should be: readTextFile fails with
  // IsADirectory, not NotFound. The banner is diagnostic — it must degrade to
  // silence rather than propagate.
  await withStore(async (dir) => {
    await Deno.mkdir(`${dir}/.cf-clone`);
    assertEquals(cloneBanner({ memoryDir: toFileUrl(`${dir}/`).href }), null);
  });
});
