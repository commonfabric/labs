import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import config from "../../console/felt.config.ts";

describe("felt.config", () => {
  const consoleRoot = fromFileUrl(new URL("../../console", import.meta.url));

  /**
   * Where each page is served, so its script paths — written RELATIVE to the
   * page (`console/src/mount.ts`: the console may be fronted under a host's
   * prefix) — resolve to what the server is asked for.
   */
  const servedAt: Readonly<Record<string, string>> = {
    "index.html": "/",
    "live.html": "/live/session",
  };

  /** Every script a served page asks the browser to load, as a server path. */
  const scriptsNamedBy = (page: string): readonly string[] => {
    const markup = Deno.readTextFileSync(join(consoleRoot, "public", page));
    return [...markup.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) =>
      new URL(match[1], `http://console${servedAt[page]}`).pathname
    );
  };

  it("emits a bundle for every script the console's pages name", () => {
    // A page whose script has no entry is served, loads nothing, and shows an
    // empty body with no error anywhere — so what the markup asks for and what
    // the build emits are pinned against each other rather than kept in
    // agreement by hand.
    const emitted = config.entries.map((entry) => `/${entry.out}.js`);

    for (const page of ["index.html", "live.html"]) {
      for (const script of scriptsNamedBy(page)) {
        expect(emitted).toContain(script);
      }
    }
  });

  it("names every asset relative to the page, never from the origin's root", () => {
    // A root-absolute `/scripts/...` or `/styles/...` works only when the
    // console is the whole origin. Fronted under a host's prefix (loom's
    // /harness-console) it resolves against the host instead and the page
    // loads nothing; the CSP's `base-uri 'none'` rules out a <base> fix.
    for (const page of ["index.html", "live.html"]) {
      const markup = Deno.readTextFileSync(join(consoleRoot, "public", page));
      const references = [...markup.matchAll(/(?:src|href)="([^"]+)"/g)].map((
        match,
      ) => match[1]);
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) {
        expect(reference.startsWith("/")).toBe(false);
      }
    }
  });

  it("builds each entry from a source file that is there", () => {
    for (const entry of config.entries) {
      expect(Deno.statSync(join(consoleRoot, entry.in)).isFile).toBe(true);
    }
  });

  it("serves the built pages from the directory the server reads", () => {
    // `ConsoleServer.#asset` resolves against `dist/`, and the page files come
    // from `publicDir`; a build writing anywhere else serves nothing.
    expect(config.outDir).toBe("dist");
    expect(config.publicDir).toBe("public");
  });
});
