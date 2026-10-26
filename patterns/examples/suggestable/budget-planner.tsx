import {
  computed,
  Default,
  generateObject,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
} from "commonfabric";

// ===== Types =====

type BudgetInput = {
  topic?: string | Default<"">;
  context?: Record<string, any> | Default<Record<string, never>>;
  maxAmount?: number | Default<1000>;
};

type BudgetItem = {
  name: string;
  amount: number | Default<0>;
};

export type BudgetOutput = {
  [NAME]: string;
  [UI]: VNode;
  topic: string;
  items: BudgetItem[];
  total: number;
  remaining: number;
  pending: boolean;
};

// ===== Pattern =====

/**
 * Generates a budget breakdown with adjustable amounts for each category.
 * Designed as "suggestion fuel" - suggests spending categories that fit
 * within a given budget ceiling.
 */
const BudgetPlanner = pattern<BudgetInput, BudgetOutput>(
  ({ topic, context, maxAmount }) => {
    // An empty prompt holds the request back: `generateObject` clears its
    // state and makes no call until one arrives. A budget with no topic has
    // nothing to break down, so the model is asked only once a caller names
    // what the money is for.
    const prompt = computed(() => {
      if (!topic) return "";
      return `Create a budget breakdown for: ${topic}. Suggest 4-8 spending categories with dollar amounts that sum to exactly $${maxAmount}.`;
    });

    const response = generateObject<{ items: BudgetItem[] }>({
      system:
        "You create practical budget breakdowns. Each item should have a descriptive name and a reasonable dollar amount. Keep categories specific and actionable. Amounts should be whole numbers.",
      prompt,
      context,
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                amount: { type: "number" },
              },
              required: ["name", "amount"],
            },
          },
        },
        required: ["items"],
      },
      model: "anthropic:claude-haiku-4-5",
    });

    const items = computed(() => response.result?.items || []);

    const total = computed(() => {
      let sum = 0;
      for (const item of items) {
        sum += item.amount || 0;
      }
      return sum;
    });

    const remaining = computed(() => (maxAmount || 0) - total);

    return {
      [NAME]: computed(() => (topic ? `Budget: ${topic}` : "Budget Planner")),
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header" gap="1">
            <cf-heading level={4}>
              {computed(() => topic || "Budget Planner")}
            </cf-heading>
            <span style="color: var(--cf-theme-color-text-secondary); font-size: 0.85rem;">
              Budget: ${maxAmount}
            </span>
          </cf-vstack>

          <cf-vstack gap="3" style="padding: 1.5rem;">
            {ifElse(
              response.pending,
              <div style="color: var(--cf-theme-color-text-secondary);">
                <cf-loader show-elapsed /> Generating budget...
              </div>,
              <cf-vstack gap="3">
                {items.map((item) => (
                  <cf-hstack gap="2" align="center">
                    <span style={{ flex: "1", fontWeight: "500" }}>
                      {item.name}
                    </span>
                    <cf-hstack gap="1" align="center">
                      <span style="color: var(--cf-theme-color-text-secondary); font-size: 0.85rem;">
                        $
                      </span>
                      <cf-input
                        $value={item.amount}
                        style="width: 5rem; text-align: right;"
                      />
                    </cf-hstack>
                  </cf-hstack>
                ))}

                <div
                  style={{
                    borderTop:
                      "2px solid var(--cf-theme-color-border, #e5e7eb)",
                    paddingTop: "0.75rem",
                    marginTop: "0.25rem",
                  }}
                >
                  <cf-hstack gap="2" align="center">
                    <span style={{ flex: "1", fontWeight: "700" }}>Total</span>
                    <span style={{ fontWeight: "700" }}>${total}</span>
                  </cf-hstack>
                  <cf-hstack
                    gap="2"
                    align="center"
                    style="margin-top: 0.25rem;"
                  >
                    <span
                      style={{
                        flex: "1",
                        color: "var(--cf-theme-color-text-secondary)",
                        fontSize: "0.85rem",
                      }}
                    >
                      Remaining
                    </span>
                    <span
                      style={{
                        fontSize: "0.85rem",
                        color: computed(() =>
                          remaining < 0
                            ? "var(--cf-theme-color-error, #ef4444)"
                            : "var(--cf-theme-color-text-secondary)"
                        ),
                      }}
                    >
                      ${remaining}
                    </span>
                  </cf-hstack>
                </div>
              </cf-vstack>,
            )}
          </cf-vstack>
        </cf-screen>
      ),
      topic,
      items,
      total,
      remaining,
      pending: response.pending,
    };
  },
);

export default BudgetPlanner;
