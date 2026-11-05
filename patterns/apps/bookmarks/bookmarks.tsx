/**
 * Bookmarks - A pattern for collecting and browsing URLs/bookmarks.
 *
 * Displays saved links in a searchable grid with rich previews using
 * cf-link-preview. Users can add URLs, search across titles/descriptions/URLs,
 * and remove bookmarks.
 *
 * Keywords: bookmarks, links, collection, urls, grid, preview, search
 */
import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// ===== Types =====
interface Bookmark {
  url: string;
  title: string | Default<"">;
  description: string | Default<"">;
}

interface BookmarksInput {
  bookmarks?: Writable<Bookmark[] | Default<[]>>;
}

export interface BookmarksOutput {
  [NAME]: string;
  [UI]: VNode;
  bookmarks: Bookmark[];
  count: number;
}

// ===== The Pattern =====
export const Bookmarks = pattern<BookmarksInput, BookmarksOutput>(
  ({ bookmarks }) => {
    const searchQuery = new Writable("");

    const filteredBookmarks = computed(() => {
      const query = searchQuery.get().toLowerCase();
      if (!query) return bookmarks.get() ?? [];
      return (bookmarks.get() ?? []).filter((b) => {
        const url = (b.url ?? "").toLowerCase();
        const title = (b.title ?? "").toLowerCase();
        const description = (b.description ?? "").toLowerCase();
        return url.includes(query) || title.includes(query) ||
          description.includes(query);
      });
    });

    const count = computed(() => (bookmarks.get() ?? []).length);

    const addBookmark = action(({ url }: { url: string }) => {
      const trimmed = url.trim();
      if (!trimmed) return;
      bookmarks.push({ url: trimmed, title: "", description: "" });
    });

    const removeBookmark = action(({ index }: { index: number }) => {
      const current = bookmarks.get() ?? [];
      if (index < 0 || index >= current.length) return;
      bookmarks.set(current.toSpliced(index, 1));
    });

    return {
      [NAME]: computed(() => `🔖 Bookmarks (${count})`),
      [UI]: (
        <cf-vstack gap="4">
          {/* Add URL input */}
          <cf-message-input
            placeholder="Add a URL..."
            button-text="Add"
            oncf-send={(e: { detail?: { message?: string } }) => {
              const url = e.detail?.message;
              if (url) addBookmark.send({ url });
            }}
          />

          {/* Search */}
          <cf-input
            $value={searchQuery}
            placeholder="Search bookmarks..."
            style={{ fontSize: "14px" }}
          />

          {/* Grid of link previews */}
          <cf-grid columns="3" gap="4">
            {filteredBookmarks.map((bookmark: Bookmark, index: number) => (
              <cf-vstack
                gap="1"
                style={{
                  position: "relative",
                  borderRadius: "8px",
                  overflow: "hidden",
                }}
              >
                <cf-link-preview url={bookmark.url} />
                <button
                  type="button"
                  onClick={() => removeBookmark.send({ index })}
                  style={{
                    position: "absolute",
                    top: "4px",
                    right: "4px",
                    background: "rgba(0,0,0,0.5)",
                    color: "white",
                    border: "none",
                    borderRadius: "50%",
                    width: "24px",
                    height: "24px",
                    cursor: "pointer",
                    fontSize: "12px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  title="Remove bookmark"
                >
                  ✕
                </button>
              </cf-vstack>
            ))}
          </cf-grid>
        </cf-vstack>
      ),
      bookmarks,
      count,
    };
  },
);

export default Bookmarks;
