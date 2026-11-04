import {
  computed,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

import { Controls, SelectControl } from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface ThemeSamplerStoryInput {}
export interface ThemeSamplerStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

const themes: Record<string, Record<string, unknown>> = {
  default: {},
  neutral: {
    colorScheme: "light",
    colors: {
      primary: "#4979fa",
      primaryForeground: "#ffffff",
      secondary: "#eceef1",
      secondaryForeground: "#34373c",
      background: "#ffffff",
      surface: "#f2f3f6",
      surfaceHover: "#eceef1",
      text: "#34373c",
      textMuted: "#5b5f65",
      border: "rgba(79, 89, 103, 0.15)",
      borderMuted: "rgba(79, 89, 103, 0.08)",
      accent: "#fc856d",
      accentForeground: "#ffffff",
      success: "#21c17b",
      successForeground: "#ffffff",
      error: "#ff6057",
      errorForeground: "#ffffff",
      warning: "#e5a126",
      warningForeground: "#ffffff",
    },
  },
  warm: {
    fontFamily: "'Georgia', 'Times New Roman', serif",
    borderRadius: "12px",
    density: "spacious",
    colorScheme: "light",
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
  },
  dark: {
    borderRadius: "16px",
    density: "comfortable",
    colorScheme: "dark",
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
  },
  highContrast: {
    colorScheme: "light",
    colors: {
      primary: "#0000EE",
      primaryForeground: "#FFFFFF",
      secondary: "#E0E0E0",
      secondaryForeground: "#000000",
      background: "#FFFFFF",
      surface: "#F0F0F0",
      surfaceHover: "#E0E0E0",
      text: "#000000",
      textMuted: "#333333",
      border: "#000000",
      borderMuted: "#666666",
      accent: "#CC0000",
      accentForeground: "#FFFFFF",
      success: "#006600",
      successForeground: "#FFFFFF",
      error: "#CC0000",
      errorForeground: "#FFFFFF",
      warning: "#CC6600",
      warningForeground: "#FFFFFF",
    },
  },
};

const themeItems = [
  { label: "Default (system)", value: "default" },
  { label: "Neutral Slate (Figma)", value: "neutral" },
  { label: "Warm (serif)", value: "warm" },
  { label: "Dark (finance)", value: "dark" },
  { label: "High Contrast", value: "highContrast" },
];

function SemanticTokenGrid() {
  const tokenGroups = [
    {
      label: "Text",
      tokens: [
        { name: "text", var: "--cf-theme-color-text" },
        { name: "text-muted", var: "--cf-theme-color-text-muted" },
      ],
    },
    {
      label: "Surfaces",
      tokens: [
        { name: "background", var: "--cf-theme-color-background" },
        { name: "surface", var: "--cf-theme-color-surface" },
        { name: "surface-hover", var: "--cf-theme-color-surface-hover" },
      ],
    },
    {
      label: "Borders",
      tokens: [
        { name: "border", var: "--cf-theme-color-border" },
        { name: "border-muted", var: "--cf-theme-color-border-muted" },
      ],
    },
    {
      label: "Accents",
      tokens: [
        { name: "primary", var: "--cf-theme-color-primary" },
        { name: "secondary", var: "--cf-theme-color-secondary" },
        { name: "accent", var: "--cf-theme-color-accent" },
      ],
    },
    {
      label: "Status",
      tokens: [
        { name: "success", var: "--cf-theme-color-success" },
        { name: "warning", var: "--cf-theme-color-warning" },
        { name: "error", var: "--cf-theme-color-error" },
      ],
    },
    {
      label: "Derived",
      tokens: [
        { name: "primary-light", var: "--cf-theme-color-primary-light" },
        { name: "success-light", var: "--cf-theme-color-success-light" },
        { name: "error-surface", var: "--cf-theme-color-error-surface" },
        { name: "error-light", var: "--cf-theme-color-error-light" },
      ],
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <h3
        style={{
          margin: "0",
          fontSize: "14px",
          fontWeight: "600",
          color: "var(--cf-theme-color-text)",
        }}
      >
        Semantic Tokens
      </h3>
      {tokenGroups.map((group) => (
        <div>
          <div
            style={{
              fontSize: "11px",
              fontWeight: "600",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--cf-theme-color-text-muted)",
              marginBottom: "6px",
            }}
          >
            {group.label}
          </div>
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}
          >
            {group.tokens.map((t) => (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "4px 8px",
                  borderRadius: "6px",
                  border: "1px solid var(--cf-theme-color-border-muted)",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  color: "var(--cf-theme-color-text-muted)",
                }}
              >
                <div
                  style={{
                    width: "16px",
                    height: "16px",
                    borderRadius: "3px",
                    border: "1px solid var(--cf-theme-color-border)",
                    backgroundColor: `var(${t.var})`,
                    flexShrink: "0",
                  }}
                />
                {t.name}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ComponentSampler() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <h3
        style={{
          margin: "0",
          fontSize: "14px",
          fontWeight: "600",
          color: "var(--cf-theme-color-text)",
        }}
      >
        Component Sampler
      </h3>

      {/* Buttons */}
      <div>
        <div
          style={{
            fontSize: "11px",
            fontWeight: "600",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--cf-theme-color-text-muted)",
            marginBottom: "8px",
          }}
        >
          Buttons
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <cf-button color="primary" variant="solid">Primary</cf-button>
          <cf-button color="neutral" variant="outline">Secondary</cf-button>
          <cf-button color="danger" variant="solid">Destructive</cf-button>
          <cf-button color="neutral" variant="ghost">Ghost</cf-button>
          <cf-button color="neutral" variant="outline">Outline</cf-button>
        </div>
      </div>

      {/* Chips & Badges */}
      <div>
        <div
          style={{
            fontSize: "11px",
            fontWeight: "600",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--cf-theme-color-text-muted)",
            marginBottom: "8px",
          }}
        >
          Chips & Badges
        </div>
        <div
          style={{
            display: "flex",
            gap: "8px",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <cf-chip>Default</cf-chip>
          <cf-chip color="primary">Primary</cf-chip>
          <cf-chip color="accent">Accent</cf-chip>
          <cf-badge color="primary" variant="solid">Default</cf-badge>
          <cf-badge color="neutral" variant="solid">Secondary</cf-badge>
          <cf-badge color="danger" variant="solid">Destructive</cf-badge>
          <cf-badge color="neutral" variant="outline">Outline</cf-badge>
        </div>
      </div>

      {/* Alerts */}
      <div>
        <div
          style={{
            fontSize: "11px",
            fontWeight: "600",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--cf-theme-color-text-muted)",
            marginBottom: "8px",
          }}
        >
          Alerts
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <cf-alert status="info">
            <span slot="title">Info</span>
            Informational message using theme tokens.
          </cf-alert>
          <cf-alert status="success">
            <span slot="title">Success</span>
            Operation completed using theme tokens.
          </cf-alert>
          <cf-alert status="error">
            <span slot="title">Error</span>
            Something went wrong using theme tokens.
          </cf-alert>
        </div>
      </div>

      {/* Card */}
      <div>
        <div
          style={{
            fontSize: "11px",
            fontWeight: "600",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--cf-theme-color-text-muted)",
            marginBottom: "8px",
          }}
        >
          Card
        </div>
        <cf-card>
          <span slot="header">Card Title</span>
          <div>
            Card content rendered inside a themed surface. Border, radius, and
            background should all resolve from the active theme.
          </div>
        </cf-card>
      </div>

      {/* List Items */}
      <div>
        <div
          style={{
            fontSize: "11px",
            fontWeight: "600",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--cf-theme-color-text-muted)",
            marginBottom: "8px",
          }}
        >
          List Items
        </div>
        <div
          style={{
            border: "1px solid var(--cf-theme-color-border)",
            borderRadius: "var(--cf-theme-border-radius, 8px)",
            overflow: "hidden",
          }}
        >
          <cf-list-item label="First item" description="With a description" />
          <cf-list-item label="Second item" description="Also themed" />
          <cf-list-item
            label="Third item"
            description="Hover to check surfaceHover"
          />
        </div>
      </div>

      {/* Input */}
      <div>
        <div
          style={{
            fontSize: "11px",
            fontWeight: "600",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--cf-theme-color-text-muted)",
            marginBottom: "8px",
          }}
        >
          Input
        </div>
        <cf-input placeholder="Themed input field" />
      </div>

      {/* Label */}
      <div>
        <div
          style={{
            fontSize: "11px",
            fontWeight: "600",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--cf-theme-color-text-muted)",
            marginBottom: "8px",
          }}
        >
          Text
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span
            style={{ color: "var(--cf-theme-color-text)", fontSize: "14px" }}
          >
            Default text color
          </span>
          <span
            style={{
              color: "var(--cf-theme-color-text-muted)",
              fontSize: "14px",
            }}
          >
            Muted text color
          </span>
          <cf-text variant="caption" tone="muted" block>
            Text component
          </cf-text>
        </div>
      </div>
    </div>
  );
}

