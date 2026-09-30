/** Tests the patterns route over a directory of files it does not know. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { resolveEntryIdentity } from "../src/harness/entry-identity.ts";
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
  it("includes requested source roots in the identity and cache key", async () => {
    const files = {
      "main.tsx": ENTRY,
      "attached.ts": IMPORTER,
      "leaf.ts": ENTRY,
    };
    await withRoute(files, async (route) => {
      const entry = await route.identity("main.tsx");
      const complete = await route.serve(
        get(
          "/api/patterns/main.tsx?identity&sourceRoot=/api/patterns/attached.ts",
        ),
      );
      const expected = await resolveEntryIdentity(
        "/api/patterns/main.tsx",
        (name) => route.getText(name.slice("/api/patterns/".length)),
        { sourceRoots: ["/api/patterns/attached.ts"] },
      );
      expect(complete?.status).toBe(200);
      expect(await complete?.text()).toBe(expected);
      expect(expected).not.toBe(entry);
      expect(await route.identity("main.tsx")).toBe(entry);
    });
  });

  it("preserves encoded source-root names in the complete identity", async () => {
    await withRoute({
      "main.tsx": ENTRY,
      "foo bar.ts": IMPORTER,
      "leaf.ts": ENTRY,
    }, async (route) => {
      const root = "/api/patterns/foo%20bar.ts";
      const url = new URL(
        "https://host.invalid/api/patterns/main.tsx?identity",
      );
      url.searchParams.append("sourceRoot", root);
      const response = await route.serve(new Request(url));
      const expected = await resolveEntryIdentity(
        "/api/patterns/main.tsx",
        async (name) => {
          const source = await route.serve(get(name));
          expect(source?.status).toBe(200);
          return await source!.text();
        },
        { sourceRoots: [root] },
      );
      expect(response?.status).toBe(200);
      expect(await response?.text()).toBe(expected);
    });
  });

  it("rejects attached roots outside the patterns route", async () => {
    await withRoute({ "main.tsx": ENTRY }, async (route) => {
      for (
        const path of [
          "/etc/passwd",
          "/api/patterns/../secret.ts",
          "file:///secret.ts",
          "/api/patterns/%2e%2e/secret.ts",
          "/api/patterns/..%2fsecret.ts",
          "/api/patterns/%252e%252e/secret.ts",
          "/api/patterns/%5csecret.ts",
          "/api/patterns/%00secret.ts",
          "/api/patterns/%",
        ]
      ) {
        const url = new URL(
          "https://host.invalid/api/patterns/main.tsx?identity",
        );
        url.searchParams.append("sourceRoot", path);
        expect((await route.serve(new Request(url)))?.status).toBe(400);
      }
    });
  });

  it("bounds the number of attached roots an identity request can name", async () => {
    await withRoute({ "main.tsx": ENTRY }, async (route) => {
      const url = new URL(
        "https://host.invalid/api/patterns/main.tsx?identity",
      );
      for (let index = 0; index < 33; index++) {
        url.searchParams.append("sourceRoot", `/api/patterns/root-${index}.ts`);
      }
      expect((await route.serve(new Request(url)))?.status).toBe(400);
    });
  });

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
