import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface VignetteRecipeStoryInput {}
export interface VignetteRecipeStoryOutput {
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

export default pattern<VignetteRecipeStoryInput, VignetteRecipeStoryOutput>(
  () => {
    const recipeTheme = {
      fontFamily: "'Georgia', 'Times New Roman', serif",
      borderRadius: "12px",
      density: "spacious" as const,
      colorScheme: "light" as const,
      colors: {
        primary: "#8B4513",
        primaryForeground: "#FFF8F0",
        secondary: "#D2B48C",
        secondaryForeground: "#3E2723",
        background: "#FFF8F0",
        surface: "#FFF0E0",
        surfaceHover: "#FFE4CC",
        text: "#2C1810",
        textMuted: "#8B7355",
        border: "#E8D5C0",
        borderMuted: "#F0E6D8",
        accent: "#C84C09",
        accentForeground: "#FFF8F0",
        success: "#4A7C59",
        successForeground: "#ffffff",
        error: "#A03020",
        errorForeground: "#ffffff",
        warning: "#B8860B",
        warningForeground: "#ffffff",
      },
    };

    return {
      [NAME]: "Vignette: Recipe App",
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
            <cf-theme theme={recipeTheme}>
              <div
                style={{
                  ...phoneScreen,
                  background:
                    "linear-gradient(180deg, #FFF8F0 0%, #FFF0E0 50%, #FFE8D0 100%)",
                  fontFamily: "'Georgia', serif",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                {/* Header with warm tones */}
                <div style={{ padding: "48px 28px 0" }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: "24px",
                    }}
                  >
                    <div style={{ fontSize: "13px", color: "#8B7355" }}>
                      Good morning
                    </div>
                    <div
                      style={{
                        width: "36px",
                        height: "36px",
                        borderRadius: "50%",
                        background:
                          "linear-gradient(135deg, #D2B48C 0%, #8B4513 100%)",
                      }}
                    />
                  </div>
                  <cf-heading level={2}>
                    <span style={{ fontStyle: "italic", fontWeight: "400" }}>
                      What shall we
                    </span>
                    <br />
                    <span style={{ fontWeight: "700" }}>cook today?</span>
                  </cf-heading>
                </div>

                {/* Search */}
                <div style={{ padding: "20px 28px" }}>
                  <cf-input placeholder="Search recipes..." type="search" />
                </div>

                {/* Category chips */}
                <div style={{ padding: "0 28px 16px" }}>
                  <cf-hstack gap="2" wrap>
                    <cf-chip color="primary" interactive>All</cf-chip>
                    <cf-chip interactive>Breakfast</cf-chip>
                    <cf-chip interactive>Lunch</cf-chip>
                    <cf-chip interactive>Dinner</cf-chip>
                    <cf-chip interactive>Dessert</cf-chip>
                  </cf-hstack>
                </div>

                {/* Featured recipe card */}
                <div style={{ padding: "0 28px 16px" }}>
                  <cf-card>
                    <cf-vstack gap="2">
                      <div
                        style={{
                          width: "100%",
                          height: "140px",
                          borderRadius: "8px",
                          background:
                            "linear-gradient(135deg, #D2691E 0%, #8B4513 40%, #654321 100%)",
                          display: "flex",
                          alignItems: "flex-end",
                          padding: "12px",
                          boxSizing: "border-box",
                        }}
                      >
                        <cf-badge>Featured</cf-badge>
                      </div>
                      <div>
                        <div
                          style={{
                            fontSize: "18px",
                            fontWeight: "700",
                            color: "#2C1810",
                            fontFamily: "'Georgia', serif",
                          }}
                        >
                          Rustic Sourdough Bread
                        </div>
                        <div
                          style={{
                            fontSize: "13px",
                            color: "#8B7355",
                            fontStyle: "italic",
                            marginTop: "4px",
                          }}
                        >
                          A slow-fermented artisan loaf with a crackling crust
                        </div>
                      </div>
                      <cf-hstack gap="3" align="center">
                        <cf-hstack gap="1" align="center">
                          <span style={{ fontSize: "14px" }}>◷</span>
                          <span style={{ fontSize: "12px", color: "#8B7355" }}>
                            4 hrs
                          </span>
                        </cf-hstack>
                        <cf-separator orientation="vertical" />
                        <cf-hstack gap="1" align="center">
                          <span style={{ fontSize: "14px" }}>◎</span>
                          <span style={{ fontSize: "12px", color: "#8B7355" }}>
                            Medium
                          </span>
                        </cf-hstack>
                        <div style={{ flex: "1" }} />
                        <cf-button color="neutral" variant="outline" size="sm">
                          View Recipe
                        </cf-button>
                      </cf-hstack>
                    </cf-vstack>
                  </cf-card>
                </div>

                {/* Quick picks */}
                <div style={{ padding: "0 28px", flex: "1" }}>
                  <div
                    style={{
                      fontSize: "12px",
                      color: "#8B7355",
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      marginBottom: "12px",
                      fontFamily: "system-ui, sans-serif",
                    }}
                  >
                    Quick picks
                  </div>
                  <cf-vstack gap="2">
                    <cf-card>
                      <cf-hstack gap="3" align="center">
                        <div
                          style={{
                            width: "48px",
                            height: "48px",
                            borderRadius: "8px",
                            background:
                              "linear-gradient(135deg, #F4A460 0%, #CD853F 100%)",
                            flexShrink: "0",
                          }}
                        />
                        <cf-vstack gap="0" style={{ flex: "1" }}>
                          <span
                            style={{
                              fontWeight: "600",
                              fontSize: "14px",
                              color: "#2C1810",
                            }}
                          >
                            Honey Oat Granola
                          </span>
                          <span
                            style={{
                              fontSize: "12px",
                              color: "#8B7355",
                              fontStyle: "italic",
                            }}
                          >
                            20 min · Easy
                          </span>
                        </cf-vstack>
                      </cf-hstack>
                    </cf-card>
                    <cf-card>
                      <cf-hstack gap="3" align="center">
                        <div
                          style={{
                            width: "48px",
                            height: "48px",
                            borderRadius: "8px",
                            background:
                              "linear-gradient(135deg, #BC8F8F 0%, #8B6C5C 100%)",
                            flexShrink: "0",
                          }}
                        />
                        <cf-vstack gap="0" style={{ flex: "1" }}>
                          <span
                            style={{
                              fontWeight: "600",
                              fontSize: "14px",
                              color: "#2C1810",
                            }}
                          >
                            Mushroom Risotto
                          </span>
                          <span
                            style={{
                              fontSize: "12px",
                              color: "#8B7355",
                              fontStyle: "italic",
                            }}
                          >
                            45 min · Medium
                          </span>
                        </cf-vstack>
                      </cf-hstack>
                    </cf-card>
                  </cf-vstack>
                </div>

                {/* Bottom nav */}
                <div
                  style={{
                    padding: "12px 28px 32px",
                    borderTop: "1px solid #E8D5C0",
                    background: "rgba(255,248,240,0.9)",
                  }}
                >
                  <cf-hstack gap="0" justify="around" align="center">
                    <cf-vstack gap="0" align="center">
                      <span style={{ fontSize: "18px" }}>◉</span>
                      <span
                        style={{
                          fontSize: "9px",
                          color: "#8B4513",
                          fontWeight: "600",
                        }}
                      >
                        Home
                      </span>
                    </cf-vstack>
                    <cf-vstack gap="0" align="center">
                      <span style={{ fontSize: "18px", color: "#8B7355" }}>
                        ◎
                      </span>
                      <span style={{ fontSize: "9px", color: "#8B7355" }}>
                        Saved
                      </span>
                    </cf-vstack>
                    <cf-vstack gap="0" align="center">
                      <span style={{ fontSize: "18px", color: "#8B7355" }}>
                        ◷
                      </span>
                      <span style={{ fontSize: "9px", color: "#8B7355" }}>
                        Timers
                      </span>
                    </cf-vstack>
                    <cf-vstack gap="0" align="center">
                      <span style={{ fontSize: "18px", color: "#8B7355" }}>
                        ◆
                      </span>
                      <span style={{ fontSize: "9px", color: "#8B7355" }}>
                        Profile
                      </span>
                    </cf-vstack>
                  </cf-hstack>
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
          Artisan recipe app vignette. Warm light theme, Georgia serif
          typography, 12px border-radius, saddlebrown primary with earthy
          palette. Demonstrates cf-theme, cf-heading, cf-input, cf-chip,
          cf-card, cf-hstack, cf-vstack, cf-separator, cf-badge, cf-button.
        </div>
      ),
    };
  },
);
