// Unit tests for remote acquisition — fetch is stubbed, so no network/server.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { defaultCacheDir, fetchSpaceDb, listRemoteSpaces } from "../remote.ts";
import { discoverSpaceDbs, resolveSpacePath } from "../discover.ts";

const SPACE = "did:key:z6MkRemoteTestSpace000000000000000000000000000000";
const realFetch = globalThis.fetch;

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response,
): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

async function withCacheDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "cf-remote-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("listRemoteSpaces parses the spaces payload and signs", async () => {
  const stub = stubFetch(() =>
    new Response(
      JSON.stringify({ spaces: [{ space: SPACE, sizeBytes: 10, mtimeMs: 1 }] }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )
  );
  try {
    let signed = false;
    const spaces = await listRemoteSpaces("http://h:1/", {
      sign: () => {
        signed = true;
        return { "CF-Request-Auth": "x" };
      },
    });
    assertEquals(spaces.length, 1);
    assertEquals(spaces[0].space, SPACE);
    assertEquals(signed, true);
    assertStringIncludes(stub.calls[0], "/api/storage/memory/dump");
  } finally {
    stub.restore();
  }
});

Deno.test("fetchSpaceDb caches: second call does not re-fetch", async () => {
  await withCacheDir(async (cacheDir) => {
    const stub = stubFetch(() =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    );
    try {
      const p1 = await fetchSpaceDb(SPACE, "http://h:1", { cacheDir });
      const p2 = await fetchSpaceDb(SPACE, "http://h:1", { cacheDir });
      assertEquals(p1, p2);
      assertEquals(stub.calls.length, 1); // cached on the 2nd call
      assertEquals((await Deno.readFile(p1)).length, 3);
    } finally {
      stub.restore();
    }
  });
});

Deno.test("a pulled DB is discoverable and resolvable by full DID", async () => {
  await withCacheDir(async (cacheDir) => {
    // A minimal-but-real SQLite header so quickStats/open don't choke on it.
    const stub = stubFetch(() =>
      new Response(new TextEncoder().encode("SQLite format 3\0rest"), {
        status: 200,
      })
    );
    try {
      const path = await fetchSpaceDb(SPACE, "http://h:1", { cacheDir });
      // Cached under the LITERAL did filename (no %3A), matching local layout.
      assertStringIncludes(path, `${SPACE}.sqlite`);
      assertEquals(path.includes("%3A"), false);

      // …so normal local discovery reports the real DID and resolves it by the
      // full DID a `pull` would have printed (the workflow Codex flagged).
      const found = discoverSpaceDbs({ dirs: [cacheDir], defaultRoots: false });
      assertEquals(found.some((s) => s.did === SPACE), true);
      assertEquals(resolveSpacePath(SPACE, found), path);
    } finally {
      stub.restore();
    }
  });
});

Deno.test("fetchSpaceDb force re-downloads", async () => {
  await withCacheDir(async (cacheDir) => {
    const stub = stubFetch(() =>
      new Response(new Uint8Array([9]), { status: 200 })
    );
    try {
      await fetchSpaceDb(SPACE, "http://h:1", { cacheDir });
      await fetchSpaceDb(SPACE, "http://h:1", { cacheDir, force: true });
      assertEquals(stub.calls.length, 2);
    } finally {
      stub.restore();
    }
  });
});

Deno.test("error mapping is actionable across statuses", async () => {
  for (
    const [status, needle] of [
      [401, "set CF_IDENTITY"],
      [403, "allowlist"],
      [404, "disabled or unknown space"],
      [500, "request failed (500"],
    ] as const
  ) {
    const stub = stubFetch(() =>
      new Response(JSON.stringify({ error: "no" }), { status })
    );
    try {
      await assertRejects(
        () => listRemoteSpaces("http://h:1", {}),
        Error,
        needle,
      );
    } finally {
      stub.restore();
    }
  }
});

Deno.test("fetchSpaceDb rejects a space id that isn't a safe filename", async () => {
  await withCacheDir(async (cacheDir) => {
    for (const bad of ["a/b", "a\\b"]) {
      await assertRejects(
        () => fetchSpaceDb(bad, "http://h:1", { cacheDir }),
        Error,
        "invalid space id",
      );
    }
  });
});

Deno.test("defaultCacheDir namespaces by host", () => {
  assertStringIncludes(
    defaultCacheDir("https://rapids.example.ts.net/"),
    "rapids.example.ts.net",
  );
  // An unparseable base falls back to a sanitized literal slug.
  assertStringIncludes(defaultCacheDir("not a url"), "not_a_url");
});

Deno.test("a non-JSON error body still maps to an actionable message", async () => {
  const stub = stubFetch(() =>
    new Response("<html>nope</html>", { status: 403 })
  );
  try {
    await assertRejects(
      () => listRemoteSpaces("http://h:1", {}),
      Error,
      "allowlist",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("fetchSpaceDb maps its own HTTP errors", async () => {
  await withCacheDir(async (cacheDir) => {
    const stub = stubFetch(() =>
      new Response(JSON.stringify({ error: "space not found" }), {
        status: 404,
      })
    );
    try {
      await assertRejects(
        () => fetchSpaceDb(SPACE, "http://h:1", { cacheDir }),
        Error,
        "disabled or unknown space",
      );
    } finally {
      stub.restore();
    }
  });
});

Deno.test("an interrupted download leaves no partial or torn cache file", async () => {
  await withCacheDir(async (cacheDir) => {
    const stub = stubFetch(() =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.error(new Error("connection reset"));
          },
        }),
        { status: 200 },
      )
    );
    try {
      await assertRejects(
        () => fetchSpaceDb(SPACE, "http://h:1", { cacheDir }),
        Error,
        "connection reset",
      );
      // Neither the final cache file nor a .partial temp survives.
      const leftovers = [...Deno.readDirSync(cacheDir)].map((e) => e.name);
      assertEquals(leftovers, []);
    } finally {
      stub.restore();
    }
  });
});
