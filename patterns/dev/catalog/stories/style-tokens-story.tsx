import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface StyleTokensStoryInput {}
export interface StyleTokensStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

interface Token {
  name: string;
  value: string;
}

interface TokenGroup {
  title: string;
  tokens: Token[];
}

const colors: TokenGroup = {
  title: "Colors",
  tokens: [
    // Primary ramp
    { name: "--cf-colors-primary-50", value: "#eef2fe" },
    { name: "--cf-colors-primary-100", value: "#d5dffd" },
    { name: "--cf-colors-primary-200", value: "#b3c5fb" },
    { name: "--cf-colors-primary-300", value: "#8da8fa" },
    { name: "--cf-colors-primary-400", value: "#6b8ffa" },
    { name: "--cf-colors-primary-500", value: "#4979fa" },
    { name: "--cf-colors-primary-600", value: "#3e6af7" },
    { name: "--cf-colors-primary-700", value: "#376bf9" },
    { name: "--cf-colors-primary-800", value: "#2a54d4" },
    { name: "--cf-colors-primary-900", value: "#1e3faa" },
    // Gray ramp
    { name: "--cf-colors-gray-50", value: "#ffffff" },
    { name: "--cf-colors-gray-100", value: "#f2f3f6" },
    { name: "--cf-colors-gray-200", value: "#eceef1" },
    { name: "--cf-colors-gray-300", value: "#d5d7dd" },
    { name: "--cf-colors-gray-400", value: "#b3b6bc" },
    { name: "--cf-colors-gray-500", value: "#94979e" },
    { name: "--cf-colors-gray-600", value: "#5b5f65" },
    { name: "--cf-colors-gray-700", value: "#404349" },
    { name: "--cf-colors-gray-800", value: "#34373c" },
    { name: "--cf-colors-gray-900", value: "#16181d" },
    // Semantic
    { name: "--cf-colors-success", value: "#21c17b" },
    { name: "--cf-colors-warning", value: "#e5a126" },
    { name: "--cf-colors-error", value: "#ff6057" },
    { name: "--cf-colors-info", value: "#4979fa" },
    // Slate (Figma canonical names)
    { name: "--cf-colors-slate-000", value: "#ffffff" },
    { name: "--cf-colors-slate-100", value: "#f2f3f6" },
    { name: "--cf-colors-slate-150", value: "#eceef1" },
    { name: "--cf-colors-slate-300", value: "#d5d7dd" },
    { name: "--cf-colors-slate-400", value: "#b3b6bc" },
    { name: "--cf-colors-slate-450", value: "#94979e" },
    { name: "--cf-colors-slate-550", value: "#5b5f65" },
    { name: "--cf-colors-slate-600", value: "#404349" },
    { name: "--cf-colors-slate-700", value: "#34373c" },
    // Named
    { name: "--cf-colors-white", value: "#ffffff" },
    { name: "--cf-colors-blue-50", value: "#eff6ff" },
    { name: "--cf-colors-blue-100", value: "#dbeafe" },
    { name: "--cf-colors-blue", value: "#4979fa" },
    { name: "--cf-colors-blue-500", value: "#3b82f6" },
    { name: "--cf-colors-blue-600", value: "#2563eb" },
    { name: "--cf-colors-blue-dark", value: "#376bf9" },
    { name: "--cf-colors-blue-a10", value: "rgba(73, 121, 250, 0.1)" },
    { name: "--cf-colors-blue-a20", value: "rgba(73, 121, 250, 0.15)" },
    { name: "--cf-colors-blue-a90", value: "rgba(73, 121, 250, 0.9)" },
    { name: "--cf-colors-purple", value: "#8952fd" },
    { name: "--cf-colors-purple-dark", value: "#632cda" },
    { name: "--cf-colors-purple-a10", value: "rgba(137, 82, 253, 0.1)" },
    { name: "--cf-colors-purple-a20", value: "rgba(137, 82, 253, 0.15)" },
    { name: "--cf-colors-red", value: "#ff6057" },
    { name: "--cf-colors-red-50", value: "#fef2f2" },
    { name: "--cf-colors-red-100", value: "#fee2e2" },
    { name: "--cf-colors-red-200", value: "#fecaca" },
    { name: "--cf-colors-red-500", value: "#ef4444" },
    { name: "--cf-colors-red-600", value: "#dc2626" },
    { name: "--cf-colors-red-700", value: "#b91c1c" },
    { name: "--cf-colors-red-dark", value: "#eb4747" },
    { name: "--cf-colors-red-a10", value: "rgba(255, 96, 87, 0.1)" },
    { name: "--cf-colors-red-a20", value: "rgba(255, 96, 87, 0.15)" },
    { name: "--cf-colors-green-50", value: "#f0fdf4" },
    { name: "--cf-colors-green-100", value: "#dcfce7" },
    { name: "--cf-colors-green", value: "#21c17b" },
    { name: "--cf-colors-green-500", value: "#22c55e" },
    { name: "--cf-colors-green-600", value: "#16a34a" },
    { name: "--cf-colors-coral", value: "#fc856d" },
    { name: "--cf-colors-indigo", value: "#5b53ff" },
    // Alpha
    { name: "--cf-colors-alpha-00", value: "rgba(13, 18, 24, 0)" },
    { name: "--cf-colors-alpha-03", value: "rgba(37, 45, 54, 0.03)" },
    { name: "--cf-colors-alpha-06", value: "rgba(46, 53, 64, 0.06)" },
    { name: "--cf-colors-alpha-10", value: "rgba(54, 63, 74, 0.1)" },
    { name: "--cf-colors-alpha-20", value: "rgba(79, 89, 103, 0.15)" },
  ],
};

