/**
 * Lists the repositories of the organization the dashboard reports on, for the
 * tiles that cover every repository in it rather than a fixed few.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";
import type { GitHubCredential } from "./github-auth.ts";
import { github, GITHUB_ORGANIZATION } from "./lib.ts";

/** A repository of the organization that is not archived. */
export interface OrganizationRepo {
  /** The repository, as "owner/name". */
  readonly name: string;

  /** The repository's default branch. */
  readonly branch: string;

  /** When any branch of it was last pushed to, or null if none ever was. */
  readonly pushedAt: string | null;
}

/**
 * Lists every repository in the organization the token can see, minus the
 * archived ones. A token that cannot see a private repository is not shown it
 * here, so a caller covers what the token reaches and says nothing about the
 * rest. Throws when GitHub's answer does not have the shape of a listing.
 */
export async function organizationRepos(
  credential: GitHubCredential,
): Promise<OrganizationRepo[]> {
  const repos: OrganizationRepo[] = [];
  for (let page = 1;; page++) {
    const batch = await github<unknown>(
      `orgs/${GITHUB_ORGANIZATION.name}/repos?per_page=100&page=${page}`,
      credential,
    );
    if (!Array.isArray(batch)) {
      throw new Error("GitHub organization repositories returned invalid data");
    }
    for (const repo of batch) {
      if (
        !isObjectNotArray(repo) || typeof repo.full_name !== "string" ||
        typeof repo.default_branch !== "string" ||
        typeof repo.archived !== "boolean" ||
        (repo.pushed_at !== null && typeof repo.pushed_at !== "string")
      ) {
        throw new Error(
          "GitHub organization repositories returned invalid data",
        );
      }
      if (!repo.archived) {
        repos.push({
          name: repo.full_name,
          branch: repo.default_branch,
          pushedAt: repo.pushed_at,
        });
      }
    }
    if (batch.length < 100) return repos;
  }
}
