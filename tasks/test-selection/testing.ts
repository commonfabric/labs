/**
 * Fixtures the selection tooling's own tests are written against. The
 * shapes come from the shared format's own fixtures; what is added here
 * is the dials, which are this repository's policy rather than part of
 * the format.
 */

import {
  sampleEntry as bareEntry,
  sampleManifest as bareManifest,
} from "@commonfabric/test-support/records";
import { dialSnapshot, type Manifest } from "./manifest.ts";

export { freeCalibration } from "@commonfabric/test-support/records";
export const sampleEntry = bareEntry;

/** A small, valid manifest, carrying this repository's dials. */
export function sampleManifest(fields: Partial<Manifest> = {}): Manifest {
  return bareManifest({ dials: dialSnapshot(), ...fields });
}

/**
 * A new repository in a temporary directory whose one commit was made at
 * `committed`, for a case about which manifest a commit resolves. The
 * caller removes the directory. Throws where git refuses a step, having
 * removed the directory, since a repository with no commit would read as
 * one whose date cannot be read.
 */
export async function repositoryCommittedAt(
  committed: string,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "committed-at-" });
  const git = async (...args: string[]) => {
    const result = await new Deno.Command("git", {
      args,
      cwd: root,
      env: {
        GIT_AUTHOR_DATE: committed,
        GIT_COMMITTER_DATE: committed,
        GIT_AUTHOR_NAME: "A",
        GIT_AUTHOR_EMAIL: "a@example.com",
        GIT_COMMITTER_NAME: "A",
        GIT_COMMITTER_EMAIL: "a@example.com",
      },
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!result.success) {
      throw new Error(
        `git ${args.join(" ")} failed: ` +
          new TextDecoder().decode(result.stderr).trim(),
      );
    }
  };
  try {
    await git("init", "-q");
    await Deno.writeTextFile(`${root}/a.txt`, "a");
    await git("add", "a.txt");
    await git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "one");
  } catch (error) {
    await Deno.remove(root, { recursive: true });
    throw error;
  }
  return root;
}