const typography: TokenGroup = {
  title: "Typography",
  tokens: [
    // Font Family
    {
      name: "--cf-font-family-sans",
      value:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    },
    {
      name: "--cf-font-family-mono",
      value: 'Consolas, Monaco, "Andale Mono", "Ubuntu Mono", monospace',
    },
    // Font Size
    { name: "--cf-font-size-xs", value: "0.75rem" },
    { name: "--cf-font-size-sm", value: "0.875rem" },
    { name: "--cf-font-size-base", value: "1rem" },
    { name: "--cf-font-size-lg", value: "1.125rem" },
    { name: "--cf-font-size-xl", value: "1.25rem" },
    { name: "--cf-font-size-2xl", value: "1.5rem" },
    { name: "--cf-font-size-3xl", value: "1.875rem" },
    { name: "--cf-font-size-4xl", value: "2.25rem" },
    // Font Weight
    { name: "--cf-font-weight-light", value: "300" },
    { name: "--cf-font-weight-normal", value: "400" },
    { name: "--cf-font-weight-medium", value: "500" },
    { name: "--cf-font-weight-semibold", value: "600" },
    { name: "--cf-font-weight-bold", value: "700" },
    // Line Height
    { name: "--cf-line-height-none", value: "1" },
    { name: "--cf-line-height-tight", value: "1.25" },
    { name: "--cf-line-height-snug", value: "1.375" },
    { name: "--cf-line-height-normal", value: "1.5" },
    { name: "--cf-line-height-relaxed", value: "1.625" },
    { name: "--cf-line-height-loose", value: "2" },
    // Typography Roles
    { name: "--cf-font-caption-size", value: "0.75rem" },
    { name: "--cf-font-caption-line-height", value: "1rem" },
    { name: "--cf-font-caption-weight", value: "500" },
    { name: "--cf-font-caption-letter-spacing", value: "0" },
    { name: "--cf-font-body-compact-size", value: "0.8125rem" },
    { name: "--cf-font-body-compact-line-height", value: "1.25rem" },
    { name: "--cf-font-body-compact-weight", value: "500" },
    { name: "--cf-font-body-compact-letter-spacing", value: "0" },
    { name: "--cf-font-body-size", value: "0.875rem" },
    { name: "--cf-font-body-line-height", value: "1.25rem" },
    { name: "--cf-font-body-weight", value: "400" },
    { name: "--cf-font-body-letter-spacing", value: "0" },
    { name: "--cf-font-body-large-size", value: "1rem" },
    { name: "--cf-font-body-large-line-height", value: "1.5rem" },
    { name: "--cf-font-body-large-weight", value: "400" },
    { name: "--cf-font-body-large-letter-spacing", value: "0" },
    { name: "--cf-font-heading-sm-size", value: "1.125rem" },
    { name: "--cf-font-heading-sm-line-height", value: "1.5rem" },
    { name: "--cf-font-heading-sm-weight", value: "600" },
    { name: "--cf-font-heading-sm-letter-spacing", value: "0" },
    { name: "--cf-font-heading-md-size", value: "1.25rem" },
    { name: "--cf-font-heading-md-line-height", value: "1.75rem" },
    { name: "--cf-font-heading-md-weight", value: "600" },
    { name: "--cf-font-heading-md-letter-spacing", value: "0" },
    { name: "--cf-font-heading-lg-size", value: "1.5rem" },
    { name: "--cf-font-heading-lg-line-height", value: "2rem" },
    { name: "--cf-font-heading-lg-weight", value: "600" },
    { name: "--cf-font-heading-lg-letter-spacing", value: "-0.025em" },
  ],
};

