/**
 * Where the repository pages live (repo-page.ts). This module reads nothing
 * from the environment, so a page whose script is bundled for the browser can
 * link to them.
 */

/** The index of repository pages. */
export const REPOS_PATH = "/repos";

/** The page of the repository named `name`, without its owner. */
export function repoPageHref(name: string): string {
  return `${REPOS_PATH}?${new URLSearchParams({ name })}`;
}
