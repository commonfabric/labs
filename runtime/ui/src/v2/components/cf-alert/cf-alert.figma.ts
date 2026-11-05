/**
 * Figma ↔ Code mapping for cf-alert
 *
 * Figma component: "Action bar" (inside list.item page)
 * @see https://www.figma.com/design/LPebgX2vf5Axd6yuo4umBE/CF.design--WIP-?node-id=1060:11119
 */
export const figmaMapping = {
  figmaUrl:
    "https://www.figma.com/design/LPebgX2vf5Axd6yuo4umBE/CF.design--WIP-?node-id=1060:11119",
  element: "cf-alert",

  props: {
    State: {
      codeProp: "status",
      values: {
        Queue: "info",
        Progress: "info",
        Link: "info",
        Login: "warning",
        Review: "warning",
        Alert: "error",
      },
    },
  },

  // Figma Action bar is a compact inline alert with an action button.
  // cf-alert is currently block-level. Consider adding a compact/inline
  // variant or size="sm" to better match the Figma Action bar form factor.
  gaps: [
    "Compact/inline size — Figma action bar is 32px tall, cf-alert is block-level with 1rem padding",
    "Inline action button — Figma has a trailing button (View, Open link, Login, etc.); cf-alert has no action slot",
  ],

  slots: {
    Icon: 'slot="icon" — status icon on the left',
    "Text frame": 'default slot or slot="title" — status message',
    button: "no action slot yet — Figma has a trailing action button",
  },

  example: `<cf-alert status="info">
  <span slot="icon">⏳</span>
  <span slot="title">Wish is now in queue</span>
  <span slot="description">dispatched</span>
</cf-alert>`,
};
