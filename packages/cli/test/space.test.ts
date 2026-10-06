// `cf space` end to end through the real CLI process: the rehearsal loop an
// operator actually runs (clone → attempt → verify → reset → verify) plus the
// two things a script depends on — a nonzero exit when content moved, and a
// refusal to write into the live store.
//
// The library's semantics are covered in packages/state-inspector/test/; this
// suite guards the command surface and its exit codes.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";
import { clonePaths } from "@commonfabric/state-inspector";
import { cf, stripAnsi } from "./utils.ts";

/**
 * `CliResult` streams are line arrays; join before substring assertions.
 *
 * The escapes go too: the CLI colors help and error output whenever the
 * environment asks for color, so an assertion on raw text passes or fails by
 * where the developer ran it.
 */
const text = (lines: string[]): string => stripAnsi(lines.join("\n"));

/**
 * Staging directories `--from <url>` may have created, by name.
 *
 * Callers compare a before/after set rather than asserting the system temp
 * directory holds none: it is shared, so an unrelated leftover would fail that
 * spuriously and forever.
 */
async function stagingDirs(): Promise<Set<string>> {
  const found = new Set<string>();
  for await (const entry of Deno.readDir(Deno.env.get("TMPDIR") ?? "/tmp")) {
    if (entry.name.startsWith("cf-space-clone-")) found.add(entry.name);
  }
  return found;
}

const SPACE = "did:key:z6MkCliCloneTest";
const SESSION = "session:did:key:zSpaceAAAA:11111111-2222-3333";
const MODULE_IDENTITY = "pf1v3J_M5Nep7cq-Uh8EYG0ZQaE217FfDfcjbwGdjVI";

const link = (id: string) => ({ "/": { "link@1": { id, path: [] } } });

/** A source snapshot with one piece, one authored cell, one generated cell. */
function seedSnapshot(path: string): void {
  const db = new Database(path, { create: true });
  db.exec(`
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL,
  invocation_ref TEXT, authorization_ref TEXT,
  original JSON NOT NULL, resolution JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space', seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON, commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);`);
  appendDocs(db, [
    ["of:piece", {
      value: { $NAME: "Board" },
      argument: link("of:input"),
      internal: [
        { partialCause: "entries", link: link("of:named") },
        { partialCause: { $generated: 0 }, link: link("of:generated") },
      ],
      patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
      schema: { type: "object", properties: {}, $defs: {} },
    }],
    ["of:input", { value: { title: "a topic" } }],
    ["of:named", { value: "named-v1", result: link("of:piece") }],
    ["of:generated", { value: "generated-v1", result: link("of:piece") }],
  ]);
  db.close();
}

