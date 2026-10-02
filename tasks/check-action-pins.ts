#!/usr/bin/env -S deno run --allow-read --allow-net=api.github.com --allow-env
//
// Verifies that every step under .github/ names its action by a commit some
// upstream release points at.
//
// A step names an action outside this repository like this:
//
//   uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
//
// The commit is what defends against the publisher: a tag is a name they can
// move, so a step naming one runs whatever the name points at when the job
// starts, and a moved tag puts their code beside our credentials. A commit
// cannot be moved.
//
// The comment is what defends against us. Nobody checks a 40-character commit
// by eye, so a commit that is not the release it claims to be would pass
// review on the strength of the comment beside it. This check asks GitHub
// whether the release named in the comment points at that commit.
//
// The comment names the release itself, `# v4.2.0` and not `# v4`. A
// publisher moves `v4` onto each new release, so a comment naming one says
// only which major version a commit belongs to, hides how far behind it is,
// and stops being true without anybody touching the file. A release name is
// fixed, so the check is an equality and a reader learns what is running.
//
// Usage: deno run --allow-read --allow-net=api.github.com --allow-env \
//          ./tasks/check-action-pins.ts [repository root]
//
// Set GITHUB_TOKEN (or GH_TOKEN) to raise the API rate limit from 60 requests
// an hour to 5000.

import { dirname, fromFileUrl } from "@std/path";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** One `uses:` step naming an action outside this repository. */
export interface Step {
  /** Path relative to .github/, for reporting. */
  file: string;
  /** Everything after `uses:`, up to any trailing comment. */
  action: string;
  /** The trailing comment, empty when the step carries none. */
  comment: string;
}

// A step's `uses:` value and whatever comment follows it. Steps naming this
// repository's own composite actions start with `./`, and are skipped by the
// caller rather than here, so that a malformed one is still seen.
const USES =
  /^[ \t]*uses:[ \t]+["']?([^"'\s]+)["']?[ \t]*(?:#[ \t]*(.*?))?[ \t]*$/gm;

/** Every step in one file that names an action. */
export function parseSteps(contents: string, file: string): Step[] {
  return [...contents.matchAll(USES)].map((match) => ({
    file,
    action: match[1],
    comment: (match[2] ?? "").trim(),
  }));
}

/** A step's repository and commit, or null when it names no commit. */
export function pinOf(step: Step): { repo: string; sha: string } | null {
  // A sub-action path selects a directory within the repository, and releases
  // belong to the repository, so the path is dropped.
  const match = step.action.match(
    /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)(?:\/\S*)?@([0-9a-f]{40})$/,
  );
  return match ? { repo: match[1], sha: match[2] } : null;
}

/** Every tag in a repository whose name starts with `prefix`, and its commit. */
export type Resolver = (
  repo: string,
  prefix: string,
) => Promise<Map<string, string>>;

/** The names that extend `version`, so `v4` is extended by `v4.2.0`. */
export function extensionsOf(
  tags: Map<string, string>,
  version: string,
): string[] {
  return [...tags.keys()].filter((name) => name.startsWith(`${version}.`));
}

/**
 * What is wrong with one step, or null when its commit is the release its
 * comment names. Steps naming an action in this repository never reach here.
 */
