/**
 * Figma ↔ Code mapping for cf-button
 *
 * Figma component: "button" (and themed variants: button.accent, button.brand, button.alert)
 * @see https://www.figma.com/design/LPebgX2vf5Axd6yuo4umBE/CF.design--WIP-?node-id=1248:18028
 */
export const figmaMapping = {
  figmaUrl:
    "https://www.figma.com/design/LPebgX2vf5Axd6yuo4umBE/CF.design--WIP-?node-id=1248:18028",
  element: "cf-button",

  // Figma prop name → code prop + value mapping
  props: {
    Style: {
      codeProps: ["color", "variant"],
      values: {
        Primary: { color: "primary", variant: "solid" },
        Secondary: { color: "neutral", variant: "outline" },
        Muted: { color: "neutral", variant: "ghost" },
      },
    },
    State: {
      codeProp: "disabled",
      values: {
        Disabled: true,
        // Default, Hover, Active, Focus are CSS states, not code props
      },
    },
    Label: {
      codeProp: "slot",
      type: "text",
    },
  },

  // Figma features not yet mapped to code
  unmapped: ["Split Button", "showIcon", "showArrow"],

  // Figma color themes → how to achieve in code
  themes: {
    "button": "default theme (no extra props needed)",
    "button.accent": 'color="accent" variant="solid"',
    "button.brand": "TODO: map to theme context or prop",
    "button.alert": 'color="danger" variant="solid"',
  },

  example: `<cf-button color="primary" variant="solid">Label</cf-button>
<cf-button color="neutral" variant="outline" disabled>Save</cf-button>
<cf-button variant="ghost">Cancel</cf-button>`,
};
