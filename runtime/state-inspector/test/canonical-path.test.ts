import { expect } from "@std/expect";
import * as Path from "@std/path";
import { describe, it } from "@commonfabric/test-support/test";

import { canonicalPath } from "../canonical-path.ts";

/**
 * A `realPath` over a filesystem holding only the entries of `existing`, each
 * mapped to what it resolves to. It records every path it is asked about, and
 * refuses a second question about the same path with an error that is not
 * `NotFound`, so a walk that loops at the top fails rather than spinning.
 */
function fakeRealPath(existing: Record<string, string>) {
  const asked: string[] = [];
  const realPath = (path: string): Promise<string> => {
    if (asked.includes(path)) {
      return Promise.reject(new Error(`asked twice about ${path}`));
    }
    asked.push(path);
    return path in existing
      ? Promise.resolve(existing[path])
      : Promise.reject(new Deno.errors.NotFound(path));
  };
  return { asked, realPath };
}

describe("canonical-path", () => {
  it("returns the path itself when no ancestor exists, the root included", async () => {
    const root = Path.parse(Path.resolve("/")).root;
    const target = Path.join(root, "missing", "out", "clone");
    const fs = fakeRealPath({});

    expect(await canonicalPath(target, fs.realPath)).toBe(target);
    expect(fs.asked).toEqual([
      target,
      Path.join(root, "missing", "out"),
      Path.join(root, "missing"),
      root,
    ]);
  });

  it("returns the nearest existing ancestor resolved, with the missing components re-appended", async () => {
    const root = Path.parse(Path.resolve("/")).root;
    const alias = Path.join(root, "alias");
    const real = Path.join(root, "real");
    const fs = fakeRealPath({ [alias]: real });

    expect(await canonicalPath(Path.join(alias, "a", "b"), fs.realPath))
      .toBe(Path.join(real, "a", "b"));
    expect(fs.asked).not.toContain(root);
  });

  it("returns an absolute path for a relative one", async () => {
    const fs = fakeRealPath({});

    expect(await canonicalPath("relative/target", fs.realPath))
      .toBe(Path.resolve("relative/target"));
  });

  it("rethrows an error other than `NotFound`", async () => {
    const denied = new Deno.errors.PermissionDenied("denied");

    await expect(canonicalPath("/anywhere", () => Promise.reject(denied)))
      .rejects.toBe(denied);
  });
});