function appendDocs(db: Database, docs: [string, unknown][]): void {
  const base = db.prepare(`SELECT coalesce(max(seq), 0) s FROM "commit"`)
    .get<{ s: number }>()!.s;
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, ?, ?, '{}', '{}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, scope_key, seq, op_index, op, data, commit_seq)
     VALUES (?, 'space', ?, 0, 'set', ?, ?)`,
  );
  docs.forEach(([id, doc], i) => {
    const seq = base + i + 1;
    commit.run(seq, SESSION, seq);
    rev.run(id, seq, JSON.stringify(doc), seq);
  });
}

/** The working copy's path, derived the way the server resolves it — never
 *  spelled out here, which is what let an earlier version of this suite pass
 *  against a store no server would read. */
const workingCopy = (dir: string): string => clonePaths(dir, SPACE).workingPath;

/** Apply writes to the clone's working copy, as a rehearsal attempt would. */
function writeToWorkingCopy(dir: string, docs: [string, unknown][]): void {
  const db = new Database(workingCopy(dir));
  appendDocs(db, docs);
  db.close();
}

async function withFixture(
  run: (t: { snapshot: string; clone: string; root: string }) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "cf-space-test-" });
  try {
    const snapshotDir = `${root}/snapshot`;
    await Deno.mkdir(snapshotDir);
    const snapshot = `${snapshotDir}/${SPACE}.sqlite`;
    seedSnapshot(snapshot);
    await run({ snapshot, clone: `${root}/clone`, root });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

describe("cf space", () => {
  it("runs the rehearsal loop: clone, attempt, verify, reset", async () => {
    await withFixture(async ({ snapshot, clone }) => {
      const cloned = await cf(
        `space clone ${SPACE} --from ${snapshot} --to ${clone}`,
      );
      expect(cloned.code).toBe(0);
      // The working copy lands where the memory server resolves a space store,
      // so MEMORY_DIR can serve the clone under the same DID.
      expect(text(cloned.stdout)).toContain(workingCopy(clone));
      expect(text(cloned.stdout)).toContain("1 generated cells excluded");

      const clean = await cf(`space verify ${clone}`);
      expect(clean.code).toBe(0);
      expect(text(clean.stdout)).toContain("content    unchanged");

      // A rehearsal attempt that damages authored content.
      writeToWorkingCopy(clone, [["of:input", {
        value: { title: "CLOBBERED" },
      }]]);

      const damaged = await cf(`space verify ${clone}`);
      expect(damaged.code).toBe(1);
      expect(text(damaged.stdout)).toContain("content    CHANGED");

      const reset = await cf(`space reset ${clone}`);
      expect(reset.code).toBe(0);
      expect(text(reset.stdout)).toContain("matches baseline");

      const recovered = await cf(`space verify ${clone}`);
      expect(recovered.code).toBe(0);
    });
  });

  it("names what a reset removed, apart from the space it restored", async () => {
    // A pass that follows a link into another space leaves that space's store
    // beside the working copy, and cell-derived databases sit there too. Both
    // are the attempt's; `--json` keeps a store's DID and a cell database's file
    // name in separate fields, so a script reading the DIDs reads only spaces.
    await withFixture(async ({ snapshot, clone }) => {
      expect(
        (await cf(`space clone ${SPACE} --from ${snapshot} --to ${clone}`))
          .code,
      ).toBe(0);
      const engineDir = workingCopy(clone).replace(/\/[^/]*$/, "");
      const other = "did:key:z6MkCliOtherSpace";
      new Database(`${engineDir}/${other}.sqlite`).close();
      await Deno.writeTextFile(`${engineDir}/cell-abc123.sqlite`, "");

      const reset = await cf(`space reset ${clone} --json`);
      expect(reset.code).toBe(0);
      const report = JSON.parse(reset.stdout.join("\n"));
      expect(report.removedStores).toEqual([other]);
      expect(report.removedCellDatabases).toEqual(["cell-abc123.sqlite"]);
      expect(await exists(`${engineDir}/${other}.sqlite`)).toBe(false);
      expect(await exists(`${engineDir}/cell-abc123.sqlite`)).toBe(false);
    });
  });

  it("says when a clone predates fingerprint-scheme recording", async () => {
    // A version-1 clone never recorded how its baseline was fingerprinted, so
    // its verdict rests on an assumption the report has to state.
    await withFixture(async ({ snapshot, clone }) => {
      expect(
        (await cf(`space clone ${SPACE} --from ${snapshot} --to ${clone}`))
          .code,
      ).toBe(0);
      const manifestPath = `${clone}/clone.json`;
      const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
      delete manifest.fingerprint.scheme;
      await Deno.writeTextFile(
        manifestPath,
        JSON.stringify({ ...manifest, version: 1 }),
      );

      const verified = await cf(`space verify ${clone}`);
      expect(verified.code).toBe(0);
      expect(text(verified.stdout)).toContain(
        "predates fingerprint-scheme recording",
      );
    });
  });

  it("passes verification when only generated cells were rewritten", async () => {
    // A clean pattern update rotates generated cells and adds commits. If that
    // failed verification, every legitimate migration would look like data loss.
    await withFixture(async ({ snapshot, clone }) => {
      await cf(`space clone ${SPACE} --from ${snapshot} --to ${clone}`);
      writeToWorkingCopy(clone, [
        ["of:generated", { value: "generated-v2", result: link("of:piece") }],
      ]);

      const result = await cf(`space verify ${clone}`);
      expect(result.code).toBe(0);
      expect(text(result.stdout)).toContain("content    unchanged");
      // ...and the growth is still reported, not hidden.
      expect(text(result.stdout)).toContain("commits    4 → 5");
    });
  });

  it("refuses to write a clone into the live store directory", async () => {
    await withFixture(async ({ snapshot, root }) => {
      const live = `${root}/live-memory`;
      await Deno.mkdir(live);
      // MEMORY_DIR is how the CLI learns what the local server is serving.
      const result = await cf(
        `space clone ${SPACE} --from ${snapshot} --to ${live}/clone`,
        { env: { MEMORY_DIR: `file://${live}/` } },
      );
      expect(result.code).not.toBe(0);
      expect(text(result.stderr)).toContain(
        "overlaps the live store directory",
      );
      expect(await exists(`${live}/clone`)).toBe(false);
    });
  });

  it("reports a fingerprint that ignores generated-cell churn", async () => {
    await withFixture(async ({ snapshot, clone }) => {
      await cf(`space clone ${SPACE} --from ${snapshot} --to ${clone}`);
      const working = workingCopy(clone);

      const before = await cf(`space fingerprint ${working}`);
      expect(before.code).toBe(0);
      expect(text(before.stdout)).toContain("3 entities fingerprinted");

      writeToWorkingCopy(clone, [
        ["of:generated", { value: "generated-v2", result: link("of:piece") }],
      ]);
      const after = await cf(`space fingerprint ${working}`);
      expect(after.stdout[0]).toBe(before.stdout[0]);

      // --include-generated deliberately inverts that.
      const loose = await cf(
        `space fingerprint ${working} --include-generated`,
      );
      expect(loose.stdout[0]).not.toBe(before.stdout[0]);
    });
  });

  it("--expect-migration passes a rewrite and still fails a removal", async () => {
    // The flag decides verify's EXIT CODE, which is the only machine-readable
    // signal a rehearsal script has. Without it a successful migration exits
    // nonzero and the script stops on success; with it, a removal must still
    // fail or the gate is worthless.
    await withFixture(async ({ snapshot, clone }) => {
      await cf(`space clone ${SPACE} --from ${snapshot} --to ${clone}`);

      // What a migration looks like: derived values rewritten, nothing dropped.
      writeToWorkingCopy(clone, [
        ["of:named", { value: "rewritten", result: link("of:piece") }],
      ]);
      const strict = await cf(`space verify ${clone}`);
      expect(strict.code).toBe(1); // any change fails the strict default
      const relaxed = await cf(`space verify ${clone} --expect-migration`);
      expect(relaxed.code).toBe(0); // ...but is the expected migration outcome
      expect(text(relaxed.stdout)).toContain("removed    0");

      // A removal must fail even with the flag, or the gate protects nothing.
      const db = new Database(workingCopy(clone));
      db.exec(`DELETE FROM revision WHERE id = 'of:named'`);
      db.close();
      const removed = await cf(`space verify ${clone} --expect-migration`);
      expect(removed.code).toBe(1);
      expect(text(removed.stdout)).toContain("ENTITIES REMOVED");
    });
  });

  it("requires --from and --to, and says what they are for", async () => {
    await withFixture(async ({ snapshot, clone }) => {
      const noFrom = await cf(`space clone ${SPACE} --to ${clone}`);
      expect(noFrom.code).not.toBe(0);
      expect(text(noFrom.stderr)).toContain("--from is required");
      // The message points at the sanctioned way to obtain a production
      // snapshot, since the dump endpoint is deliberately off there.
      expect(text(noFrom.stderr)).toContain("VACUUM INTO");

      const noTo = await cf(`space clone ${SPACE} --from ${snapshot}`);
      expect(noTo.code).not.toBe(0);
      expect(text(noTo.stderr)).toContain("--to is required");
    });
  });

  it("downloads an https snapshot and does not leave it behind", async () => {
    // `--from <url>` is the S3 hop the July rehearsal used to share one
    // snapshot across operators. A real snapshot is gigabytes, so the staging
    // copy must not survive the command.
    await withFixture(async ({ snapshot, clone }) => {
      const before = await stagingDirs();

      const body = await Deno.readFile(snapshot);
      const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen: () => {} },
        () => new Response(body),
      );
      const url = `http://127.0.0.1:${server.addr.port}/snapshot.sqlite`;
      try {
        const result = await cf(
          `space clone ${SPACE} --from ${url} --to ${clone}`,
        );
        expect(result.code).toBe(0);
        expect(text(result.stdout)).toContain("1 generated cells excluded");
        // The clone is real and verifies against its own manifest.
        expect((await cf(`space verify ${clone}`)).code).toBe(0);
      } finally {
        await server.shutdown();
      }

      const after = await stagingDirs();
      const leaked = [...after].filter((name) => !before.has(name));
      expect(leaked).toEqual([]);
    });
  });

  it("cleans up staging when the download dies mid-stream", async () => {
    // The failure a status check cannot catch: headers say 200, then the
    // connection drops. At the gigabyte scale `--from <url>` exists for, the
    // partial file stranded in the system temp directory is however much
    // arrived — so cleanup has to live where the failure does, not with a
    // caller that never received a directory to clean.
    await withFixture(async ({ snapshot, clone }) => {
      const before = await stagingDirs();

      const body = await Deno.readFile(snapshot);
      const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen: () => {} },
        () =>
          // Promise a full-length body and deliver a prefix, so the truncation
          // surfaces on the CLIENT as a short read. Erroring the stream instead
          // would work too, but the server-side abort prints a stack trace into
          // every run of this suite.
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(body.slice(0, 512));
                controller.close();
              },
            }),
            { headers: { "content-length": String(body.length) } },
          ),
      );
      const url = `http://127.0.0.1:${server.addr.port}/snapshot.sqlite`;
      try {
        const result = await cf(
          `space clone ${SPACE} --from ${url} --to ${clone}`,
        );
        expect(result.code).not.toBe(0);
      } finally {
        await server.shutdown();
      }

      const leaked = [...await stagingDirs()].filter((n) => !before.has(n));
      expect(leaked).toEqual([]);
    });
  });

  it("refuses a redirect that downgrades to plaintext http", async () => {
    // Validating only the URL an operator typed proves nothing about where the
    // bytes came from: `fetch` follows redirects itself and reports only the
    // final response, so a permitted origin that 302s elsewhere would carry the
    // whole space over the redirected transport, having passed the check.
    await withFixture(async ({ clone }) => {
      const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen: () => {} },
        () =>
          new Response(null, {
            status: 302,
            headers: { location: "http://example.com/snapshot.sqlite" },
          }),
      );
      const url = `http://127.0.0.1:${server.addr.port}/snapshot.sqlite`;
      try {
        const result = await cf(
          `space clone ${SPACE} --from ${url} --to ${clone}`,
        );
        expect(result.code).not.toBe(0);
        expect(text(result.stderr)).toContain("refusing to download");
      } finally {
        await server.shutdown();
      }
    });
  });

  it("follows a permitted redirect and clones what it lands on", async () => {
    // The other half: refusing the downgrade must not refuse redirects as
    // such, or `--from <s3-url>` — the whole reason the flag takes a URL —
    // stops working the first time a bucket redirects.
    await withFixture(async ({ snapshot, clone }) => {
      const body = await Deno.readFile(snapshot);
      const target = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen: () => {} },
        () => new Response(body),
      );
      const redirector = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen: () => {} },
        () =>
          new Response(null, {
            status: 302,
            // Relative, so this also pins that a bare `Location` resolves
            // against the URL it came from rather than being taken verbatim.
            headers: {
              location: `http://127.0.0.1:${target.addr.port}/s.sqlite`,
            },
          }),
      );
      try {
        const result = await cf(
          `space clone ${SPACE} ` +
            `--from http://127.0.0.1:${redirector.addr.port}/go --to ${clone}`,
        );
        expect(result.code).toBe(0);
        expect((await cf(`space verify ${clone}`)).code).toBe(0);
      } finally {
        await redirector.shutdown();
        await target.shutdown();
      }
    });
  });

  it("refuses to pull a whole-space snapshot over plaintext http", async () => {
    // A snapshot is the entire contents of a space — the same confidentiality
    // judgment that keeps the dump endpoint off in production. Loopback is
    // exempt (it never leaves the machine) and the tests above rely on that.
    await withFixture(async ({ clone }) => {
      const result = await cf(
        `space clone ${SPACE} --from http://example.com/s.sqlite --to ${clone}`,
      );
      expect(result.code).not.toBe(0);
      expect(text(result.stderr)).toContain("refusing to download");
    });
  });

  it("accepts https and fails on the network, not on the transport check", async () => {
    // The guard must let the transport it exists to require actually through.
    // Nothing listens on this port, so the request fails at connect — the point
    // is that it got as far as connecting.
    await withFixture(async ({ clone }) => {
      const result = await cf(
        `space clone ${SPACE} --from https://127.0.0.1:9/s.sqlite --to ${clone}`,
      );
      expect(result.code).not.toBe(0);
      expect(text(result.stderr)).not.toContain("refusing to download");
    });
  });

  it("gives up on a redirect loop instead of following it forever", async () => {
    await withFixture(async ({ clone }) => {
      let hops = 0;
      const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen: () => {} },
        (request) => {
          hops++;
          return new Response(null, {
            status: 302,
            headers: { location: new URL(request.url).pathname + "x" },
          });
        },
      );
      try {
        const result = await cf(
          `space clone ${SPACE} ` +
            `--from http://127.0.0.1:${server.addr.port}/go --to ${clone}`,
        );
        expect(result.code).not.toBe(0);
        expect(text(result.stderr)).toContain("redirects");
        // Bounded, and bounded by the hop limit rather than by exhaustion.
        expect(hops).toBeLessThanOrEqual(6);
      } finally {
        await server.shutdown();
      }
    });
  });

  it("warns that an ambiguous id could hide a change to it", async () => {
    // An id one manifest calls generated and another calls named is counted as
    // generated and excluded, so a change to it never reaches the verdict.
    // Nothing gates on this, which makes saying it the whole protection.
    await withFixture(async ({ snapshot, clone }) => {
      await cf(`space clone ${SPACE} --from ${snapshot} --to ${clone}`);
      const manifestPath = `${clone}/clone.json`;
      const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
      manifest.fingerprint.ambiguous = 1;
      await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));

      const result = await cf(`space verify ${clone}`);
      expect(result.code).toBe(0);
      expect(text(result.stdout)).toContain("would not show");
    });
  });

  it("says so when a clone cannot report what its BASELINE excluded", async () => {
    // An entity excluded from the baseline is absent from the "before" side, so
    // if it is still excluded now the diff cannot compare it at all and a change
    // to it is silent. That blind spot belongs to the baseline and never shows
    // up in a working-copy count — and on a clone predating the recording its
    // size is unknown, which is a weaker claim than zero and must not render as
    // zero.
    await withFixture(async ({ snapshot, clone }) => {
      await cf(`space clone ${SPACE} --from ${snapshot} --to ${clone}`);

      const manifestPath = `${clone}/clone.json`;
      const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
      expect(manifest.fingerprint.unhashable).toBe(0);
      delete manifest.fingerprint.unhashable;
      delete manifest.fingerprint.ambiguous;
      await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));

      const result = await cf(`space verify ${clone}`);
      expect(result.code).toBe(0);
      expect(text(result.stdout)).toContain("predates uncertainty recording");
    });
  });

  it("reports uncertainty the BASELINE carried, not just the working copy", async () => {
    await withFixture(async ({ snapshot, clone }) => {
      await cf(`space clone ${SPACE} --from ${snapshot} --to ${clone}`);

      // Stand in for a baseline that excluded entities: the working copy is
      // untouched, so nothing on the "after" side would mention them.
      const manifestPath = `${clone}/clone.json`;
      const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
      manifest.fingerprint.unhashable = 2;
      await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));

      const result = await cf(`space verify ${clone}`);
      expect(result.code).toBe(0);
      const out = text(result.stdout);
      expect(out).toContain("content    unchanged");
      expect(out).toContain("in the BASELINE");
      expect(out).toContain("2 entities could not be hashed");
    });
  });

  it("emits machine-readable JSON for clone, verify and fingerprint", async () => {
    await withFixture(async ({ snapshot, clone }) => {
      const cloned = await cf(
        `space clone ${SPACE} --from ${snapshot} --to ${clone} --json`,
      );
      expect(cloned.code).toBe(0);
      const { manifest, paths } = JSON.parse(text(cloned.stdout));
      expect(manifest.space).toBe(SPACE);
      expect(manifest.version).toBe(2);
      expect(typeof manifest.fingerprint.scheme).toBe("number");
      // The reported path is absolute, so the printed serve line is a usable
      // file:// URL even when --to was relative.
      expect(paths.workingPath.startsWith("/")).toBe(true);

      const verified = JSON.parse(
        text((await cf(`space verify ${clone} --json`)).stdout),
      );
      expect(verified.ok).toBe(true);
      expect(verified.fingerprint.match).toBe(true);

      const fp = JSON.parse(
        text(
          (await cf(`space fingerprint ${paths.workingPath} --json`)).stdout,
        ),
      );
      expect(fp.hash).toBe(manifest.fingerprint.hash);
      expect(fp.ambiguous).toEqual([]);
    });
  });

  it("lists per-entity hashes and flags entities it could not hash", async () => {
    // A ~5,000-deep value parses but overflows the canonical hasher. The
    // listing must name it rather than let it vanish from the roll-up.
    await withFixture(async ({ snapshot, clone }) => {
      await cf(`space clone ${SPACE} --from ${snapshot} --to ${clone}`);
      const working = workingCopy(clone);
      let deep: unknown = null;
      for (let i = 0; i < 5000; i++) deep = { a: deep };
      writeToWorkingCopy(clone, [["of:pathological", { value: deep }]]);

      const result = await cf(`space fingerprint ${working} --per-entity`);
      expect(result.code).toBe(0);
      const output = text(result.stdout);
      expect(output).toContain("could not be");
      expect(output).toContain("of:pathological");
      // --per-entity lists the ordinary entities alongside their kind.
      expect(output).toContain("of:input");
    });
  });

  it("exits nonzero when a reset cannot restore the baseline", async () => {
    await withFixture(async ({ snapshot, clone }) => {
      await cf(`space clone ${SPACE} --from ${snapshot} --to ${clone}`);
      // Corrupt the baseline itself: reset will "succeed" mechanically but the
      // clone no longer matches its manifest, which must not report success.
      const pristine = clonePaths(clone, SPACE).pristinePath;
      const db = new Database(pristine);
      appendDocs(db, [["of:input", { value: { title: "ROTTED BASELINE" } }]]);
      db.close();

      const result = await cf(`space reset ${clone}`);
      expect(result.code).toBe(1);
    });
  });

  it("refuses a target inside DB_PATH's directory too", async () => {
    // Single-file mode: the live store is a file, so its DIRECTORY is what a
    // clone must stay out of.
    await withFixture(async ({ snapshot, root }) => {
      const live = `${root}/single-file`;
      await Deno.mkdir(live);
      const result = await cf(
        `space clone ${SPACE} --from ${snapshot} --to ${live}/clone`,
        { env: { DB_PATH: `${live}/store.sqlite` } },
      );
      expect(result.code).not.toBe(0);
      expect(text(result.stderr)).toContain(
        "overlaps the live store directory",
      );
    });
  });

  it("tolerates a malformed MEMORY_DIR instead of crashing", async () => {
    // MEMORY_DIR comes from the environment and may be junk; that must not
    // stop an operator from making a clone somewhere harmless.
    await withFixture(async ({ snapshot, clone }) => {
      const result = await cf(
        `space clone ${SPACE} --from ${snapshot} --to ${clone}`,
        { env: { MEMORY_DIR: "file://[not-a-url" } },
      );
      expect(result.code).toBe(0);
    });
  });

  it("reports an HTTP failure on --from instead of a partial clone", async () => {
    await withFixture(async ({ clone }) => {
      const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen: () => {} },
        () => new Response("nope", { status: 404 }),
      );
      const url = `http://127.0.0.1:${server.addr.port}/missing.sqlite`;
      try {
        const result = await cf(
          `space clone ${SPACE} --from ${url} --to ${clone}`,
        );
        expect(result.code).not.toBe(0);
        expect(text(result.stderr)).toContain("HTTP 404");
      } finally {
        await server.shutdown();
      }
      expect(await exists(clone)).toBe(false);
    });
  });

  it("keeps usage help off stdout when --json was requested", async () => {
    // stdout is reserved for the JSON payload, so a failing command must not
    // print usage help into it and corrupt a caller's parse.
    //
    // This must be a VALIDATION error: cliffy prints usage help to stdout for
    // those and not for ordinary thrown errors, so testing with a plain error
    // would pass even with the guard deleted.
    await withFixture(async () => {
      const withoutJson = await cf(`space clone ${SPACE} --to /tmp/unused`);
      expect(withoutJson.code).not.toBe(0);
      expect(text(withoutJson.stdout)).toContain("Usage:"); // help on stdout...

      const withJson = await cf(`space clone ${SPACE} --to /tmp/unused --json`);
      expect(withJson.code).not.toBe(0);
      expect(text(withJson.stdout).trim()).toBe(""); // ...suppressed here
      expect(text(withJson.stderr)).toContain("--from is required");
    });
  });

  it("flags an id that one manifest generates and another names", async () => {
    // Rotation-prone wins so the fingerprint stays stable, but that choice can
    // hide a real content change, so it must never be silent.
    await withFixture(async ({ snapshot, clone }) => {
      await cf(`space clone ${SPACE} --from ${snapshot} --to ${clone}`);
      const working = workingCopy(clone);
      writeToWorkingCopy(clone, [
        ["of:second-piece", {
          value: { $NAME: "Other" },
          argument: link("of:input"),
          // Names the cell the first piece calls compiler-generated.
          internal: [{ partialCause: "entries", link: link("of:generated") }],
          patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
          schema: { type: "object", properties: {}, $defs: {} },
        }],
      ]);

      const result = await cf(`space fingerprint ${working}`);
      expect(result.code).toBe(0);
      expect(text(result.stdout)).toContain("generated in one");
    });
  });

  it("rejects a directory that is not a clone", async () => {
    await withFixture(async ({ root }) => {
      const result = await cf(`space verify ${root}`);
      expect(result.code).not.toBe(0);
      expect(text(result.stderr)).toContain("is not a clone directory");
    });
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
