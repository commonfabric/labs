// `cf space` — the commands that act on a space.
//
// The noun is what the verb acts on, rather than what it ranges over.
// `recreate-root` and `set-home` rebuild a space's root and home patterns
// against a running server; `clone`, `verify`, `reset` and `fingerprint` work
// on the same space as a store on disk. Both are the space, reached at
// different moments in its life, which is what puts them under one noun.
//
// The rehearsal-clone workflow those four serve is in
// docs/plans/space-clone-rehearsal.md: make a writable copy of a real space,
// run a migration against it, judge the result, reset, repeat.
//
// `verify` and `reset` take a clone directory rather than a space, because a
// rehearsal copy is identified by where it was written. The noun does not
// resolve that: their argument names the copy, not the space it is a copy of.
//
// Why `inspect` stays a separate noun when it also acts on a store: that split
// is contract, not noun. `inspect` is read-only — it explains, it never
// reproduces or replays — and that boundary is what makes it trustworthy. A
// clone exists precisely to be written to. One object, two nouns, kept apart
// by what each promises about it rather than by what each addresses.
//
// Acquiring the snapshot stays manual for production, by design: the dump
// endpoint is hard-off there (see memory-dump-policy.ts) and a whole-space dump
// is a confidentiality decision, not an ergonomics one. `--from` therefore takes
// a file an operator already has (typically `VACUUM INTO` server-side, then
// scp), or an https URL (the S3 hop the July rehearsal used to share one
// snapshot across operators).

import { Command, ValidationError } from "@cliffy/command";
import { configuredStorePath } from "@commonfabric/memory/v2/storage-path";
import {
  clonePaths,
  contentFingerprint,
  createClone,
  openSpace,
  readManifest,
  resetClone,
  resolveSpace,
  verifyClone,
  type VerifyResult,
} from "@commonfabric/state-inspector";

import { buildSpaceInviteCommand } from "./space-invites.ts";
import { hasJsonArgument } from "../lib/json-output.ts";
import { buildRecreateRootCommand, buildSetHomeCommand } from "./piece.ts";

function out(json: boolean, data: unknown, render: () => void): void {
  if (json) console.log(JSON.stringify(data, null, 2));
  else render();
}

/**
 * Store directories a clone must never be written into: whatever the
 * environment says a local server is serving. Explicit paths, not a guess about
 * what looks like production.
 */
function liveStoreDirs(): string[] {
  const dirs: string[] = [];
  const memoryDir = Deno.env.get("MEMORY_DIR");
  if (memoryDir) dirs.push(configuredStorePath(memoryDir));
  const dbPath = Deno.env.get("DB_PATH");
  if (dbPath) dirs.push(dbPath.replace(/\/[^/]*$/, ""));
  // The toolshed's default when neither is set is `./cache/memory/` relative to
  // its working directory; a clone landing there would be served unintentionally.
  dirs.push(`${Deno.cwd()}/cache/memory`);
  return dirs;
}

/**
 * Reject a snapshot URL that would put a whole space on the wire in the clear.
 *
 * A snapshot is the entire contents of a space — the same confidentiality
 * judgment that keeps the dump endpoint hard-off in production — so plaintext
 * transport is refused rather than merely discouraged in the help text.
 * Loopback is the exception: it never leaves the machine, and the tests serve
 * fixtures over it.
 */
function assertConfidentialTransport(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol === "https:") return;
  const loopback = parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" || parsed.hostname === "localhost";
  if (parsed.protocol === "http:" && loopback) return;
  throw new ValidationError(
    `refusing to download a snapshot over ${parsed.protocol}//: a whole-space ` +
      `snapshot is the entire contents of the space. Use https, or copy the ` +
      `file down yourself and pass a path.`,
  );
}

/**
 * How many redirects to follow. A cycle guard, not a retry budget: each hop is
 * a different URL, and a server that keeps redirecting is misconfigured rather
 * than slow.
 */
const MAX_REDIRECTS = 5;

/**
 * `fetch`, checking the transport of EVERY hop.
 *
 * `fetch` follows redirects itself and reports only the final response, so
 * validating the URL an operator typed proves nothing about where the bytes
 * came from: an https URL that 302s to plaintext http would put the whole space
 * on the wire in the clear, having passed the check. Following by hand is the
 * only way the refusal can cover the request that actually carries the body.
 */