export default pattern<ThemeSamplerStoryInput, ThemeSamplerStoryOutput>(
  () => {
    const selectedTheme = new Writable("default");

    const activeTheme = computed(() => themes[selectedTheme.get()] ?? {});

    return {
      [NAME]: "Theme Sampler",
      [UI]: (
        <div style={{ padding: "24px", minHeight: "100%" }}>
          <cf-theme theme={activeTheme}>
            <div
              style={{
                padding: "24px",
                backgroundColor: "var(--cf-theme-color-background)",
                borderRadius: "12px",
                border: "1px solid var(--cf-theme-color-border)",
                display: "flex",
                flexDirection: "column",
                gap: "32px",
              }}
            >
              <div>
                <h2
                  style={{
                    margin: "0 0 4px",
                    fontSize: "20px",
                    fontWeight: "700",
                    color: "var(--cf-theme-color-text)",
                  }}
                >
                  Theme Sampler
                </h2>
                <p
                  style={{
                    margin: "0",
                    fontSize: "13px",
                    color: "var(--cf-theme-color-text-muted)",
                  }}
                >
                  Switch themes using the control below to verify semantic token
                  propagation across components.
                </p>
              </div>
              <SemanticTokenGrid />
              <cf-separator />
              <ComponentSampler />
            </div>
          </cf-theme>
        </div>
      ),
      controls: (
        <Controls>
          <SelectControl
            label="theme"
            description="Active theme preset"
            defaultValue="default"
            value={selectedTheme}
            items={themeItems}
          />
        </Controls>
      ),
    };
  },
);
