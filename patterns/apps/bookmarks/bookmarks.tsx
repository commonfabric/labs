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
  equals,
  handler,
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

/** Whether a bookmark's URL, title, or description contains `query`. */
function matchesQuery(bookmark: Bookmark, query: string): boolean {
  const needle = query.toLowerCase();
  return [bookmark.url, bookmark.title, bookmark.description].some((field) =>
    (field ?? "").toLowerCase().includes(needle)
  );
}

// Removes the bookmark itself rather than whatever sits at its position, so a
// search hiding others, or another user's edit, cannot redirect the removal.
const removeBookmark = handler<
  unknown,
  { bookmarks: Writable<Bookmark[]>; bookmark: Bookmark }
>((_event, { bookmarks, bookmark }) => {
  const current = bookmarks.get() ?? [];
  const index = current.findIndex((el) => equals(bookmark, el));
  if (index >= 0) bookmarks.set(current.toSpliced(index, 1));
});

// ===== The Pattern =====
export const Bookmarks = pattern<BookmarksInput, BookmarksOutput>(
  ({ bookmarks }) => {
    const searchQuery = new Writable("");

    const count = computed(() => (bookmarks.get() ?? []).length);

    const addBookmark = action(({ url }: { url: string }) => {
      const trimmed = url.trim();
      if (!trimmed) return;
      bookmarks.push({ url: trimmed, title: "", description: "" });
    });

    return {
      [NAME]: computed(() => `🔖 Bookmarks (${count})`),
      [UI]: (
        <cf-vstack gap="4">
          {/* Add URL input */}
          <cf-message-input
            placeholder="Add a URL..."
            buttonText="Add"
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
            {bookmarks.map((bookmark) =>
              computed(() => matchesQuery(bookmark, searchQuery.get()))
                ? (
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
                      onClick={removeBookmark({ bookmarks, bookmark })}
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
                )
                : null
            )}
          </cf-grid>
        </cf-vstack>
      ),
      bookmarks,
      count,
    };
  },
);

export default Bookmarks;
