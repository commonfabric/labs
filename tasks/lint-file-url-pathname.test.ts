/// <reference lib="deno.unstable" />

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import plugin from "./lint-file-url-pathname.ts";

/** The source text of each `pathname` read the rule reports in `source`. */
function reported(source: string): string[] {
  return Deno.lint.runPlugin(plugin, "sample.ts", source).map((diagnostic) =>
    source.slice(...diagnostic.range)
  );
}

describe("lint-file-url-pathname", () => {
  it("reports `pathname` read off a URL built from `import.meta`", () => {
    expect(reported(`
      new URL("../..", import.meta.url).pathname;
      new URL(import.meta.url).pathname.split("/");
      new URL(import.meta.resolve("./x.ts")).pathname;
    `)).toEqual([
      'new URL("../..", import.meta.url).pathname',
      "new URL(import.meta.url).pathname",
      'new URL(import.meta.resolve("./x.ts")).pathname',
    ]);
  });

  it("reports `pathname` read off a `file:` literal and `toFileUrl`", () => {
    expect(reported(`
      new URL("file:///tmp/x").pathname;
      new URL(\`file://\${list}\`).pathname;
      toFileUrl(path).pathname;
      Path.toFileUrl(path).pathname;
    `)).toEqual([
      'new URL("file:///tmp/x").pathname',
      "new URL(`file://${list}`).pathname",
      "toFileUrl(path).pathname",
      "Path.toFileUrl(path).pathname",
    ]);
  });

  it("reports `pathname` read through a type assertion", () => {
    expect(reported(`
      (new URL("./x.ts", import.meta.url) as URL).pathname;
      (toFileUrl(path) satisfies URL).pathname;
      URL.parse("./x.ts", import.meta.url)!.pathname;
    `)).toEqual([
      '(new URL("./x.ts", import.meta.url) as URL).pathname',
      "(toFileUrl(path) satisfies URL).pathname",
      'URL.parse("./x.ts", import.meta.url)!.pathname',
    ]);
  });

  it("reports `pathname` destructured from a file URL", () => {
    expect(reported(`
      const { pathname } = new URL("../..", import.meta.url);
      const { pathname: root, href } = toFileUrl(path);
      const { pathname: other } = new URL(request.url);
      const { [pathname]: value } = new URL("./x.ts", import.meta.url);
    `)).toEqual(["pathname", "pathname"]);
  });

  it("returns nothing for a URL that is not visibly a file's", () => {
    expect(reported(`
      new URL(request.url).pathname;
      new URL("/api", "http://host.invalid").pathname;
      url.pathname;
      fromFileUrl(new URL("../..", import.meta.url));
      new URL("./x.ts", import.meta.url).href;
      URL.parse(request.url)!.pathname;
    `)).toEqual([]);
  });

  it("returns nothing for an assignment to a file URL's `pathname`", () => {
    expect(reported(`
      toFileUrl(root).pathname = join(base, name);
      toFileUrl(root).pathname += "/";
    `)).toEqual([]);
  });
});