export async function checkStep(
  step: Step,
  resolve: Resolver,
): Promise<string | null> {
  const pin = pinOf(step);
  if (pin === null) {
    return `${step.file}: ${step.action} names no commit; a tag or a branch ` +
      `is a name its publisher can move`;
  }

  const short = `${pin.repo}@${pin.sha.slice(0, 11)}…`;
  // The comment is written the way a step names a version, carrying the
  // leading `v` the tags themselves carry.
  const version = step.comment.split(/[\s,;]/)[0];
  if (!/^v?\d[\w.+-]*$/.test(version)) {
    return `${step.file}: ${short} has no version comment${
      step.comment ? ` (it reads "${step.comment}")` : ""
    }; without one nothing says which release this commit is`;
  }

  const tags = await resolve(pin.repo, version);

  // A name other releases extend is one the publisher moves onto each of
  // them. It would be true today and false after the next release, without
  // anybody touching this file.
  const extensions = extensionsOf(tags, version);
  if (extensions.length > 0) {
    const carrying = extensions.filter((name) => tags.get(name) === pin.sha);
    return `${step.file}: ${short} is commented ${version}, a name its ` +
      `publisher moves onto each release; name the release itself` +
      (carrying.length > 0 ? `, ${carrying.join(" or ")}` : "");
  }

  const at = tags.get(version);
  if (at === undefined) {
    return `${step.file}: ${pin.repo} has no ${version} release, which is ` +
      `what the comment on ${pin.sha.slice(0, 11)}… claims it runs`;
  }
  if (at !== pin.sha) {
    return `${step.file}: ${pin.repo} ${version} is ${at.slice(0, 11)}…, ` +
      `but the step runs ${pin.sha.slice(0, 11)}…`;
  }
  return null;
}

function apiHeaders(): HeadersInit {
  const token = Deno.env.get("GITHUB_TOKEN") ?? Deno.env.get("GH_TOKEN");
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function api(path: string): Promise<Response> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: apiHeaders(),
  });
  if (response.status === 403 || response.status === 429) {
    await response.body?.cancel();
    throw new Error(
      `GitHub refused ${path} (${response.status}); rate limit remaining ` +
        `${response.headers.get("x-ratelimit-remaining") ?? "unknown"}. Set ` +
        `GITHUB_TOKEN to raise it.`,
    );
  }
  return response;
}

/** Asks GitHub, following each annotated tag through to its commit. */
export const resolveFromGitHub: Resolver = async (repo, prefix) => {
  const listed = await api(`/repos/${repo}/git/matching-refs/tags/${prefix}`);
  if (listed.status === 404) {
    await listed.body?.cancel();
    return new Map();
  }
  if (!listed.ok) {
    throw new Error(
      `GitHub answered ${listed.status} listing ${repo} tags under ${prefix}`,
    );
  }
  const refs = await listed.json() as {
    ref: string;
    object: { type: string; sha: string };
  }[];

  const tags = new Map<string, string>();
  for (const { ref, object } of refs) {
    const name = ref.replace("refs/tags/", "");
    if (object.type === "commit") {
      tags.set(name, object.sha);
      continue;
    }
    const peeled = await api(`/repos/${repo}/git/tags/${object.sha}`);
    if (!peeled.ok) {
      throw new Error(
        `GitHub answered ${peeled.status} peeling ${repo} tag ${name}`,
      );
    }
    tags.set(name, ((await peeled.json()).object as { sha: string }).sha);
  }
  return tags;
};

async function* yamlPaths(directory: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) yield* yamlPaths(path);
    else if (/\.ya?ml$/.test(entry.name)) yield path;
  }
}

export async function main(
  root: string = REPO_ROOT,
  resolve: Resolver = resolveFromGitHub,
): Promise<number> {
  const base = `${root}/.github`;
  const steps: Step[] = [];
  for await (const path of yamlPaths(base)) {
    const text = await Deno.readTextFile(path);
    for (const step of parseSteps(text, path.slice(base.length + 1))) {
      steps.push(step);
    }
  }

  // A step naming an action in this repository is already carried by the run
  // at a known commit. The rest are asked about once per distinct answer: the
  // same pin appears in many steps, and each question reaches the network.
  const distinct = new Map<string, Step>();
  for (const step of steps) {
    if (step.action.startsWith("./")) continue;
    distinct.set(`${step.action}#${step.comment}`, step);
  }

  const problems: string[] = [];
  for (const key of [...distinct.keys()].sort()) {
    const problem = await checkStep(distinct.get(key)!, resolve);
    if (problem !== null) problems.push(problem);
  }

  if (problems.length > 0) {
    console.error("These steps do not run the release they claim:");
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }

  console.log(
    `Every action step runs a release its comment names: ${distinct.size} ` +
      `pinned across ${steps.length} steps.`,
  );
  return 0;
}

if (import.meta.main) Deno.exit(await main(Deno.args[0] ?? REPO_ROOT));
