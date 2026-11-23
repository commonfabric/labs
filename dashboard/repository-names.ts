/**
 * Maps the names, as "owner/name", that renamed repositories had before to the
 * names they have now. A renamed repository keeps its runs and commits under
 * its new name, so a name that enters the dashboard from outside, or from a
 * file it wrote before the rename, is mapped to the current name where it is
 * read, and names are compared as they are everywhere else.
 */

/** Each renamed repository's current name, by a name it had before, in lower case. */
const RENAMED: ReadonlyMap<string, string> = new Map([
  ["commonfabric/loom", "commonfabric/cfs"],
  ["commonfabric/commonfabric-weaver", "commonfabric/weaver"],
]);

/** Returns the name the repository that `repo` names has now. */
export function currentRepoName(repo: string): string {
  return RENAMED.get(repo.toLowerCase()) ?? repo;
}

/** Returns the names the repository named `repo` had before it was given that name. */
export function formerRepoNames(repo: string): string[] {
  return [...RENAMED]
    .filter(([, now]) => now === repo.toLowerCase())
    .map(([before]) => before);
}
