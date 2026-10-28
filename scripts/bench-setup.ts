#!/usr/bin/env deno run -A

/**
 * bench-setup.ts — CT-1409+ benchmark space deployer
 *
 * Deploys a fresh benchmark space with seeded note and todo-list pieces.
 * Prints a JSON manifest to stdout on completion.
 *
 * Usage:
 *   deno run -A scripts/bench-setup.ts [--api-url URL] [--identity PATH] [--root PATH] [--quiet]
 */

import { dirname, fromFileUrl } from "@std/path";
import {
  callPieceHandler,
  type EntryConfig,
  newPiece,
  type SpaceConfig,
} from "../packages/cli/lib/piece.ts";

//
// Path resolution
//

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const NOTE_PATTERN = `${REPO_ROOT}/packages/patterns/notes/note.tsx`;
const TODO_PATTERN = `${REPO_ROOT}/packages/patterns/todo-list/todo-list.tsx`;

//
// Content
//

const NOTES = [
  { title: "Standup 2026-03-27", content: "No blockers today." },
  { title: "Standup 2026-03-26", content: "Waiting on PR review." },
  {
    title: "Quick idea",
    content: "Cache the FUSE tree on startup to reduce cold-read latency.",
  },
  {
    title: "TODO review",
    content:
      "TODO: review authentication flow\nFIXME: handle token expiry\nTODO: add rate limiting",
  },
  {
    title: "Architecture notes",
    content:
      "The FUSE adapter uses an in-memory inode map (FsTree). Each piece becomes a directory under pieces/. The cell-bridge subscribes to input and result cells and rebuilds the subtree on each update. Tree rebuilds are deferred via setTimeout(0) to avoid calling notify_inval_entry inside FUSE callbacks, which crashes FUSE-T on macOS.\n\nPerformance concern: rebuilding large trees on every cell update may be O(n) in piece size. Need to profile.",
  },
  {
    title: "Meeting notes: runtime sync",
    content:
      "Attendees: Ben, Rob\n\nDiscussed: cell subscription model, back-pressure in the write path, FUSE-T NFS cache TTL (~1s).\n\nAction items:\n- Ben: profile write→result latency\n- Rob: investigate subscription cancellation leak\n- Both: review CT-1205 investigation doc\n\nNext meeting: next Thursday.",
  },
  {
    title: "Performance baseline",
    content:
      "Measured FUSE write→result latency for a note piece: p50 ~162ms, p95 ~202ms. This includes: FUSE write syscall, cell-bridge write path, reactive recomputation, FUSE tree rebuild, kernel cache invalidation. Goal: get p50 under 100ms. Primary suspects: tree rebuild O(n), synchronous JSON parse on every write.",
  },
  {
    title: "Authentication design",
    content:
      "We use DID:key identities derived from a passphrase. The local toolshed uses 'implicit trust' as the default passphrase for development. Production uses hardware-backed keys. The FUSE daemon accepts an --identity flag pointing to a key file.\n\nSecurity note: the implicit trust key must never be used in production. The passphrase is literally 'implicit trust' — it is not a secret.\n\nTODO: add a warning in the CLI if the implicit trust key is used against a non-localhost API URL.",
  },
  {
    title: "Deep dive: cell reactivity",
    content: `# Cell Reactivity in Common Fabric

## Overview

Cells are the fundamental unit of state in the Common Fabric runtime. Each cell holds a typed value and notifies subscribers when that value changes. Cells are stored in Spaces, addressed by DID.

## Subscription model

A pattern registers interest in a set of cells at startup. The runtime calls the pattern function whenever any of its subscribed cells change. The pattern returns a new result, which is written back to the result cell.

## Computed cells

Computed cells are derived from other cells via a pure function. They are invalidated when any of their dependencies change. Invalidation is lazy — the value is only recomputed when read.

## The lift() primitive

lift() wraps a plain function to accept Cell arguments, automatically subscribing to each. This is the primary composition primitive for derived values.

## Back-pressure

The runtime processes cell updates in topological order (dependencies before dependents). If a cell update triggers a chain of recomputations, the runtime batches them into a single scheduler tick before notifying FUSE.

## Known issues

- Large result trees (with $UI nodes) cause slow FUSE tree rebuilds
- Circular computed dependencies are detected but the error message is unhelpful
- The subscription cancellation path leaks memory if a pattern is removed without cleanup

## References

- docs/common/concepts/reactivity.md
- packages/runner/src/scheduler.ts
- packages/fuse/cell-bridge.ts`,
  },
  {
    title: "FUSE filesystem spec summary",
    content: `The FUSE filesystem layout:

  /tmp/cf/
    <space>/
      pieces/
        <piece-name>/
          input/        — writable, each key is a file
          input.json    — atomic read/write of full input cell
          result/       — reactive, updates when piece recomputes
          result.json   — full result cell as JSON
          meta.json     — id, entityId, name, patternName (read-only)

Writing to input/ triggers reactive recomputation. The result/ subtree updates within ~150-300ms on a local dev server.

Handlers are exposed as .handler files under result/. Write JSON to them to invoke.
Tools are exposed as .tool files — read them to get a shell script that calls cf exec.

Performance characteristics:
- Directory listing: O(children), fast
- File read: O(file size), fast
- Write→result: ~150-300ms on localhost
- Tree rebuild: O(piece size), can be slow for large $UI trees
- Grep across space: O(total content size), linear scan

FIXME: large pieces with deep $UI trees cause >1s tree rebuilds.
TODO: add incremental tree update (only rebuild changed subtree).`,
  },
];

