// deno-lint-ignore-file cf-imports/no-inline-module-import -- the environment
// is parsed once, as env.ts loads, so the variables this file sets must be set
// before the router pulls it in.

// The disabled state of the dump endpoint, as an integration test. env is a
// module-load singleton, so this lives in its own test file (fresh module
// graph): MEMORY_DUMP_ENABLED is deliberately NOT set before the router is
// imported, and the routes must 404 as if they never existed — even for a
// validly signed, allowlisted caller.

import { expect } from "@std/expect";
import * as Path from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { signFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";

const DUMP_BASE = "/api/storage/memory/dump";

const tmp = await Deno.makeTempDir({ prefix: "cf-dump-disabled-" });
const allowed = await Identity.fromPassphrase("dump disabled-state signer");

Deno.env.set("MEMORY_DIR", Path.toFileUrl(`${tmp}/`).href);
Deno.env.delete("MEMORY_DUMP_ENABLED"); // the default: off
Deno.env.set("MEMORY_DUMP_DIDS", allowed.did());

const { createTestApp } = await import("@/lib/create-app.ts");
const { default: dumpRouter } = await import("./memory-dump.index.ts");
const app = createTestApp(dumpRouter);

describe("memory dump endpoint (disabled)", () => {
  it("404s the list route even for a signed, allowlisted caller", async () => {
    const headers = await signFirstPartyHttpRequest({
      url: new URL(DUMP_BASE, "http://localhost"),
      method: "GET",
      signer: allowed,
    });
    const res = await app.request(DUMP_BASE, { headers });
    await res.body?.cancel();
    expect(res.status).toBe(404);
  });

  it("404s the per-space route without touching auth", async () => {
    // No auth headers at all: when disabled the gate must 404 (invisible),
    // not 401 (which would reveal the endpoint exists).
    const res = await app.request(`${DUMP_BASE}/did:key:zAnything`);
    await res.body?.cancel();
    expect(res.status).toBe(404);
  });
});
