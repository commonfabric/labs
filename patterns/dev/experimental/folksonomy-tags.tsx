/**
 * Folksonomy Tags - Community-Enabled Tag List Sub-Pattern
 *
 * A folksonomy-enabled tag list that learns from collective usage.
 * Like Flickr tags (public, emergent ontology) rather than Gmail labels (private silos).
 *
 * FEATURES:
 * - Local-first autocomplete: Shows tags from user's space matching the same scope
 * - Community fallback: When no local matches, show dimmed suggestions from community
 * - Preferential attachment: Popular community tags sort first (most used -> least used)
 * - Telemetry: Posts add/use/remove events to community aggregator piece
 *
 * USAGE:
 * ```tsx
 * const tags = new Writable<string[]>([]);
 * <cf-render $cell={FolksonomyTags({
 *   scope: "https://github.com/example/recipe-tracker",
 *   tags,
 * })} />
 * ```
 *
 * AGGREGATOR DISCOVERY:
 * This pattern auto-discovers the aggregator using wish("#folksonomyAggregator").
 * Deploy and favorite the folksonomy-aggregator piece for community features.
 * Without the aggregator, falls back to local-only mode.
 *
 * NOTE: Due to a runtime bug where CustomEvent details aren't passed through
 * cf-render boundaries, we use $value binding instead of oncf-select handlers.
 */