const spacing: TokenGroup = {
  title: "Spacing",
  tokens: [
    { name: "--cf-spacing-0", value: "0" },
    { name: "--cf-spacing-1", value: "0.25rem" },
    { name: "--cf-spacing-2", value: "0.5rem" },
    { name: "--cf-spacing-3", value: "0.75rem" },
    { name: "--cf-spacing-4", value: "1rem" },
    { name: "--cf-spacing-5", value: "1.25rem" },
    { name: "--cf-spacing-6", value: "1.5rem" },
    { name: "--cf-spacing-8", value: "2rem" },
    { name: "--cf-spacing-10", value: "2.5rem" },
    { name: "--cf-spacing-12", value: "3rem" },
    { name: "--cf-spacing-16", value: "4rem" },
    { name: "--cf-spacing-20", value: "5rem" },
    { name: "--cf-spacing-24", value: "6rem" },
  ],
};

const borderRadius: TokenGroup = {
  title: "Border Radius",
  tokens: [
    { name: "--cf-border-radius-none", value: "0" },
    { name: "--cf-border-radius-sm", value: "0.125rem" },
    { name: "--cf-border-radius-base", value: "0.25rem" },
    { name: "--cf-border-radius-md", value: "0.375rem" },
    { name: "--cf-border-radius-lg", value: "0.5rem" },
    { name: "--cf-border-radius-xl", value: "0.75rem" },
    { name: "--cf-border-radius-2xl", value: "1rem" },
    { name: "--cf-border-radius-3xl", value: "1.5rem" },
    { name: "--cf-border-radius-full", value: "9999px" },
  ],
};

const sizing: TokenGroup = {
  title: "Coordinated Sizing",
  tokens: [
    // XS
    { name: "--cf-size-xs-height", value: "16px" },
    { name: "--cf-size-xs-radius", value: "4px" },
    { name: "--cf-size-xs-icon-lg", value: "12px" },
    { name: "--cf-size-xs-icon-md", value: "8px" },
    { name: "--cf-size-xs-icon-sm", value: "6px" },
    { name: "--cf-size-xs-spacing", value: "2px" },
    { name: "--cf-size-xs-padding-h", value: "4px" },
    { name: "--cf-size-xs-padding-v", value: "2px" },
    { name: "--cf-size-xs-font-size", value: "9px" },
    { name: "--cf-size-xs-line-height", value: "12px" },
    // SM
    { name: "--cf-size-sm-height", value: "24px" },
    { name: "--cf-size-sm-radius", value: "5px" },
    { name: "--cf-size-sm-icon-lg", value: "16px" },
    { name: "--cf-size-sm-icon-md", value: "12px" },
    { name: "--cf-size-sm-icon-sm", value: "10px" },
    { name: "--cf-size-sm-spacing", value: "4px" },
    { name: "--cf-size-sm-padding-h", value: "6px" },
    { name: "--cf-size-sm-padding-v", value: "4px" },
    { name: "--cf-size-sm-font-size", value: "11px" },
    { name: "--cf-size-sm-line-height", value: "16px" },
    // MD
    { name: "--cf-size-md-height", value: "32px" },
    { name: "--cf-size-md-radius", value: "8px" },
    { name: "--cf-size-md-icon-lg", value: "20px" },
    { name: "--cf-size-md-icon-md", value: "16px" },
    { name: "--cf-size-md-icon-sm", value: "12px" },
    { name: "--cf-size-md-spacing", value: "8px" },
    { name: "--cf-size-md-padding-h", value: "8px" },
    { name: "--cf-size-md-padding-v", value: "8px" },
    { name: "--cf-size-md-font-size", value: "12px" },
    { name: "--cf-size-md-line-height", value: "16px" },
    // LG
    { name: "--cf-size-lg-height", value: "40px" },
    { name: "--cf-size-lg-radius", value: "9px" },
    { name: "--cf-size-lg-icon-lg", value: "24px" },
    { name: "--cf-size-lg-icon-md", value: "20px" },
    { name: "--cf-size-lg-icon-sm", value: "16px" },
    { name: "--cf-size-lg-spacing", value: "12px" },
    { name: "--cf-size-lg-padding-h", value: "12px" },
    { name: "--cf-size-lg-padding-v", value: "8px" },
    { name: "--cf-size-lg-font-size", value: "16px" },
    { name: "--cf-size-lg-line-height", value: "20px" },
    // XL
    { name: "--cf-size-xl-height", value: "48px" },
    { name: "--cf-size-xl-radius", value: "10px" },
    { name: "--cf-size-xl-icon-lg", value: "28px" },
    { name: "--cf-size-xl-icon-md", value: "24px" },
    { name: "--cf-size-xl-icon-sm", value: "20px" },
    { name: "--cf-size-xl-spacing", value: "16px" },
    { name: "--cf-size-xl-padding-h", value: "16px" },
    { name: "--cf-size-xl-padding-v", value: "12px" },
    { name: "--cf-size-xl-font-size", value: "18px" },
    { name: "--cf-size-xl-line-height", value: "24px" },
  ],
};

