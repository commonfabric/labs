/**
 * Figma ↔ Code mapping for cf-list-item
 *
 * Figma components: "project.item", "menu.item", "subtitle" (all in list.item page)
 * @see https://www.figma.com/design/LPebgX2vf5Axd6yuo4umBE/CF.design--WIP-?node-id=484:22605
 *
 * cf-list-item unifies three Figma list row variants into a single component
 * inspired by SwiftUI's List. The Figma page has:
 *   - project.item: checkbox + title + actions (star, expand) + expandable detail + action bar
 *   - menu.item: icon + label + optional description + keyboard shortcut
 *   - subtitle: title + chevron (simple navigation row)
 */
export const figmaMapping = {
  figmaUrl:
    "https://www.figma.com/design/LPebgX2vf5Axd6yuo4umBE/CF.design--WIP-?node-id=484:22605",
  element: "cf-list-item",

  // How each Figma variant maps to cf-list-item usage:
  variants: {
    "subtitle (simple row)": {
      example: `<cf-list-item label="Title"></cf-list-item>`,
    },
    "menu.item (command row)": {
      props: {
        label: { figmaProp: "Label", type: "string" },
        description: {
          figmaProp: "Description",
          note: "Shown when showDescription=true in Figma",
        },
        State: {
          codeProp: "disabled",
          values: { Disabled: true },
        },
      },
      example:
        `<cf-list-item label="New Project" description="Create a new project">
  <span slot="icon">📁</span>
  <cf-kbd slot="action">⌘N</cf-kbd>
</cf-list-item>`,
    },
    "project.item (expandable row)": {
      props: {
        title: { codeProp: "label", type: "string" },
        // NOTE: expanded requires expandable to also be set for the expansion
        // UI (chevron + detail slot) to render. Always pair them together.
        Expanded: {
          codeProp: "expanded",
          type: "boolean",
          staticProps: { expandable: true },
        },
        State: {
          codeProp: "disabled",
          values: { Disabled: true },
        },
      },
      example: `<cf-list-item label="Project Name" expandable>
  <cf-badge slot="action" color="primary" variant="solid">3 tasks</cf-badge>
  <div slot="detail">
    <cf-alert status="info">
      <span slot="icon">⏳</span>
      <span slot="title">Building UI · 29 tokens</span>
    </cf-alert>
  </div>
</cf-list-item>`,
    },
  },

  unmapped: [
    "project.item checkbox (leading selection) — could add a selectable prop",
    "project.item star/expand icon buttons — use action slot composition",
  ],

  // Sub-components used within list items
  relatedMappings: {
    "tag.action → cf-badge": "see cf-card/cf-card.figma.ts",
    "tag.category → cf-chip": "see cf-card/cf-card.figma.ts",
    "Action bar → cf-alert": "see cf-alert/cf-alert.figma.ts",
  },
};
