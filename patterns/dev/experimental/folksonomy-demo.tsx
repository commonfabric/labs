/**
 * Folksonomy Demo - Demonstration of the Folksonomy Tags System
 *
 * This pattern demonstrates the folksonomy tag system by showing multiple
 * tag instances with the same scope (to show local tag reuse) and
 * connection to the community aggregator.
 *
 * SETUP:
 * 1. Deploy folksonomy-aggregator.tsx first
 * 2. Favorite the aggregator with tag "folksonomyAggregator"
 * 3. Deploy this demo pattern
 * 4. Add tags in one section, see them appear as suggestions in another
 * 5. Check the aggregator piece to see events flowing in
 *
 * FEATURES DEMONSTRATED:
 * - Two tag instances with the same scope share suggestions
 * - A third tag instance with a different scope is isolated
 * - Community suggestions show dimmed with usage counts
 * - Events are posted to the aggregator in real-time
 */
import {
  type Default,
  NAME,
  pattern,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

// Import the FolksonomyTags sub-pattern
import { FolksonomyTags } from "./folksonomy-tags.tsx";

interface Input {
  /** Tags for item A (scope: demo-shared) */
  itemATags: string[] | Default<[]>;

  /** Tags for item B (scope: demo-shared - same as A) */
  itemBTags: string[] | Default<[]>;

  /** Tags for item C (scope: demo-isolated - different scope) */
  itemCTags: string[] | Default<[]>;

  /** Custom scope name */
  customScope: string | Default<"demo-shared">;
}

export interface Output {
  [NAME]: string;
  [UI]: VNode;
  itemATags: string[];
  itemBTags: string[];
  itemCTags: string[];
}

export default pattern<Input, Output>(
  ({ itemATags, itemBTags, itemCTags, customScope }) => {
    // Discover aggregator via wish - searches favorites and current space
    const aggregatorWish = wish<{
      events: unknown[];
      suggestions: Record<string, unknown[]>;
      postEvent: unknown;
    }>({
      query: "#folksonomyAggregator",
      scope: ["~", "."],
    });
    const hasAggregator = aggregatorWish.result != null;

    // Shared scope for A and B
    const sharedScope = `https://github.com/commontools/folksonomy-demo/${
      customScope || "demo-shared"
    }`;

    // Isolated scope for C
    const isolatedScope = new Writable(
      "https://github.com/commontools/folksonomy-demo/demo-isolated",
    );

    // Create tag instances - aggregator discovered via wish() internally
    const tagsA = FolksonomyTags({
      scope: sharedScope,
      tags: itemATags,
    });

    const tagsB = FolksonomyTags({
      scope: sharedScope,
      tags: itemBTags,
    });

    const tagsC = FolksonomyTags({
      scope: isolatedScope,
      tags: itemCTags,
    });

    return {
      [NAME]: "Folksonomy Demo",
      [UI]: (
        <cf-vstack gap="4" style={{ padding: "16px", maxWidth: "800px" }}>
          {/* Header */}
          <cf-vstack gap="2">
            <h1 style={{ margin: 0, fontSize: "24px" }}>
              🏷️ Folksonomy Tags Demo
            </h1>
            <p style={{ color: "#6b7280", margin: 0 }}>
              A community-enabled tag system with preferential attachment. Tags
              added here flow to the aggregator and become suggestions for
              others.
            </p>
          </cf-vstack>

          {/* Aggregator Status */}
          <div
            style={{
              padding: "12px 16px",
              background: hasAggregator ? "#f0fdf4" : "#fef3c7",
              border: `1px solid ${hasAggregator ? "#86efac" : "#fcd34d"}`,
              borderRadius: "8px",
            }}
          >
            <cf-hstack gap="2" align="center">
              <span style={{ fontSize: "18px" }}>
                {hasAggregator ? "✓" : "⚠"}
              </span>
              <span>
                {hasAggregator
                  ? "Connected to folksonomy-aggregator - community features active!"
                  : "Aggregator not found. Deploy and favorite folksonomy-aggregator with tag 'folksonomyAggregator' for community features."}
              </span>
            </cf-hstack>
          </div>

          {/* Shared Scope Section */}
          <cf-vstack
            gap="3"
            style={{
              padding: "16px",
              background: "#f9fafb",
              borderRadius: "12px",
              border: "1px solid #e5e7eb",
            }}
          >
            <cf-vstack gap="1">
              <h2 style={{ margin: 0, fontSize: "18px" }}>
                Shared Scope: Recipe Items A & B
              </h2>
              <p
                style={{
                  margin: 0,
                  fontSize: "13px",
                  color: "#6b7280",
                }}
              >
                These two items share a scope. Tags added to one will appear as
                suggestions in the other (via community aggregator).
              </p>
              <code
                style={{
                  fontSize: "11px",
                  color: "#9ca3af",
                  fontFamily: "monospace",
                }}
              >
                Scope: {sharedScope}
              </code>
            </cf-vstack>

            <cf-hstack gap="4" wrap>
              {/* Item A */}
              <cf-vstack
                gap="2"
                style={{
                  flex: 1,
                  minWidth: "280px",
                  padding: "12px",
                  background: "#ffffff",
                  borderRadius: "8px",
                  border: "1px solid #e5e7eb",
                }}
              >
                <span
                  style={{
                    fontWeight: "600",
                    color: "#374151",
                  }}
                >
                  Item A: Pasta Recipe
                </span>
                <cf-render $cell={tagsA} />
              </cf-vstack>

              {/* Item B */}
              <cf-vstack
                gap="2"
                style={{
                  flex: 1,
                  minWidth: "280px",
                  padding: "12px",
                  background: "#ffffff",
                  borderRadius: "8px",
                  border: "1px solid #e5e7eb",
                }}
              >
                <span
                  style={{
                    fontWeight: "600",
                    color: "#374151",
                  }}
                >
                  Item B: Pizza Recipe
                </span>
                <cf-render $cell={tagsB} />
              </cf-vstack>
            </cf-hstack>
          </cf-vstack>

          {/* Isolated Scope Section */}
          <cf-vstack
            gap="3"
            style={{
              padding: "16px",
              background: "#fef7ff",
              borderRadius: "12px",
              border: "1px solid #f0abfc",
            }}
          >
            <cf-vstack gap="1">
              <h2 style={{ margin: 0, fontSize: "18px" }}>
                Isolated Scope: Project Tasks
              </h2>
              <p
                style={{
                  margin: 0,
                  fontSize: "13px",
                  color: "#6b7280",
                }}
              >
                This item has a different scope. Its tags are separate from the
                recipe items above, but still contribute to the aggregator.
              </p>
              <code
                style={{
                  fontSize: "11px",
                  color: "#9ca3af",
                  fontFamily: "monospace",
                }}
              >
                Scope: demo-isolated
              </code>
            </cf-vstack>

            <cf-vstack
              gap="2"
              style={{
                padding: "12px",
                background: "#ffffff",
                borderRadius: "8px",
                border: "1px solid #f0abfc",
              }}
            >
              <span
                style={{
                  fontWeight: "600",
                  color: "#374151",
                }}
              >
                Item C: Task Tracker
              </span>
              <cf-render $cell={tagsC} />
            </cf-vstack>
          </cf-vstack>

          {/* How It Works */}
          <cf-vstack
            gap="2"
            style={{
              padding: "16px",
              background: "#eff6ff",
              borderRadius: "12px",
              border: "1px solid #bfdbfe",
            }}
          >
            <h3 style={{ margin: 0, fontSize: "16px" }}>How It Works</h3>
            <ol
              style={{
                margin: 0,
                paddingLeft: "20px",
                fontSize: "13px",
                color: "#4b5563",
              }}
            >
              <li>
                Add tags to Item A (e.g., "italian", "quick", "vegetarian")
              </li>
              <li>
                Notice the green dot - events are being sent to the aggregator
              </li>
              <li>
                Now type in Item B - you'll see Item A's tags as suggestions
                (via aggregator)
              </li>
              <li>
                Select a suggestion to "use" it - this increases its popularity
                count
              </li>
              <li>
                Item C has a different scope, so it won't see recipe tags
              </li>
              <li>
                Check the aggregator piece to see all events and top tags
              </li>
            </ol>
          </cf-vstack>

          {/* Preferential Attachment Note */}
          <div
            style={{
              padding: "12px",
              background: "#f0fdf4",
              border: "1px solid #86efac",
              borderRadius: "8px",
              fontSize: "13px",
            }}
          >
            <strong>Preferential Attachment:</strong>{" "}
            The more a tag is used, the higher it appears in suggestions. This
            creates a natural convergence toward useful vocabulary without
            top-down control.
          </div>
        </cf-vstack>
      ),
      itemATags,
      itemBTags,
      itemCTags,
    };
  },
);
