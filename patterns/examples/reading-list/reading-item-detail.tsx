import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export type ItemType = "book" | "article" | "paper" | "video";
export type ItemStatus = "want" | "reading" | "finished" | "abandoned";

/** Input for creating a new reading item detail piece */
interface ReadingItemDetailInput {
  title?: Writable<string | Default<"">>;
  author?: Writable<string | Default<"">>;
  url?: Writable<string | Default<"">>;
  type?: Writable<ItemType | Default<"article">>;
  status?: Writable<ItemStatus | Default<"want">>;
  rating?: Writable<number | null | Default<null>>;
  notes?: Writable<string | Default<"">>;
  addedAt?: number | Default<0>;
  finishedAt?: number | null | Default<null>;
}

/** Output shape of the reading item piece - this is what gets stored in lists
 * #book #article #reading
 */
export interface ReadingItemDetailOutput {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  author: string;
  url: string;
  type: ItemType;
  status: ItemStatus;
  rating: number | null;
  notes: string;
  summary: string;
  addedAt: number;
  finishedAt: number | null;
  // Actions to update properties
  setStatus: Stream<{ status: ItemStatus }>;
  setRating: Stream<{ rating: number | null }>;
  setNotes: Stream<{ notes: string }>;
}

// Re-export the Output type as ReadingItemPiece for use in collections
export type ReadingItemPiece = ReadingItemDetailOutput;

export default pattern<ReadingItemDetailInput, ReadingItemDetailOutput>(
  (
    { title, author, url, type, status, rating, notes, addedAt, finishedAt },
  ) => {
    // Actions to modify properties
    const setStatus = action(
      ({ status: newStatus }: { status: ItemStatus }) => {
        status.set(newStatus);
      },
    );

    const setRating = action(
      ({ rating: newRating }: { rating: number | null }) => {
        rating.set(newRating);
      },
    );

    const setNotes = action(({ notes: newNotes }: { notes: string }) => {
      notes.set(newNotes);
    });

    return {
      [NAME]: computed(() => `Reading: ${title.get() || "New Item"}`),
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header">
            <cf-heading level={4}>
              {computed(() => title.get() || "New Item")}
            </cf-heading>
          </cf-vstack>

          <cf-vscroll flex showScrollbar fadeEdges>
            <cf-vstack gap="3" padding="4">
              <cf-card>
                <cf-vstack gap="2">
                  <cf-field label="Title">
                    <cf-input $value={title} placeholder="Title" />
                  </cf-field>

                  <cf-field label="Author">
                    <cf-input $value={author} placeholder="Author name" />
                  </cf-field>

                  <cf-field label="URL">
                    <cf-input
                      $value={url}
                      placeholder="https://..."
                      type="url"
                    />
                  </cf-field>

                  <cf-hstack gap="2">
                    <cf-field label="Type" style="flex: 1;">
                      <cf-select
                        $value={type}
                        items={[
                          { label: "📄 Article", value: "article" },
                          { label: "📚 Book", value: "book" },
                          { label: "📑 Paper", value: "paper" },
                          { label: "🎬 Video", value: "video" },
                        ]}
                      />
                    </cf-field>

                    <cf-field label="Status" style="flex: 1;">
                      <cf-select
                        $value={status}
                        items={[
                          { label: "Want to read", value: "want" },
                          { label: "Reading", value: "reading" },
                          { label: "Finished", value: "finished" },
                          { label: "Abandoned", value: "abandoned" },
                        ]}
                      />
                    </cf-field>
                  </cf-hstack>

                  <cf-field label="Rating">
                    <cf-select
                      $value={rating}
                      items={[
                        { label: "No rating", value: null },
                        { label: "★☆☆☆☆ (1)", value: 1 },
                        { label: "★★☆☆☆ (2)", value: 2 },
                        { label: "★★★☆☆ (3)", value: 3 },
                        { label: "★★★★☆ (4)", value: 4 },
                        { label: "★★★★★ (5)", value: 5 },
                      ]}
                    />
                  </cf-field>
                </cf-vstack>
              </cf-card>

              <cf-card>
                <cf-field label="Notes">
                  <cf-textarea
                    $value={notes}
                    placeholder="Your thoughts, highlights, quotes..."
                    rows={8}
                  />
                </cf-field>
              </cf-card>
            </cf-vstack>
          </cf-vscroll>
        </cf-screen>
      ),
      title,
      author,
      url,
      type,
      status,
      rating,
      notes,
      summary: computed(() => {
        const parts = [title.get()];
        if (author.get()) parts.push(`by ${author.get()}`);
        parts.push(`(${status.get()})`);
        if (notes.get()) parts.push(notes.get().slice(0, 150));
        return parts.join(" ");
      }),
      addedAt,
      finishedAt,
      setStatus,
      setRating,
      setNotes,
    };
  },
);