const shadows: TokenGroup = {
  title: "Shadows",
  tokens: [
    { name: "--cf-shadow-sm", value: "0 1px 2px 0 rgba(0,0,0,0.05)" },
    {
      name: "--cf-shadow-base",
      value: "0 1px 3px 0 rgba(0,0,0,0.1), 0 1px 2px 0 rgba(0,0,0,0.06)",
    },
    {
      name: "--cf-shadow-md",
      value: "0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06)",
    },
    {
      name: "--cf-shadow-lg",
      value:
        "0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05)",
    },
    {
      name: "--cf-shadow-xl",
      value:
        "0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)",
    },
    { name: "--cf-shadow-none", value: "none" },
  ],
};

const transitions: TokenGroup = {
  title: "Transitions",
  tokens: [
    { name: "--cf-transition-duration-fast", value: "150ms" },
    { name: "--cf-transition-duration-base", value: "200ms" },
    { name: "--cf-transition-duration-slow", value: "300ms" },
    {
      name: "--cf-transition-timing-ease",
      value: "cubic-bezier(0.4, 0, 0.2, 1)",
    },
    {
      name: "--cf-transition-timing-ease-in",
      value: "cubic-bezier(0.4, 0, 1, 1)",
    },
    {
      name: "--cf-transition-timing-ease-out",
      value: "cubic-bezier(0, 0, 0.2, 1)",
    },
    {
      name: "--cf-transition-timing-ease-in-out",
      value: "cubic-bezier(0.4, 0, 0.2, 1)",
    },
  ],
};

const zIndex: TokenGroup = {
  title: "Z-Index",
  tokens: [
    { name: "--cf-z-index-0", value: "0" },
    { name: "--cf-z-index-10", value: "10" },
    { name: "--cf-z-index-20", value: "20" },
    { name: "--cf-z-index-30", value: "30" },
    { name: "--cf-z-index-40", value: "40" },
    { name: "--cf-z-index-50", value: "50" },
    { name: "--cf-z-index-100", value: "100" },
    { name: "--cf-z-index-1000", value: "1000" },
    { name: "--cf-z-layer-sticky", value: "10" },
    { name: "--cf-z-layer-fixed", value: "500" },
    { name: "--cf-z-layer-fab", value: "900" },
    { name: "--cf-z-layer-sheet", value: "950" },
    { name: "--cf-z-layer-overlay", value: "1000" },
    { name: "--cf-z-layer-toast", value: "1100" },
  ],
};

const backdrop: TokenGroup = {
  title: "Backdrop & Surfaces",
  tokens: [
    { name: "--cf-backdrop-blur-sm", value: "4px" },
    { name: "--cf-backdrop-blur-md", value: "8px" },
    { name: "--cf-backdrop-blur-lg", value: "16px" },
    { name: "--cf-backdrop-blur-xl", value: "24px" },
    { name: "--cf-surface-translucent", value: "rgba(255, 255, 255, 0.72)" },
    {
      name: "--cf-surface-translucent-strong",
      value: "rgba(255, 255, 255, 0.88)",
    },
    { name: "--cf-overlay-dim", value: "rgba(0, 0, 0, 0.4)" },
  ],
};

const allGroups: TokenGroup[] = [
  colors,
  typography,
  spacing,
  borderRadius,
  sizing,
  shadows,
  transitions,
  zIndex,
  backdrop,
];

