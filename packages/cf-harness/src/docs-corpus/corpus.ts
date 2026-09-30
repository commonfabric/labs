/**
 * Loading the documentation corpus `research` searches and reads.
 *
 * The corpus is read on the host, from the roots the operator configured, and
 * never through the sandbox mount. That is what makes the endorsement below
 * honest: a section's provenance is the root it was found under, which the
 * operator named, rather than a path a child chose. Nothing else is admitted,
 * so a file some earlier child wrote into the workspace is not corpus and
 * cannot reach an answer.
 *
 * Reads only. Nothing here creates, moves, or writes a file.
 */

import { utf8Compare } from "@commonfabric/utils/utf8";
import { basename, join } from "@std/path";

import { harnessCheckoutRootFrom } from "../checkout.ts";

import {
  type HarnessDocsCorpusRecord,
  type HarnessDocsCorpusSection,
  operatorProvisionedReferenceAtom,
} from "../contracts/docs-corpus.ts";
import { splitMarkdownSections } from "./sections.ts";

/** Largest single document the corpus reads, in bytes. */
export const MAX_CORPUS_FILE_BYTES = 512_000;

/** Total document bytes one corpus load reads. */
export const MAX_CORPUS_BYTES = 16_000_000;

/** Directory names the walk does not descend into. */
const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules"]);

/** A configured root, and the name its documents are addressed under. */
export interface HarnessDocsCorpusRoot {
  /** The name a corpus path opens with, unique across the corpus. */
  name: string;

  hostPath: string;
}

export interface HarnessDocsCorpus {
  type: "cf-harness.docs-corpus";
  roots: readonly HarnessDocsCorpusRoot[];
  sections: readonly HarnessDocsCorpusSection[];
  files: number;

  /**
   * Whether the walk stopped on {@link MAX_CORPUS_BYTES} with roots left to
   * read. A corpus that says so holds some of the configured material rather
   * than all of it, and an answer built from it may be missing a section the
   * question had a better one in.
   */
  truncated: boolean;
}

/**
 * The roots as they are addressed, in configuration order. Two roots sharing a
 * basename would put two different documents at one corpus path, so the second
 * takes a numbered name; the citation stays a unique address either way.
 */
export const namedCorpusRoots = (
  hostPaths: readonly string[],
): readonly HarnessDocsCorpusRoot[] => {
  const used = new Set<string>();
  return hostPaths.map((hostPath) => {
    const base = basename(hostPath) || "root";
    let name = base;
    let ordinal = 2;
    while (used.has(name)) {
      name = `${base}-${ordinal}`;
      ordinal += 1;
    }
    used.add(name);
    return { name, hostPath };
  });
};

const isMarkdownPath = (path: string): boolean =>
  path.toLowerCase().endsWith(".md");

interface WalkState {
  sections: HarnessDocsCorpusSection[];
  files: number;
  bytes: number;
  truncated: boolean;
}

/**
 * Reads one document through a single open handle: the size the budget is
 * checked against and the bytes admitted come from the same file, so a path
 * replaced between two calls cannot have its old size admit its new contents.
 *
 * The one window this does not close is a symlink swapped in for a regular
 * file between the directory walk and the open. Deno's `open` has no
 * `O_NOFOLLOW`, so a no-follow open cannot be expressed here; what stands
 * against it is that the roots are operator-provisioned trees the harness only
 * reads, and the walk refuses a symlink it sees.
 */
const readDocument = async (
  state: WalkState,
  root: HarnessDocsCorpusRoot,
  hostPath: string,
  corpusPath: string,
): Promise<void> => {
  const file = await Deno.open(hostPath, { read: true });
  try {
    const info = await file.stat();
    if (!info.isFile || info.size > MAX_CORPUS_FILE_BYTES) {
      return;
    }
    if (state.bytes + info.size > MAX_CORPUS_BYTES) {
      state.truncated = true;
      return;
    }
    const bytes = new Uint8Array(info.size);
    let filled = 0;
    while (filled < bytes.length) {
      const read = await file.read(bytes.subarray(filled));
      if (read === null) {
        break;
      }
      filled += read;
    }
    state.bytes += filled;
    state.files += 1;
    state.sections.push(...splitMarkdownSections({
      path: corpusPath,
      integrity: [operatorProvisionedReferenceAtom(root.hostPath)],
    }, new TextDecoder().decode(bytes.subarray(0, filled))));
  } finally {
    file.close();
  }
};

