/** Tests the patterns route over a directory of files it does not know. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { PatternsRoute } from "../src/harness/patterns-route.deno.ts";

const ENTRY = "export default 1;\n";
const IMPORTER = 'import "./leaf.ts";\nexport default 2;\n';

// Writes the named files into a fresh temp tree and returns its root. The
// caller removes the tree.
async function tree(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "patterns-route-" });
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    await Deno.mkdir(join(full, ".."), { recursive: true });
    await Deno.writeTextFile(full, contents);
  }
  return root;
}

// Runs `body` against a route over a temp tree, then removes the tree.
async function withRoute(
  files: Record<string, string>,
  body: (route: PatternsRoute, root: string) => Promise<void>,
): Promise<void> {
  const root = await tree(files);
  try {
    await body(new PatternsRoute(root), root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://host.invalid${path}`, { headers });
}

describe("PatternsRoute", () => {
  it("serves a file's source under the patterns route", async () => {
    await withRoute({ "system/main.tsx": ENTRY }, async (route) => {
      const response = await route.serve(get("/api/patterns/system/main.tsx"));
      expect(response?.status).toBe(200);
      expect(response?.headers.get("Content-Type")).toContain(
        "text/typescript-jsx",
      );
      expect(await response?.text()).toBe(ENTRY);
    });
  });

  it("serves the entry closure's identity for `?identity`", async () => {
    await withRoute(
      { "main.tsx": IMPORTER, "leaf.ts": ENTRY },
      async (route) => {
        const response = await route.serve(
          get("/api/patterns/main.tsx?identity"),
        );
        expect(response?.status).toBe(200);
        expect(response?.headers.get("Content-Type")).toContain("text/plain");
        const identity = (await response?.text())?.trim();
        expect(identity).toBe(await route.identity("main.tsx"));
      },
    );
  });

  it("answers 304 when the request already holds the ETag", async () => {
    await withRoute({ "main.tsx": ENTRY }, async (route) => {
      const first = await route.serve(get("/api/patterns/main.tsx"));
      const etag = first!.headers.get("ETag")!;
      const second = await route.serve(
        get("/api/patterns/main.tsx", { "If-None-Match": etag }),
      );
      expect(second?.status).toBe(304);
      expect(await second?.text()).toBe("");
    });
  });

  it("identifies each attached root set independently of its order and duplicates", async () => {
    await withRoute(
      {
        "main.tsx": ENTRY,
        "first.test.tsx": IMPORTER,
        "second.test.tsx": ENTRY,
        "leaf.ts": ENTRY,
      },
      async (route) => {
        const bare = await route.serve(get("/api/patterns/main.tsx?identity"));
        const first = await route.serve(
          get("/api/patterns/main.tsx?identity&sourceRoot=first.test.tsx"),
        );
        const both = await route.serve(
          get(
            "/api/patterns/main.tsx?identity&sourceRoot=first.test.tsx&sourceRoot=second.test.tsx",
          ),
        );
        expect(first?.status).toBe(200);
        expect(both?.status).toBe(200);
        const bareIdentity = await bare?.text();
        const firstIdentity = await first?.text();
        const bothIdentity = await both?.text();
        expect(firstIdentity).not.toBe(bareIdentity);
        expect(bothIdentity).not.toBe(firstIdentity);
        const equivalent = await route.serve(get(
          "/api/patterns/main.tsx?identity&sourceRoot=second.test.tsx&sourceRoot=first.test.tsx&sourceRoot=first.test.tsx",
          { "If-None-Match": both!.headers.get("ETag")! },
        ));
        expect(equivalent?.status).toBe(304);
        expect(await equivalent?.text()).toBe("");
        const bareAgain = await route.serve(
          get("/api/patterns/main.tsx?identity"),
        );
        expect(await bareAgain?.text()).toBe(bareIdentity);
      },
    );
  });

  it("returns `400` for more than sixteen root parameters before reading files", async () => {
    const roots = Array.from({ length: 16 }, (_, i) => `root-${i}.ts`);
    await withRoute(
      Object.fromEntries([
        ["main.tsx", ENTRY],
        ...roots.map((root) => [root, ENTRY]),
      ]),
      async (route) => {
        const query = new URLSearchParams({ identity: "" });
        for (const root of roots) query.append("sourceRoot", root);
        expect(
          (await route.serve(get(`/api/patterns/main.tsx?${query}`)))?.status,
        ).toBe(200);
        query.append("sourceRoot", roots[0]);
        const response = await route.serve(
          get(`/api/patterns/absent.tsx?${query}`),
        );
        expect(response?.status).toBe(400);
        expect(await response?.json()).toEqual({
          error: "At most 16 source roots may be requested",
        });
        expect(
          (await route.serveFile("absent.tsx", {
            identity: true,
            sourceRoots: [...roots, roots[0]],
          })).status,
        ).toBe(400);
      },
    );
  });

  it("refuses attached roots that escape or ambiguously name a route file", async () => {
    await withRoute({ "main.tsx": ENTRY }, async (route) => {
      for (
        const sourceRoot of [
          "",
          "../main.tsx",
          "/main.tsx",
          "file:main.tsx",
          "%2e%2e/main.tsx",
          "dir/../main.tsx",
          "./main.tsx",
          "dir//main.tsx",
          "dir\\main.tsx",
          "main.tsx?identity",
          "main.tsx#fragment",
          "name with spaces.ts",
          "café.ts",
          "name..part.ts",
          "name%20with%20spaces.ts",
        ]
      ) {
        const query = new URLSearchParams({ identity: "", sourceRoot });
        const response = await route.serve(
          get(`/api/patterns/main.tsx?${query}`),
        );
        expect(response?.status).toBe(400);
      }
    });
  });

  it("refuses an identity whose attached root's import closure is missing", async () => {
    await withRoute(
      { "main.tsx": ENTRY, "main.test.tsx": IMPORTER },
      async (route) => {
        const response = await route.serve(
          get("/api/patterns/main.tsx?identity&sourceRoot=main.test.tsx"),
        );
        expect(response?.status).toBe(404);
      },
    );
  });

  it("answers 404 for a path that names no file", async () => {
    // The three ways a path fails to name one. Each reports itself
    // differently to the read, and the route serves files, never a listing.

    await withRoute({ "system/main.tsx": ENTRY }, async (route) => {
      for (
        const path of [
          "/api/patterns/absent.tsx",
          "/api/patterns/system",
          "/api/patterns/system/main.tsx/below.ts",
        ]
      ) {
        const response = await route.serve(get(path));
        expect(response?.status).toBe(404);
      }
    });
  });

  it("answers 400 for a path that is not valid percent-encoding", async () => {
    // A stray `%` survives URL parsing and reaches the route as written, so
    // the route is what has to decide about it.

    await withRoute({ "main.tsx": ENTRY }, async (route) => {
      const response = await route.serve(get("/api/patterns/%ZZ.tsx"));
      expect(response?.status).toBe(400);
    });
  });

  it("answers 400 for an entry the light identity path cannot model", async () => {
    // A fabric import folds another pattern's identity into this entry, which
    // only a compile resolves. The entry is answerable, just not this way, and
    // a runtime told `500` would read it as a host to try again later.

    await withRoute(
      { "main.tsx": 'import "cf:some/pattern";' },
      async (route) => {
        const response = await route.serve(
          get("/api/patterns/main.tsx?identity"),
        );
        expect(response?.status).toBe(400);
        expect((await response?.json()).error).toContain("fabric import");
      },
    );
  });

  it("answers 500 for a read failure it does not recognize", async () => {
    // The route names the ways a path fails to name a file and answers 404 for
    // each. Anything else the read reports is this host's own fault until
    // somebody says otherwise, which is the answer that gets looked at.

    await withRoute({ "main.tsx": ENTRY }, async (route) => {
      const response = await route.serve(
        get(`/api/patterns/${"a".repeat(300)}.tsx`),
      );
      expect(response?.status).toBe(500);
    });
  });

  it("answers 400 for a path that would leave the tree", async () => {
    await withRoute({ "main.tsx": ENTRY }, async (route) => {
      for (
        const path of [
          "/api/patterns/..%2Fmain.tsx",
          "/api/patterns/%2Fetc%2Fpasswd",
          "/api/patterns/file:passwd",
        ]
      ) {
        const response = await route.serve(get(path));
        expect(response?.status).toBe(400);
      }
    });
  });

  it("declines a request the route does not address", async () => {
    await withRoute({ "main.tsx": ENTRY }, async (route) => {
      expect(await route.serve(get("/main.tsx"))).toBeUndefined();
      expect(await route.serve(get("/api/patterns/"))).toBeUndefined();
      expect(
        await route.serve(
          new Request("https://host.invalid/api/patterns/main.tsx", {
            method: "POST",
          }),
        ),
      ).toBeUndefined();
    });
  });

  it("answers a HEAD with the headers its GET would carry", async () => {
    // A host probing for a file, or revalidating what it holds, asks with
    // HEAD. It is the validator it comes for, so that has to be the same one
    // the body would have arrived with; the host drops the body itself.

    await withRoute({ "main.tsx": ENTRY }, async (route) => {
      const head = await route.serve(
        new Request("https://host.invalid/api/patterns/main.tsx", {
          method: "HEAD",
        }),
      );
      const body = await route.serve(get("/api/patterns/main.tsx"));
      expect(head?.status).toBe(200);
      expect(head?.headers.get("ETag")).toBe(body?.headers.get("ETag"));
      expect(head?.headers.get("Content-Type")).toBe(
        body?.headers.get("Content-Type"),
      );
    });
  });

  it("refuses a name that resolves outside the directory it serves", async () => {
    // `serve` rejects such a path before this, so the guard here is what a
    // host calling the file accessors directly relies on.

    await withRoute({ "main.tsx": ENTRY }, async (route) => {
      await expect(route.get("../outside.tsx")).rejects.toThrow(
        "Path traversal detected",
      );
    });
  });

  it("serves a directory named for a prefix of its own", async () => {
    const root = await tree({ "main.tsx": ENTRY });
    const extra = await tree({ "main.tsx": IMPORTER, "leaf.ts": ENTRY });
    try {
      const route = new PatternsRoute(root, [
        { routePrefix: "connector/", directory: extra },
      ]);
      expect(await route.getText("connector/main.tsx")).toBe(IMPORTER);
      expect(await route.getText("main.tsx")).toBe(ENTRY);
    } finally {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(extra, { recursive: true });
    }
  });
});