const TODO_ITEMS = [
  "Review CT-1205 investigation document",
  "Profile FUSE tree rebuild performance",
  "Fix subscription cancellation leak",
  "Add warning for implicit trust key on non-localhost",
  "Write integration test for concurrent FUSE writes",
];

//
// CLI parsing
//

function parseArgs(args: string[]): {
  apiUrl: string;
  identity: string;
  rootPath: string;
  quiet: boolean;
} {
  const parsed: Record<string, string> = {};
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--quiet") {
      quiet = true;
    } else if (args[i].startsWith("--") && i + 1 < args.length) {
      parsed[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }

  return {
    apiUrl: parsed["api-url"] ?? "http://localhost:8000",
    identity: parsed["identity"] ?? "/tmp/bench.key",
    rootPath: parsed["root"] ?? `${REPO_ROOT}/packages/patterns`,
    quiet,
  };
}

//
// Timestamp
//

function timestamp(): string {
  const now = new Date();
  const pad = (n: number, d = 2) => String(n).padStart(d, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

//
// Main
//

async function deployNote(
  spaceConfig: SpaceConfig,
  noteEntry: EntryConfig,
  note: { title: string; content: string },
  log: (msg: string) => void,
): Promise<{ name: string; id: string; pattern: string }> {
  log(`[bench-setup] Deploying note: "${note.title}"...`);
  const id = await newPiece(spaceConfig, noteEntry);
  const pieceConfig = { ...spaceConfig, piece: id };
  try {
    await callPieceHandler(pieceConfig, "setTitle", note.title);
  } catch (err) {
    log(
      `[bench-setup]   Warning: setTitle failed for "${note.title}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  try {
    await callPieceHandler(pieceConfig, "editContent", {
      detail: { value: note.content },
    });
  } catch (err) {
    log(
      `[bench-setup]   Warning: editContent failed for "${note.title}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  log(`[bench-setup]   Done. id=${id}`);
  return { name: note.title, id, pattern: "note" };
}

async function main() {
  const opts = parseArgs(Deno.args);
  const t0 = Date.now();

  const spaceName = `bench-${timestamp()}`;

  const log = opts.quiet
    ? (_msg: string) => {}
    : (msg: string) => console.error(msg);

  log(`[bench-setup] Space: ${spaceName}`);
  log(`[bench-setup] API:   ${opts.apiUrl}`);
  log(`[bench-setup] Identity: ${opts.identity}`);

  const spaceConfig: SpaceConfig = {
    apiUrl: opts.apiUrl,
    space: spaceName,
    identity: opts.identity,
  };

  const noteEntry: EntryConfig = {
    mainPath: NOTE_PATTERN,
    rootPath: opts.rootPath,
  };

  const todoEntry: EntryConfig = {
    mainPath: TODO_PATTERN,
    rootPath: opts.rootPath,
  };

  const pieces: Array<{ name: string; id: string; pattern: string }> = [];

  // Sequential deployment. Concurrent writes cause registry O(n^2) traversal
  // and transaction retry overhead — sequential is faster in practice.
  log(`[bench-setup] Deploying ${NOTES.length} notes...`);
  for (const note of NOTES) {
    try {
      pieces.push(await deployNote(spaceConfig, noteEntry, note, log));
    } catch (err) {
      console.error(
        `[bench-setup] ERROR deploying note "${note.title}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Deploy todo-list piece
  log(`[bench-setup] Deploying todo-list: "Benchmark Todos"...`);
  try {
    const id = await newPiece(spaceConfig, todoEntry);
    const pieceConfig = { ...spaceConfig, piece: id };

    for (const item of TODO_ITEMS) {
      log(`[bench-setup]   Adding todo item: "${item}"...`);
      try {
        await callPieceHandler(pieceConfig, "addItem", { title: item });
      } catch (err) {
        log(
          `[bench-setup]   Warning: addItem failed for "${item}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    pieces.push({ name: "Benchmark Todos", id, pattern: "todo-list" });
    log(`[bench-setup]   Done. id=${id}`);
  } catch (err) {
    console.error(
      `[bench-setup] ERROR deploying todo-list: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const setup_ms = Date.now() - t0;
  log(`[bench-setup] Done in ${(setup_ms / 1000).toFixed(1)}s`);

  // Emit manifest to stdout
  const manifest = { space: spaceName, api_url: opts.apiUrl, setup_ms, pieces };
  console.log(JSON.stringify(manifest, null, 2));
}

await main();
