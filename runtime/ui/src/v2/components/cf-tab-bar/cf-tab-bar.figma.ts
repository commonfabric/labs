/**
 * Figma ↔ Code mapping for cf-tab-bar and cf-tab-bar-item
 *
 * Figma components: "Tab Bar" (container) and "Tab Bar/_Button" (item)
 * @see https://www.figma.com/design/LPebgX2vf5Axd6yuo4umBE/CF.design--WIP-?node-id=1038:12086
 */
export const figmaMapping = {
  figmaUrl:
    "https://www.figma.com/design/LPebgX2vf5Axd6yuo4umBE/CF.design--WIP-?node-id=1038:12086",
  element: "cf-tab-bar",

  props: {
    Style: {
      codeProp: "variant",
      values: {
        "Liquid Glass": "inset",
        Default: "default",
      },
    },
    Mode: {
      codeProp: null,
      note:
        "Light/Dark mode is handled by cf-theme context, not a tab bar prop",
    },
  },

  // The separated 5th button pill in Figma maps to the action slot
  slots: {
    "Tab Bar Buttons": "default slot — cf-tab-bar-item children",
    Button: 'slot="action" — separate pill for primary action',
  },

  unmapped: [],

  // Sub-component mapping for the individual tab items
  items: {
    element: "cf-tab-bar-item",
    props: {
      // NOTE: Selection is controlled by the parent cf-tab-bar[value] prop,
      // not by a `selected` attribute on the item. cf-tab-bar sets `selected`
      // on the matching child automatically — never set it in markup directly.
      // To change the selected tab, update the `value` prop on cf-tab-bar.
      "Show Label": {
        codeProp: "hide-label",
        values: {
          true: false,
          false: true,
        },
        note: "Inverted: Figma 'Show Label: false' → code hide-label attribute",
      },
      symbol: {
        codeProp: 'slot="icon"',
        note:
          "Figma uses SF Symbol unicode glyphs; code uses an icon slot accepting any content",
      },
      Label: {
        codeProp: "label",
        type: "string",
      },
    },
  },

  example: `<!-- Liquid Glass (inset pill) style -->
<cf-tab-bar variant="inset" $value={activeTab}>
  <cf-tab-bar-item value="home" label="Home">
    <span slot="icon">🏠</span>
  </cf-tab-bar-item>
  <cf-tab-bar-item value="projects" label="Projects">
    <span slot="icon">📁</span>
  </cf-tab-bar-item>
  <cf-tab-bar-item value="wish" label="Wish">
    <span slot="icon">✨</span>
  </cf-tab-bar-item>
  <cf-tab-bar-item value="activity" label="Activity">
    <span slot="icon">🔔</span>
  </cf-tab-bar-item>
  <cf-button slot="action" variant="ghost" size="icon">+</cf-button>
</cf-tab-bar>

<!-- Default (full-width) style -->
<cf-tab-bar variant="default" $value={activeTab}>
  <cf-tab-bar-item value="home" label="Home">
    <span slot="icon">🏠</span>
  </cf-tab-bar-item>
</cf-tab-bar>`,
};
