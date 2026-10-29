/**
 * Removes `directory` and everything under it, under a name nothing else
 * holds.
 *
 * Removing a tree walks it and then removes the root. A process writing into
 * the tree by the path it was given can put an entry back into a directory
 * the walk has already been through, leaving the root non-empty by the time
 * the walk reaches it. The rename is one operation that cannot half-happen:
 * after it, a write to the old path finds nothing to write into, and the walk
 * sees a tree nothing can add to.
 */
export async function removeDirectory(directory: string): Promise<void> {
  const removing = `${directory}.removing`;
  await Deno.rename(directory, removing);
  await Deno.remove(removing, { recursive: true });
}