function isColor(value: string): boolean {
  return value.startsWith("#") || value.startsWith("rgb");
}

function ColorSwatch({ value }: { value: string }) {
  return (
    <div
      style={{
        width: "24px",
        height: "24px",
        borderRadius: "4px",
        backgroundColor: value,
        border: "1px solid var(--cf-colors-gray-300, #d5d7dd)",
        flexShrink: "0",
      }}
    />
  );
}

function SpacingSwatch({ value }: { value: string }) {
  return (
    <div
      style={{
        height: "12px",
        width: value,
        backgroundColor: "var(--cf-colors-primary-400, #6b8ffa)",
        borderRadius: "2px",
        flexShrink: "0",
      }}
    />
  );
}

function RadiusSwatch({ value }: { value: string }) {
  return (
    <div
      style={{
        width: "32px",
        height: "32px",
        borderRadius: value,
        border: "2px solid var(--cf-colors-primary-500, #4979fa)",
        backgroundColor: "var(--cf-colors-primary-50, #eef2fe)",
        flexShrink: "0",
      }}
    />
  );
}

function ShadowSwatch({ value }: { value: string }) {
  return (
    <div
      style={{
        width: "48px",
        height: "32px",
        borderRadius: "6px",
        backgroundColor: "#ffffff",
        boxShadow: value,
        flexShrink: "0",
      }}
    />
  );
}

function TokenRow(
  { token, group }: { token: Token; group: string },
) {
  const showColorSwatch = group === "Colors" && isColor(token.value);
  const showSpacingSwatch = group === "Spacing" &&
    token.value !== "0";
  const showRadiusSwatch = group === "Border Radius";
  const showShadowSwatch = group === "Shadows" && token.value !== "none";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "6px 0",
        borderBottom: "1px solid var(--cf-colors-gray-200, #eceef1)",
      }}
    >
      {showColorSwatch ? <ColorSwatch value={token.value} /> : null}
      {showSpacingSwatch ? <SpacingSwatch value={token.value} /> : null}
      {showRadiusSwatch ? <RadiusSwatch value={token.value} /> : null}
      {showShadowSwatch ? <ShadowSwatch value={token.value} /> : null}
      <code
        style={{
          fontSize: "12px",
          fontFamily: "var(--cf-font-family-mono, monospace)",
          color: "var(--cf-colors-gray-700, #404349)",
          minWidth: "260px",
          flexShrink: "0",
        }}
      >
        {token.name}
      </code>
      <span
        style={{
          fontSize: "12px",
          color: "var(--cf-colors-gray-500, #94979e)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {token.value}
      </span>
    </div>
  );
}

function TokenSection({ group }: { group: TokenGroup }) {
  return (
    <section style={{ marginBottom: "32px" }}>
      <h2
        style={{
          fontSize: "18px",
          fontWeight: "600",
          color: "var(--cf-colors-gray-900, #16181d)",
          marginBottom: "12px",
          paddingBottom: "8px",
          borderBottom: "2px solid var(--cf-colors-primary-500, #4979fa)",
        }}
      >
        {group.title}
      </h2>
      <div>
        {group.tokens.map((token) => (
          <TokenRow token={token} group={group.title} />
        ))}
      </div>
    </section>
  );
}

export default pattern<StyleTokensStoryInput, StyleTokensStoryOutput>(() => {
  return {
    [NAME]: "Style Tokens",
    [UI]: (
      <div style={{ padding: "24px", maxWidth: "800px", overflow: "auto" }}>
        <h1
          style={{
            fontSize: "24px",
            fontWeight: "700",
            color: "var(--cf-colors-gray-900, #16181d)",
            marginBottom: "8px",
          }}
        >
          CF Design Tokens
        </h1>
        <p
          style={{
            fontSize: "14px",
            color: "var(--cf-colors-gray-500, #94979e)",
            marginBottom: "32px",
          }}
        >
          CSS custom properties from the Common Fabric theme system. Use{" "}
          <code
            style={{
              fontFamily: "var(--cf-font-family-mono, monospace)",
              backgroundColor: "var(--cf-colors-gray-100, #f2f3f6)",
              padding: "2px 6px",
              borderRadius: "4px",
              fontSize: "13px",
            }}
          >
            var(--cf-token-name)
          </code>{" "}
          in your styles.
        </p>
        {allGroups.map((group) => <TokenSection group={group} />)}
      </div>
    ),
    controls: <div />,
  };
});
