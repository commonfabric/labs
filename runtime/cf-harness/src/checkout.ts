/**
 * Finding the labs checkout the harness is running out of.
 *
 * A surface started with no configuration is still expected to reach the
 * reference material and the skills a child needs, and the checkout is where
 * both live when the harness runs from source. Nothing here is a fallback for
 * configuration: a run that names its own roots never asks.
 *
 * Reads only, and only directory existence.
 */

import { dirname, fromFileUrl, join } from "@std/path";

/**
 * Directories a labs checkout carries at its root, all three of them. Three
 * rather than one because each alone appears in plenty of directories that are
 * not a checkout, and the walk below stops at the first directory that matches.
 */
const CHECKOUT_MARKER_DIRECTORIES = [
  "docs/common",
  "docs/development",
  "skills",
] as const;

const isDirectory = (path: string): boolean => {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
};

/**
 * The checkout root above the module `moduleUrl` names, or `undefined` when
 * that module sits in no checkout.
 *
 * Synchronous because the answer decides a tool surface: every surface that
 * states its tool policy has to reach the same one, and one of them states it
 * before any run exists.
 */
export const harnessCheckoutRootFrom = (
  moduleUrl: string,
): string | undefined => {
  // A module addressed by anything but a file URL — a compiled binary, an
  // `https:` import — sits in no checkout, and asking `fromFileUrl` about it
  // throws. This runs inside configuration resolution, where a throw would
  // take down every surface, so anything that is not a file URL answers "no
  // checkout" instead.
  let directory: string;
  try {
    const parsed = new URL(moduleUrl);
    if (parsed.protocol !== "file:") {
      return undefined;
    }
    directory = dirname(fromFileUrl(parsed));
  } catch {
    return undefined;
  }
  while (true) {
    if (
      CHECKOUT_MARKER_DIRECTORIES.every((marker) =>
        isDirectory(join(directory, marker))
      )
    ) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
};

/** {@link harnessCheckoutRootFrom} for this module's own location. */
export const harnessCheckoutRoot = (): string | undefined =>
  harnessCheckoutRootFrom(import.meta.url);
