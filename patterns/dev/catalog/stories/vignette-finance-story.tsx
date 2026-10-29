import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface VignetteFinanceStoryInput {}
export interface VignetteFinanceStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

const phoneFrame = {
  width: "375px",
  height: "720px",
  borderRadius: "40px",
  overflow: "hidden",
  boxShadow:
    "0 25px 60px rgba(0,0,0,0.3), 0 0 0 2px rgba(255,255,255,0.1), inset 0 0 0 1px rgba(255,255,255,0.05)",
  flexShrink: "0",
  position: "relative" as const,
};

const phoneScreen = {
  width: "100%",
  height: "100%",
  overflow: "auto",
  position: "relative" as const,
};

function BarDay(
  { height, label, highlight }: {
    height: string;
    label: string;
    highlight?: boolean;
  },
) {
  return (
    <div
      style={{
        flex: "1",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "4px",
        height: "100%",
        justifyContent: "flex-end",
      }}
    >
      <div
        style={{
          width: "100%",
          height,
          borderRadius: "4px 4px 0 0",
          background: highlight
            ? "linear-gradient(180deg, #6C5CE7, #00CEC9)"
            : "#2A2A5A",
        }}
      />
      <span style={{ fontSize: "9px", color: "#636e88" }}>{label}</span>
    </div>
  );
}