const walkDirectory = async (
  state: WalkState,
  root: HarnessDocsCorpusRoot,
  hostPath: string,
  corpusPath: string,
): Promise<void> => {
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(hostPath)) {
    entries.push(entry);
  }
  // Directory order is a filesystem detail, and a corpus that changed between
  // two loads of the same tree would make a query's selection unreproducible.
  // The comparator is the repository's own, so the order does not depend on
  // the host's default locale either.
  entries.sort((left, right) => utf8Compare(left.name, right.name));
  for (const entry of entries) {
    // A symlink is followed by neither branch. Following one would let a link
    // planted under a root address a file the operator never provisioned, and
    // the endorsement would name a root that file does not live under.
    if (entry.isSymlink || entry.name.startsWith(".")) {
      continue;
    }
    const childHostPath = join(hostPath, entry.name);
    const childCorpusPath = `${corpusPath}/${entry.name}`;
    if (entry.isDirectory && !SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
      await walkDirectory(state, root, childHostPath, childCorpusPath);
      continue;
    }
    if (entry.isFile && isMarkdownPath(entry.name)) {
      await readDocument(state, root, childHostPath, childCorpusPath);
    }
  }
};

/**
 * The corpus held by `hostPaths`, with the endorsement stamped on every
 * section of it. A root that does not exist contributes nothing rather than
 * failing the load: an operator whose configuration names a tree this host
 * does not carry gets an answer out of the trees it does.
 */
export const loadHarnessDocsCorpus = async (
  hostPaths: readonly string[],
): Promise<HarnessDocsCorpus> => {
  const roots = namedCorpusRoots(hostPaths);
  const state: WalkState = {
    sections: [],
    files: 0,
    bytes: 0,
    truncated: false,
  };
  for (const root of roots) {
    let info: Deno.FileInfo;
    try {
      info = await Deno.stat(root.hostPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        continue;
      }
      throw error;
    }
    if (info.isDirectory) {
      await walkDirectory(state, root, root.hostPath, root.name);
    } else if (info.isFile && isMarkdownPath(root.hostPath)) {
      await readDocument(state, root, root.hostPath, root.name);
    }
  }
  return {
    type: "cf-harness.docs-corpus",
    roots,
    sections: state.sections,
    files: state.files,
    truncated: state.truncated,
  };
};

/**
 * The reference trees of the labs checkout the harness is running out of, or
 * an empty list when it is not running out of one.
 *
 * This is what keeps a console started with no documentation configuration
 * from being one whose children cannot find the documentation they need.
 */
export const checkoutDocsCorpusRootsFrom = (
  moduleUrl: string,
): readonly string[] => {
  const checkout = harnessCheckoutRootFrom(moduleUrl);
  return checkout === undefined
    ? []
    : ["docs/common", "docs/development", "skills"].map((root) =>
      join(checkout, root)
    );
};

/** {@link checkoutDocsCorpusRootsFrom} for this module's own location. */
export const checkoutDocsCorpusRoots = (): readonly string[] =>
  checkoutDocsCorpusRootsFrom(import.meta.url);

/**
 * The corpus dial a run resolves: what the operator configured, or the
 * checkout's own reference trees, or nothing at all — in which case the run
 * offers no documentation source to `research` and says so.
 *
 * This is the one derivation of the dial, so a surface stating its tool policy
 * and the engine offering the tools reach the same answer.
 */
export const resolveHarnessDocsCorpus = (
  configured?: HarnessDocsCorpusRecord,
): HarnessDocsCorpusRecord | undefined => {
  if (configured !== undefined) {
    return configured;
  }
  const roots = checkoutDocsCorpusRoots();
  return roots.length === 0 ? undefined : {
    type: "cf-harness.docs-corpus-record",
    source: "checkout-default",
    roots,
  };
};
