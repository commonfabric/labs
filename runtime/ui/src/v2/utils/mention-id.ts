import { entityUriSchemePrefix } from "@commonfabric/runner/entity-kind";

/**
 * The id embedded in wiki-link mention text (`[[Name (<id>)]]`) is the BARE
 * tagged hash (`fid1:<hash>`): the text is persisted note content, and note
 * renderers (e.g. note-md) build `/of:<id>` links from it — so the `of:`
 * scheme is the renderer's to add, never the editor's to embed.
 * `CellHandle.id()` returns the full schemed URI, so embedding strips `of:`.
 *
 * `computed:` ids are REJECTED, not stripped: the URI scheme is part of the
 * identity — a computed cell's bare hash addresses its `of:` sibling — so a
 * computed cell cannot round-trip through the bare embed format. Today this
 * cannot occur (mentionable targets are pieces: result cells, always
 * `of:`-schemed), so the throw is a tripwire. If mentionables ever include
 * computed cells, the embed format must learn to carry the scheme instead —
 * e.g. persist the full URI inside the wiki-link and teach the renderers to
 * link schemed ids without re-prefixing.
 */
export function mentionIdFromCellId(id: string): string {
  const scheme = entityUriSchemePrefix(id);
  if (scheme !== undefined && scheme !== "of:") {
    throw new Error(
      `cannot embed a ${scheme} cell id in mention text — the scheme is ` +
        `part of the identity and the bare embed format would drop it: ${id}`,
    );
  }
  return scheme === "of:" ? id.slice(scheme.length) : id;
}