import {
  computed,
  type Default,
  handler,
  lift,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

/**
 * Tag event sent to the aggregator.
 */
interface TagEvent {
  scope: string;
  tag: string;
  action: "add" | "use" | "remove";
  timestamp: number;
}

/**
 * Community tag suggestion from the aggregator.
 */
interface CommunityTagSuggestion {
  tag: string;
  count: number;
}

/**
 * Aggregator interface for type-safe wish().
 * Must match the Output interface of folksonomy-aggregator.tsx.
 */
interface AggregatorPiece {
  events: TagEvent[];
  postEvent: Stream<TagEvent>;
  suggestions: Record<string, CommunityTagSuggestion[]>;
}

interface FolksonomyTagsInput {
  /** Namespace key (e.g., GitHub URL of the pattern using it) */
  scope: Writable<string | Default<"">>;

  /** User's tags for this scope - bidirectional binding */
  tags: Writable<string[] | Default<[]>>;

  /** Optional: Direct reference to aggregator (bypasses wish() discovery) */
  aggregator?: AggregatorPiece;
}

export interface FolksonomyTagsOutput {
  [NAME]: string;
  [UI]: VNode;
  tags: string[];
  addTag: Stream<{ tag: string }>;
  removeTag: Stream<{ tag: string }>;
}

/**
 * Autocomplete item structure for cf-autocomplete.
 */
interface AutocompleteItem {
  value: string;
  label: string;
  group: string;
  searchAliases?: string[];
  data?: { count?: number };
}

// Handler for programmatic tag addition
const addTagHandler = handler<{ tag: string }, { tags: Writable<string[]> }>(
  (event, { tags }) => {
    const tag = event.tag?.trim();
    if (!tag) return;

    const currentTags = tags.get() || [];
    if (
      currentTags.some((t: string) => t.toLowerCase() === tag.toLowerCase())
    ) {
      return;
    }

    tags.set([...currentTags, tag]);
  },
);

// Handler for programmatic tag removal
const removeTagHandler = handler<{ tag: string }, { tags: Writable<string[]> }>(
  (event, { tags }) => {
    const tag = event.tag?.trim();
    if (!tag) return;

    const currentTags = tags.get() || [];
    tags.set(currentTags.filter((t: string) => t !== tag));
  },
);

// Handler to post telemetry event to aggregator
const _postTelemetryEvent = handler<
  { tag: string; action: "add" | "use" | "remove" },
  { aggregatorStream: Stream<TagEvent> | null; scope: string }
>((event, { aggregatorStream, scope }) => {
  if (!aggregatorStream || !scope || !event.tag) return;

  const tagEvent: TagEvent = {
    scope,
    tag: event.tag,
    action: event.action,
    timestamp: Date.now(),
  };

  // Stream projected from the aggregator is a Cell containing the stream - call .send() directly
  try {
    aggregatorStream.send(tagEvent);
  } catch (e) {
    console.warn("[folksonomy-tags] Failed to post telemetry:", e);
  }
});

// Handler for clicking the remove button on a tag
// Posts "remove" event to aggregator
const onRemoveTag = handler<
  unknown,
  {
    tags: Writable<string[]>;
    index: number;
    aggregatorStream: Stream<TagEvent> | null;
    scope: string;
  }
>((_, { tags, index, aggregatorStream, scope }) => {
  const currentTags = tags.get() || [];
  const removedTag = currentTags[index];
  tags.set(currentTags.toSpliced(index, 1));

  // Post remove event to aggregator
  if (removedTag && aggregatorStream && scope) {
    try {
      aggregatorStream.send({
        scope,
        tag: removedTag,
        action: "remove",
        timestamp: Date.now(),
      });
    } catch (e) {
      console.warn("[folksonomy-tags] Failed to post remove event:", e);
    }
  }
});

// Handler for detecting tag additions via change event
// Compares previous tags with current to find what was added
const onTagsChanged = handler<
  { value: string | string[]; oldValue: string | string[] },
  {
    tags: Writable<string[]>;
    previousTags: Writable<string[]>;
    aggregatorStream: Stream<TagEvent> | null;
    scope: string;
  }
>((_, { tags, previousTags, aggregatorStream, scope }) => {
  const current = tags.get() || [];
  const previous = previousTags.get() || [];

  let added: string[];

  if (previous.length === 0 && current.length > 1) {
    // First change with pre-existing tags loaded from storage.
    // previousTags starts empty, so a naive diff would emit telemetry for ALL tags.
    // Since autocomplete adds one tag at a time, the newest tag is the last one.
    // Only emit telemetry for that one to avoid inflating counts.
    added = [current[current.length - 1]];
  } else {
    // Normal case: diff to find newly added tags
    added = current.filter((t) => !previous.includes(t));
  }

  // Post add events for each new tag
  if (added.length > 0 && aggregatorStream && scope) {
    try {
      for (const tag of added) {
        aggregatorStream.send({
          scope,
          tag,
          action: "add",
          timestamp: Date.now(),
        });
      }
    } catch (e) {
      console.warn("[folksonomy-tags] Failed to post add events:", e);
    }
  }

  // Update previous tags to current
  previousTags.set([...current]);
});

// Lift function to check if we have tags
const hasTags = lift((tags: string[]) => tags && tags.length > 0);

// Lift function to build autocomplete items
const buildAutocompleteItems = lift(
  ({
    localTags,
    communitySuggestions,
    currentTags,
  }: {
    localTags: string[];
    communitySuggestions: CommunityTagSuggestion[];
    currentTags: string[];
  }): AutocompleteItem[] => {
    const items: AutocompleteItem[] = [];
    const currentTagsLower = new Set(
      (currentTags || []).map((t) => t.toLowerCase()),
    );

    // Add local tags first (from user's space with same scope)
    for (const tag of localTags || []) {
      if (!currentTagsLower.has(tag.toLowerCase())) {
        items.push({
          value: tag,
          label: tag,
          group: "Your tags",
        });
      }
    }

    // Add community suggestions (not already in local or current)
    const localTagsLower = new Set(
      (localTags || []).map((t) => t.toLowerCase()),
    );
    for (const suggestion of communitySuggestions || []) {
      if (
        !currentTagsLower.has(suggestion.tag.toLowerCase()) &&
        !localTagsLower.has(suggestion.tag.toLowerCase())
      ) {
        items.push({
          value: suggestion.tag,
          label: `${suggestion.tag} (${suggestion.count})`,
          group: "Community",
          data: { count: suggestion.count },
        });
      }
    }

    return items;
  },
);

export const FolksonomyTags = pattern<
  FolksonomyTagsInput,
  FolksonomyTagsOutput
>(
  ({ scope, tags, aggregator: injectedAggregator }) => {
    // Use injected aggregator if provided, otherwise discover via wish()
    // Search both favorites (~) and current space mentionables (.)
    const aggregatorWish = wish<AggregatorPiece>({
      query: "#folksonomyAggregator",
      scope: ["~", "."],
    });

    // Use injected aggregator if available, otherwise use wish result
    const aggregator = injectedAggregator ?? aggregatorWish.result ?? null;

    // Get the aggregator's postEvent stream for telemetry
    const aggregatorStream: Stream<TagEvent> | null = aggregator?.postEvent ??
      null;

    // Track previous tags for change detection
    const previousTags = new Writable<string[]>([]).for("previousTags");

    // Get community suggestions for this scope
    const communitySuggestions = computed(() => {
      const scopeValue = scope.get();
      if (!aggregator || !scopeValue) return [];
      const suggs = aggregator.suggestions || {};
      return suggs[scopeValue] || [];
    });

    // Build autocomplete items combining local and community.
    // Local tags are just the current tags (same scope within same piece).
    const autocompleteItems = buildAutocompleteItems({
      localTags: tags,
      communitySuggestions,
      currentTags: tags,
    });

    // Check if aggregator is connected
    const hasAggregator = aggregator != null;

    // Computed name for display
    const displayName = computed(() => {
      const tagList = tags.get();
      if (!tagList || tagList.length === 0) return "🏷️ Tags";
      return `🏷️ Tags (${tagList.length})`;
    });

    return {
      [NAME]: displayName,
      [UI]: (
        <cf-vstack gap="3" style={{ padding: "8px 0" }}>
          {/* Hidden render to force aggregator to execute */}
          <div style={{ display: "none" }}>
            <cf-render $cell={aggregator} />
          </div>

          {
            /* Autocomplete input - use $value binding with multiple mode
              instead of oncf-select (runtime bug: CustomEvent.detail not passed through cf-render)
              oncf-change triggers telemetry posting for additions */
          }
          <cf-autocomplete
            items={autocompleteItems}
            placeholder="Add a tag..."
            allowCustom
            multiple
            $value={tags}
            oncf-change={onTagsChanged({
              tags,
              previousTags,
              aggregatorStream,
              scope,
            })}
          />

          {/* Current tags */}
          {hasTags(tags)
            ? (
              <cf-hstack gap="2" wrap>
                {tags.map((tag: string, index: number) => (
                  <span
                    key={index}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      padding: "4px 8px 4px 10px",
                      background: "#f3f4f6",
                      borderRadius: "16px",
                      fontSize: "14px",
                    }}
                  >
                    <span>{tag}</span>
                    <button
                      type="button"
                      onClick={onRemoveTag({
                        tags,
                        index,
                        aggregatorStream,
                        scope,
                      })}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: "0 2px",
                        fontSize: "14px",
                        color: "#9ca3af",
                        lineHeight: 1,
                      }}
                      title="Remove tag"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </cf-hstack>
            )
            : (
              <span style={{ color: "#9ca3af", fontSize: "13px" }}>
                No tags yet. Type to add one.
              </span>
            )}

          {/* Aggregator status indicator */}
          <cf-hstack
            gap="1"
            align="center"
            style={{ fontSize: "11px", color: "#9ca3af" }}
          >
            <span
              style={{
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: hasAggregator ? "#22c55e" : "#d1d5db",
              }}
            />
            <span>
              {hasAggregator
                ? "Connected to community aggregator"
                : "Local mode (favorite folksonomy-aggregator for community)"}
            </span>
          </cf-hstack>
        </cf-vstack>
      ),
      tags,
      addTag: addTagHandler({ tags }),
      removeTag: removeTagHandler({ tags }),
    };
  },
);

export default FolksonomyTags;
