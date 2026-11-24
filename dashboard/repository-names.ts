/**
 * Maps the names, as "owner/name", that renamed repositories had before to the
 * names they have now. GitHub reports a renamed repository under its new name,
 * so only names the dashboard did not get from GitHub just now are mapped,
 * where they are read: its configuration, and files it wrote before the
 * rename. Names are compared as they are everywhere else.
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