async function fetchFollowingRedirects(url: string): Promise<Response> {
  let current = url;
  for (let hop = 0;; hop++) {
    assertConfidentialTransport(current);
    const response = await fetch(current, { redirect: "manual" });
    const location = response.headers.get("location");
    const redirected = response.status >= 300 && response.status < 400 &&
      location !== null;
    if (!redirected) return response;
    await response.body?.cancel();
    if (hop === MAX_REDIRECTS) {
      throw new Error(
        `could not download ${url}: more than ${MAX_REDIRECTS} redirects.`,
      );
    }
    // Resolve against the current URL: a `Location` may be relative.
    current = new URL(location, current).toString();
  }
}

/**
 * Download a remote snapshot to a temp file so `--from` can take a URL.
 *
 * Returns the staging directory alongside the path so the caller can remove it:
 * a real snapshot is gigabytes, and leaving one per invocation in the system
 * temp directory would be a quiet disk leak.
 *
 * Cleanup on the failure paths belongs HERE, not with the caller: once this
 * function throws it has never returned the directory, so no caller can be
 * holding a handle to remove. A stream that dies mid-download — the likeliest
 * failure at gigabyte scale, and the one a non-2xx check cannot catch — would
 * otherwise strand a partial file the size of however much arrived.
 */
async function fetchSnapshot(
  url: string,
): Promise<{ path: string; stagingDir: string }> {
  const response = await fetchFollowingRedirects(url);
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new Error(`could not download ${url}: HTTP ${response.status}`);
  }
  const stagingDir = await Deno.makeTempDir({ prefix: "cf-space-clone-" });
  const path = `${stagingDir}/snapshot.sqlite`;
  try {
    const file = await Deno.open(path, { write: true, create: true });
    // `pipeTo` closes the destination on success and aborts it on failure, so
    // the handle needs no separate disposal — and must not be given one, since
    // closing an already-closed file is itself an error.
    await response.body.pipeTo(file.writable);
  } catch (error) {
    await Deno.remove(stagingDir, { recursive: true }).catch(() => {});
    throw error;
  }
  return { path, stagingDir };
}

const bytes = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;

/**
 * The line that says how much of the store the fingerprint could not speak for.
 *
 * Printed only when there is something to say, but never suppressed when there
 * is: a verdict computed over an unknown fraction of a space reads exactly like
 * one computed over all of it, and this is the only place that difference
 * becomes visible to an operator.
 */
function uncertaintyNote(
  unhashable: number | null | undefined,
  ambiguous: number | null | undefined,
  indent: string,
): string {
  const notes: string[] = [];
  if (unhashable) {
    notes.push(
      `${unhashable} entit${
        unhashable === 1 ? "y" : "ies"
      } could not be hashed and ` +
        `${unhashable === 1 ? "is" : "are"} absent from this verdict`,
    );
  }
  if (ambiguous) {
    notes.push(
      `${ambiguous} id(s) generated in one manifest and named in another, ` +
        `counted as generated — a change to ${
          ambiguous === 1 ? "it" : "them"
        } would not show`,
    );
  }
  return notes.map((n) => `${indent}⚠ ${n}\n`).join("");
}

/**
 * The uncertainty lines for a verify, covering BOTH sides of the comparison.
 *
 * Reporting only the working copy's counts would hide the case the diff is
 * least able to see. An entity excluded from the BASELINE is absent from the
 * "before" side, so if it is still excluded now the diff cannot compare it at
 * all and a change to it is silent — that blind spot belongs to the baseline
 * and does not show up in a working-copy count. An older clone that never
 * recorded the numbers is the same situation with the size unknown, which is a
 * weaker claim than zero and must not render as zero.
 */
function verifyUncertaintyNote(u: VerifyResult["uncertainty"]): string {
  const working = uncertaintyNote(
    u.unhashable.working,
    u.ambiguous.working,
    "",
  );
  const { unhashable, ambiguous } = u;
  if (unhashable.manifest === null || ambiguous.manifest === null) {
    return working +
      `⚠ this clone predates uncertainty recording, so how much its BASELINE ` +
      `excluded is unknown; re-clone for a verdict that can say\n`;
  }
  const baseline = uncertaintyNote(unhashable.manifest, ambiguous.manifest, "");
  if (baseline === "") return working;
  return working +
    baseline.replace(
      /^⚠ /gm,
      "⚠ in the BASELINE: ",
    );
}