export default pattern<VignetteFinanceStoryInput, VignetteFinanceStoryOutput>(
  () => {
    const financeTheme = {
      fontFamily:
        "'SF Pro Display', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
      borderRadius: "16px",
      density: "comfortable" as const,
      colorScheme: "dark" as const,
      colors: {
        primary: "#7C6CF7",
        primaryForeground: "#FFFFFF",
        secondary: "#2D3436",
        secondaryForeground: "#DFE6E9",
        background: "#0C0C1E",
        surface: "#16163A",
        surfaceHover: "#1E1E50",
        text: "#F0F0FF",
        textMuted: "#636e88",
        border: "#2A2A5A",
        borderMuted: "#1E1E4A",
        accent: "#00CEC9",
        accentForeground: "#0C0C1E",
        success: "#00B894",
        successForeground: "#FFFFFF",
        error: "#FF6B6B",
        errorForeground: "#FFFFFF",
        warning: "#FDCB6E",
        warningForeground: "#0C0C1E",
      },
    };

    return {
      [NAME]: "Vignette: Finance Dashboard",
      [UI]: (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            minHeight: "100%",
            padding: "40px",
            background:
              "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)",
          }}
        >
          <div style={phoneFrame}>
            <cf-theme theme={financeTheme}>
              <div
                style={{
                  ...phoneScreen,
                  background:
                    "linear-gradient(160deg, #0C0C1E 0%, #141432 50%, #0C0C1E 100%)",
                  fontFamily:
                    "'SF Pro Display', -apple-system, system-ui, sans-serif",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                {/* Status bar */}
                <div
                  style={{
                    padding: "16px 28px 8px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    color: "#636e88",
                    fontSize: "12px",
                  }}
                >
                  <span style={{ fontWeight: "600" }}>9:41</span>
                  <span>●●●</span>
                </div>

                {/* Header */}
                <div style={{ padding: "16px 28px 8px" }}>
                  <cf-hstack gap="3" justify="between" align="center">
                    <div>
                      <div
                        style={{
                          fontSize: "13px",
                          color: "#636e88",
                          marginBottom: "2px",
                        }}
                      >
                        Total Balance
                      </div>
                      <div
                        style={{
                          fontSize: "36px",
                          fontWeight: "700",
                          color: "#F0F0FF",
                          lineHeight: "1.1",
                          letterSpacing: "-0.02em",
                        }}
                      >
                        $24,831
                        <span style={{ fontSize: "20px", color: "#636e88" }}>
                          .50
                        </span>
                      </div>
                    </div>
                    <div
                      style={{
                        width: "40px",
                        height: "40px",
                        borderRadius: "50%",
                        background:
                          "linear-gradient(135deg, #6C5CE7 0%, #00CEC9 100%)",
                      }}
                    />
                  </cf-hstack>
                </div>

                {/* Quick stats */}
                <div style={{ padding: "16px 28px" }}>
                  <cf-hstack gap="2">
                    <cf-card style={{ flex: "1" }}>
                      <cf-vstack gap="1">
                        <span
                          style={{
                            fontSize: "11px",
                            color: "#636e88",
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                          }}
                        >
                          Income
                        </span>
                        <span
                          style={{
                            fontSize: "20px",
                            fontWeight: "700",
                            color: "#00B894",
                          }}
                        >
                          +$5,240
                        </span>
                      </cf-vstack>
                    </cf-card>
                    <cf-card style={{ flex: "1" }}>
                      <cf-vstack gap="1">
                        <span
                          style={{
                            fontSize: "11px",
                            color: "#636e88",
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                          }}
                        >
                          Expenses
                        </span>
                        <span
                          style={{
                            fontSize: "20px",
                            fontWeight: "700",
                            color: "#FF6B6B",
                          }}
                        >
                          -$2,180
                        </span>
                      </cf-vstack>
                    </cf-card>
                  </cf-hstack>
                </div>

                {/* Spending chart */}
                <div style={{ padding: "0 28px 8px" }}>
                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-hstack gap="2" justify="between" align="center">
                        <span
                          style={{
                            fontSize: "14px",
                            fontWeight: "600",
                            color: "#F0F0FF",
                          }}
                        >
                          This Week
                        </span>
                        <cf-chip>Apr 2026</cf-chip>
                      </cf-hstack>
                      <cf-hstack gap="1" align="end" style={{ height: "80px" }}>
                        <BarDay height="45%" label="M" />
                        <BarDay height="70%" label="T" />
                        <BarDay height="35%" label="W" />
                        <BarDay height="90%" label="T" highlight />
                        <BarDay height="55%" label="F" />
                        <BarDay height="80%" label="S" />
                        <BarDay height="60%" label="S" />
                      </cf-hstack>
                    </cf-vstack>
                  </cf-card>
                </div>

                {/* Transactions */}
                <div style={{ padding: "8px 28px 0", flex: "1" }}>
                  <cf-hstack gap="2" justify="between" align="center">
                    <span
                      style={{
                        fontSize: "14px",
                        fontWeight: "600",
                        color: "#F0F0FF",
                      }}
                    >
                      Recent
                    </span>
                    <span style={{ fontSize: "12px", color: "#6C5CE7" }}>
                      See all
                    </span>
                  </cf-hstack>

                  <cf-vstack gap="0" style={{ marginTop: "12px" }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "12px 0",
                        borderBottom: "1px solid #1E1E4A",
                      }}
                    >
                      <cf-hstack gap="3" align="center">
                        <div
                          style={{
                            width: "36px",
                            height: "36px",
                            borderRadius: "10px",
                            background: "#1E1E50",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "16px",
                          }}
                        >
                          ☕
                        </div>
                        <cf-vstack gap="0">
                          <span
                            style={{
                              fontSize: "13px",
                              fontWeight: "500",
                              color: "#F0F0FF",
                            }}
                          >
                            Blue Bottle Coffee
                          </span>
                          <span
                            style={{ fontSize: "11px", color: "#636e88" }}
                          >
                            Today, 8:30 AM
                          </span>
                        </cf-vstack>
                      </cf-hstack>
                      <span
                        style={{
                          fontSize: "14px",
                          fontWeight: "600",
                          color: "#FF6B6B",
                        }}
                      >
                        -$6.50
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "12px 0",
                        borderBottom: "1px solid #1E1E4A",
                      }}
                    >
                      <cf-hstack gap="3" align="center">
                        <div
                          style={{
                            width: "36px",
                            height: "36px",
                            borderRadius: "10px",
                            background: "#1E1E50",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "16px",
                          }}
                        >
                          💰
                        </div>
                        <cf-vstack gap="0">
                          <span
                            style={{
                              fontSize: "13px",
                              fontWeight: "500",
                              color: "#F0F0FF",
                            }}
                          >
                            Salary Deposit
                          </span>
                          <span
                            style={{ fontSize: "11px", color: "#636e88" }}
                          >
                            Yesterday
                          </span>
                        </cf-vstack>
                      </cf-hstack>
                      <span
                        style={{
                          fontSize: "14px",
                          fontWeight: "600",
                          color: "#00B894",
                        }}
                      >
                        +$5,240
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "12px 0",
                      }}
                    >
                      <cf-hstack gap="3" align="center">
                        <div
                          style={{
                            width: "36px",
                            height: "36px",
                            borderRadius: "10px",
                            background: "#1E1E50",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "16px",
                          }}
                        >
                          🛒
                        </div>
                        <cf-vstack gap="0">
                          <span
                            style={{
                              fontSize: "13px",
                              fontWeight: "500",
                              color: "#F0F0FF",
                            }}
                          >
                            Whole Foods
                          </span>
                          <span
                            style={{ fontSize: "11px", color: "#636e88" }}
                          >
                            Yesterday
                          </span>
                        </cf-vstack>
                      </cf-hstack>
                      <span
                        style={{
                          fontSize: "14px",
                          fontWeight: "600",
                          color: "#FF6B6B",
                        }}
                      >
                        -$84.30
                      </span>
                    </div>
                  </cf-vstack>
                </div>

                {/* Bottom action */}
                <div style={{ padding: "12px 28px 32px", paddingTop: "14px" }}>
                  <div
                    style={{
                      display: "flex",
                      gap: "8px",
                    }}
                  >
                    <cf-button
                      variant="primary"
                      style={{ flex: "1", display: "block" }}
                    >
                      Send
                    </cf-button>
                    <cf-button
                      variant="outline"
                      style={{ flex: "1", display: "block" }}
                    >
                      Request
                    </cf-button>
                  </div>
                </div>
              </div>
            </cf-theme>
          </div>
        </div>
      ),
      controls: (
        <div
          style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}
        >
          Finance dashboard vignette. Dark theme with purple-teal gradient
          accents, system font, 16px border-radius. Demonstrates cf-theme,
          cf-card, cf-chip, cf-hstack, cf-vstack, cf-button with a custom bar
          chart.
        </div>
      ),
    };
  },
);