export const space = new Command()
  .name("space")
  .description(
    "Commands that act on a space: its root and home patterns, and rehearsal " +
      "clones of its store.",
  )
  .default("help")
  .error((error, command) => {
    if (hasJsonArgument(command.getMainCommand().getRawArgs())) throw error;
  })
  .globalOption("--json", "Output machine-readable JSON.")
  /* space clone */
  .command(
    "clone <space:string>",
    "Build a writable rehearsal clone of a space store from a snapshot.",
  )
  // `--from`/`--to` are required in substance but NOT declared `required`:
  // cliffy appends required options to the usage line, which would break the
  // repo invariant that a command's usage ends with its positional arguments
  // (see main-command.test.ts). Validating here also gives a more actionable
  // message than cliffy's generic one.
  .option(
    "--from <source:string>",
    "Snapshot to clone: a .sqlite path, or an https URL to download.",
  )
  .option("--to <dir:string>", "Destination clone directory.")
  .action(async (options, spaceDid) => {
    if (!options.from) {
      throw new ValidationError(
        "--from is required: a .sqlite snapshot path, or an https URL. " +
          "For production, take one server-side with `VACUUM INTO` and copy " +
          "it down — the dump endpoint is deliberately off there.",
      );
    }
    if (!options.to) {
      throw new ValidationError(
        "--to is required: the directory to build the clone in. It must be " +
          "outside any store a local server is serving.",
      );
    }
    const remote = /^https?:\/\//.test(options.from)
      ? await fetchSnapshot(options.from)
      : undefined;

    let manifest;
    try {
      manifest = await createClone({
        source: remote?.path ?? options.from,
        space: spaceDid,
        targetDir: options.to,
        forbiddenDirs: liveStoreDirs(),
      });
    } finally {
      if (remote) {
        await Deno.remove(remote.stagingDir, { recursive: true }).catch(
          () => {},
        );
      }
    }

    // Report the RESOLVED directory, not the raw argument: the serve line below
    // has to be a valid absolute `file://` URL, and a relative `--to` would
    // otherwise print one that silently does not work when pasted.
    const targetDir = await Deno.realPath(options.to);
    const paths = clonePaths(targetDir, spaceDid);

    out(!!options.json, { manifest, paths }, () => {
      console.log(
        `cloned ${spaceDid}\n` +
          `  snapshot   ${
            bytes(manifest.snapshotBytes)
          }  ${manifest.snapshotHash}\n` +
          `  counts     ${manifest.counts.commits} commits, ` +
          `${manifest.counts.revisions} revisions, ` +
          `${manifest.counts.entities} entities\n` +
          `  content    ${manifest.fingerprint.hash}\n` +
          `             ${manifest.fingerprint.entities} entities fingerprinted, ` +
          `${manifest.fingerprint.excludedGenerated} generated cells excluded\n` +
          uncertaintyNote(
            manifest.fingerprint.unhashable,
            manifest.fingerprint.ambiguous,
            "             ",
          ) +
          `  working    ${paths.workingPath}\n\n` +
          // HOST is pinned to loopback: the toolshed defaults to 0.0.0.0, and a
          // clone keeps the source space's DID, so a clone bound to every
          // interface is a second store answering to production's identity on
          // the network. The port offset separates it from a local production
          // server; only the host binding keeps it off the network entirely.
          `serve it (NOT the live store — note the host and port):\n` +
          `  HOST=127.0.0.1 MEMORY_DIR="file://${targetDir}/" ` +
          `./scripts/start-local-dev.sh --port-offset 10\n\n` +
          `then, per attempt (stop the server before resetting — a reset ` +
          `cannot reach a process that already holds the store open):\n` +
          `  cf space verify ${targetDir}\n` +
          `  cf space reset  ${targetDir}`,
      );
    });
  })
  /* space verify */
  .command(
    "verify <dir:string>",
    "Check a clone against its manifest: baseline intact, content unchanged.",
  )
  .option(
    "--expect-migration",
    "A migration was just run, so content is EXPECTED to differ: exit nonzero " +
      "only on a corrupted baseline or removed entities. Without it, any change " +
      "at all fails — which is right for checking an untouched clone, and wrong " +
      "as a rehearsal gate.",
  )
  .action(async (options, dir) => {
    const result = await verifyClone(dir);
    out(!!options.json, result, () => {
      const { counts, fingerprint, diff } = result;
      const kinds = (m: Record<string, number>) =>
        Object.entries(m).sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${n} ${k}`).join(", ") || "none";
      console.log(
        `baseline   ${result.baselineIntact ? "intact" : "CORRUPTED"}\n` +
          `removed    ${diff.removed}${
            diff.removed > 0 ? `  ← ${kinds(diff.removedByKind)}` : ""
          }\n` +
          `changed    ${diff.changed}${
            diff.changed > 0 ? `  (${kinds(diff.changedByKind)})` : ""
          }\n` +
          `added      ${diff.added}\n` +
          (diff.reclassifiedGenerated > 0
            ? `generated  ${diff.reclassifiedGenerated} reclassified — in ` +
              `both stores, excluded here, not removed\n`
            : "") +
          `content    ${fingerprint.match ? "unchanged" : "CHANGED"}\n` +
          `commits    ${counts.manifest.commits} → ${counts.working.commits}\n` +
          `revisions  ${counts.manifest.revisions} → ${counts.working.revisions}\n` +
          verifyUncertaintyNote(result.uncertainty) +
          `\n` +
          (!result.baselineIntact
            ? "BASELINE CORRUPTED — the pristine snapshot no longer matches the " +
              "manifest; do not reset to it."
            : diff.removed > 0
            ? "ENTITIES REMOVED — durable content was destroyed. This is the " +
              "unambiguous failure; investigate before doing anything else."
            : fingerprint.match
            ? "OK — nothing moved."
            : "CHANGED, nothing removed. After a schema migration this is the " +
              "EXPECTED result: every piece's result value is rewritten, so the " +
              "fingerprint cannot match. Confirm the changes are confined to " +
              "pieces and their derived cells, then check authored content " +
              "(titles, bodies, comments) separately — the fingerprint alone " +
              "cannot tell you it survived."),
      );
    });
    // Which verdict applies depends on whether a migration was expected, and
    // only the caller knows that — a hash cannot tell a rewritten result from a
    // clobbered one. Default strict (catches an accidental clobber);
    // --expect-migration gates on removal instead, so a rehearsal script does
    // not treat every successful migration as a failure.
    //
    // A failed verification is a RESULT, not a usage error: the report above is
    // what a script or an operator reads, so exit without cliffy's usage help.
    const passed = options.expectMigration
      ? result.okAfterMigration
      : result.ok;
    if (!passed) Deno.exit(1);
  })
  /* space reset */
  .command(
    "reset <dir:string>",
    "Restore the working copy from the pristine snapshot, discarding the attempt.",
  )
  .action(async (options, dir) => {
    const before = await readManifest(dir);
    await resetClone(dir);
    const after = await verifyClone(dir);
    out(!!options.json, { manifest: before, verify: after }, () => {
      console.log(
        `reset ${before.space} to its baseline (${before.createdAt})\n` +
          `  commits back to ${after.counts.working.commits}\n` +
          `  content  ${
            after.fingerprint.match ? "matches baseline" : "STILL DIFFERS"
          }`,
      );
    });
    if (!after.ok) Deno.exit(1);
  })
  /* space fingerprint */
  .command(
    "fingerprint <space:string>",
    "Content fingerprint of a store — the durable-content half of `verify`, " +
      "runnable against any space (a clone, a snapshot, or a local store).",
  )
  .option(
    "--include-generated",
    "Include compiler-generated internal cells. They rotate on every pattern " +
      "update by design, so this answers 'what moved at all?', not 'did " +
      "content survive?'.",
  )
  .option("--per-entity", "List every entity hash, not just the roll-up.")
  .action(async (options, token) => {
    const db = openSpace(await resolveSpace(token));
    try {
      const report = contentFingerprint(db, {
        includeGenerated: options.includeGenerated,
      });
      out(!!options.json, report, () => {
        console.log(
          `${report.hash}\n` +
            `${report.entities} entities fingerprinted, ` +
            `${report.excludedGenerated} generated cells excluded`,
        );
        if (report.ambiguous.length > 0) {
          console.log(
            `\nnote: ${report.ambiguous.length} id(s) are generated in one ` +
              `manifest and named in another; counted as generated.`,
          );
        }
        if (report.unhashable.length > 0) {
          console.log(
            `\nnote: ${report.unhashable.length} entit(ies) could not be ` +
              `hashed and are absent from the roll-up:`,
          );
          for (const u of report.unhashable.slice(0, 10)) {
            console.log(`  ${u.id}: ${u.reason}`);
          }
        }
        if (options.perEntity) {
          for (const e of report.perEntity) {
            console.log(
              `${e.hash ?? "(no value)"}\t${e.kind}\t${e.id}\t(${e.scope})`,
            );
          }
        }
      });
    } finally {
      db.close();
    }
  })
  /* space recreate-root */
  .command(
    "recreate-root",
    buildRecreateRootCommand("space recreate-root"),
  )
  /* space set-home */
  .command("set-home", buildSetHomeCommand("space set-home"))
  .command("invite", buildSpaceInviteCommand());
