# Common UI Web Components

A web component library fully compatible with Deno 2. This library provides
production-ready components designed for untrusted DOM contexts with strict
security constraints.

## 🚀 Features

- **The `cf-*` Component Set** - Production-ready implementation of a
  shadcn/ui-inspired component library
- **Security-First Design** - Built for sandboxed environments with strict
  isolation
- **Zero External Dependencies** - No remote resources, fully self-contained
- **TypeScript Support** - Full type definitions with Deno's native TypeScript
- **Framework Agnostic** - Works with React, Vue, Angular, or vanilla JavaScript
- **Accessibility Built-in** - WCAG 2.1 AA compliant components

## 📦 Library Structure

```
src/
├── index.ts         # Public package entrypoint
└── v2/              # cf-* component implementation
    ├── components/  # Component directories
    ├── core/        # Base element class
    ├── styles/      # Design tokens and shared styles
    └── utils/       # Utilities and helpers
```

TODO(ui-path-cleanup): Rename the `src/v2` path now that it is the only UI
component implementation.

## Cell-bound edits

`CellController` displays local edits immediately and uses
`CellHandle.setForUI()` to observe their commit outcomes. Input dispatch stays
responsive while persistence is pending. Subscription echoes, including a value
equal to the edit, cannot release that edit before commit. After commit, the
controller reads the current bound view and reconciles with that value or a
cache publication or worker confirmation received during the read. This also
picks up a handler clear that arrived before the acknowledgment, without waiting
for another delivery. The read adds one worker round trip per completed edit
that is still current. A same-cell rebind also reads the new view when the
control is idle. Until that read or a worker confirmation, the replacement
handle's initial cache cannot overwrite the last displayed value. Protection is
tied to that particular handle cache revision, so a later `sync()`, publication,
or equal-value worker delivery expires it. First bindings and ordinary
reconnects read the handle's current cache directly.

Write refusal is logged and releases the affected edit, notifying the component
to render the bound value. Completion of an older write does not release a newer
edit, including an edit awaiting blur or debounce. Custom setters supply no
commit promise to the controller and remain responsible for their own write
outcomes.

## 🎯 Quick Start

### Installation with Deno

```typescript
// Importing from the public package entrypoint registers all exported cf-* elements.
import { CFButton, CFCard, CFInput } from "@commonfabric/ui";

// Use a side-effect import when you only need the elements registered.
import "@commonfabric/ui";
```

`@commonfabric/ui` is the public package entrypoint. It re-exports the component
directory indexes, so importing it registers all exported `cf-*` elements.

Repository-local code can import a single component by using that component's
directory index:

```typescript
import { CFButton } from "./src/v2/components/cf-button/index.ts";
```

### Use in HTML

```html
<!-- cf-* components -->
<cf-button variant="primary">Click Me</cf-button>
<cf-input type="email" placeholder="Enter email"></cf-input>
<cf-card>
  <h3 slot="header">Card Title</h3>
  <p slot="content">Card content</p>
</cf-card>
```

## 🎨 Theme System

`cf-theme` provides subtree-level theme tokens for typography, colors, spacing,
border radius, and motion. Use it for overall visual direction, then refine
individual components with their documented `--cf-*` custom properties.

Useful references:

- `src/v2/components/cf-theme/cf-theme.ts`
- `src/v2/components/theme-context.ts`
- `../../docs/common/patterns/style.md`
- `../../docs/common/components/COMPONENTS.md`

## 📖 Components

### Forms And Inputs

| Element           | Element     | Element           | Element          |
| ----------------- | ----------- | ----------------- | ---------------- |
| `cf-autocomplete` | `cf-button` | `cf-calendar`     | `cf-checkbox`    |
| `cf-code-editor`  | `cf-field`  | `cf-form`         | `cf-input`       |
| `cf-input-otp`    | `cf-picker` | `cf-radio`        | `cf-radio-group` |
| `cf-select`       | `cf-slider` | `cf-switch`       | `cf-tags`        |
| `cf-textarea`     | `cf-toggle` | `cf-toggle-group` | `cf-voice-input` |

### Files And Media

| Element              | Element               | Element     | Element            |
| -------------------- | --------------------- | ----------- | ------------------ |
| `cf-attachments-bar` | `cf-audio-visualizer` | `cf-canvas` | `cf-file-download` |
| `cf-file-input`      | `cf-iframe`           | `cf-image`  | `cf-image-input`   |
| `cf-svg`             |                       |             |                    |

### Layout And Structure

| Element               | Element              | Element                    | Element         |
| --------------------- | -------------------- | -------------------------- | --------------- |
| `cf-accordion`        | `cf-accordion-item`  | `cf-aspect-ratio`          | `cf-autolayout` |
| `cf-card`             | `cf-collapsible`     | `cf-fragment`              | `cf-grid`       |
| `cf-hgroup`           | `cf-hscroll`         | `cf-hstack`                | `cf-list-item`  |
| `cf-resizable-handle` | `cf-resizable-panel` | `cf-resizable-panel-group` | `cf-screen`     |
| `cf-scroll-area`      | `cf-separator`       | `cf-table`                 | `cf-tile`       |
| `cf-vgroup`           | `cf-vscroll`         | `cf-vstack`                |                 |

### Display And Text

| Element      | Element    | Element    | Element          |
| ------------ | ---------- | ---------- | ---------------- |
| `cf-avatar`  | `cf-badge` | `cf-chip`  | `cf-copy-button` |
| `cf-heading` | `cf-kbd`   | `cf-label` | `cf-markdown`    |
| `cf-text`    | `cf-theme` |            |                  |

### Feedback And Overlays

| Element             | Element          | Element       | Element     |
| ------------------- | ---------------- | ------------- | ----------- |
| `cf-alert`          | `cf-empty-state` | `cf-fab`      | `cf-loader` |
| `cf-modal`          | `cf-progress`    | `cf-skeleton` | `cf-toast`  |
| `cf-toast-provider` |                  |               |             |

### Charts And Maps

| Element        | Element       | Element    | Element       |
| -------------- | ------------- | ---------- | ------------- |
| `cf-area-mark` | `cf-bar-mark` | `cf-chart` | `cf-dot-mark` |
| `cf-line-mark` | `cf-map`      |            |               |

### Messaging And AI

| Element           | Element           | Element            | Element            |
| ----------------- | ----------------- | ------------------ | ------------------ |
| `cf-chat`         | `cf-chat-message` | `cf-message-beads` | `cf-message-input` |
| `cf-prompt-input` | `cf-question`     | `cf-submit-input`  | `cf-tool-call`     |
| `cf-tools-chip`   |                   |                    |                    |

### Identity And Integrations

| Element             | Element            | Element            | Element      |
| ------------------- | ------------------ | ------------------ | ------------ |
| `cf-cfc-authorship` | `cf-cfc-label`     | `cf-google-oauth`  | `cf-oauth`   |
| `cf-plaid-link`     | `cf-profile-badge` | `cf-secret-viewer` | `cf-webhook` |

### Navigation And Routing

| Element             | Element         | Element           | Element       |
| ------------------- | --------------- | ----------------- | ------------- |
| `cf-chevron-button` | `cf-link`       | `cf-link-preview` | `cf-location` |
| `cf-router`         | `cf-space-link` | `cf-tab`          | `cf-tab-bar`  |
| `cf-tab-bar-item`   | `cf-tab-list`   | `cf-tab-panel`    | `cf-tabs`     |

### Runtime And Interaction

| Element        | Element        | Element          | Element         |
| -------------- | -------------- | ---------------- | --------------- |
| `cf-autostart` | `cf-cell-link` | `cf-drag-source` | `cf-draggable`  |
| `cf-drop-zone` | `cf-keybind`   | `cf-piece`       | `cf-piece-menu` |
| `cf-render`    | `cf-toolbar`   | `cf-updater`     |                 |

### Retired

Kept as inert passthroughs: they render their children and nothing else, warn
once per session when used, and are `@deprecated` so authoring flags them.
Durable pattern source still names them, and a piece runs the source it was
stored with — so deleting the definition strands that source rather than
retiring the element. They leave once nothing durable emits them. See
`src/v2/core/retired-element.ts`.

Replacements are named unbacktick'd on purpose: the registration test reads
every backticked `cf-*` in this section as a registered element, and a name
repeated here is a duplicate.

| Element           | Retired in | Use instead   |
| ----------------- | ---------- | ------------- |
| `cf-cell-context` | #5132      | cf-piece-menu |

## 🔒 Security Constraints

Components are designed for secure, sandboxed environments:

- **No Implicit Remote Fetching** - Media and SVG components render
  caller-provided data
- **DOM Isolation** - Components cannot access DOM outside their Shadow DOM
- **Limited Events** - Only keyboard, mouse, focus, and form events allowed
- **Controlled Navigation** - Navigation components expose explicit routing and
  link behavior
- **Visual Containment** - Components render within parent bounds

## 🤖 LLM Integration

This library includes `LLM-COMPONENT-INSTRUCTIONS.md`, a comprehensive guide for
Language Models (like Claude, GPT-4) to assist with component composition. The
guide includes:

- Complete component API reference
- Attribute types and event specifications
- Usage examples for `cf-*` components
- Security constraints and best practices
- Component composition patterns

When working with an LLM, reference this file to ensure accurate component
usage.

## 💻 Development

### Commands

```bash
# Type checking from the repository root
deno check packages/ui/src/index.ts

# Formatting from the repository root
deno fmt packages/ui

# Testing from packages/ui
deno task test
```

### Project Structure Details

```
packages/ui/
├── deno.jsonc                # Deno configuration
├── README.md                 # This file
├── LLM-COMPONENT-INSTRUCTIONS.md  # AI assistant guide
├── src/
│   ├── index.ts             # Main exports
│   └── v2/                  # cf-* component implementation
│       ├── components/      # cf-* components
│       ├── core/            # BaseElement class
│       ├── styles/          # Shared styles
│       ├── utils/           # Utilities
│       ├── types/           # TypeScript types
│       └── index.ts
```

### Component Registration

Each `cf-*` component directory owns registration in `index.ts`.

The component implementation file exports the class. The directory `index.ts`
imports the class, checks `customElements.get("<tag>")`, defines the tag when it
is missing, and exports the class plus an element type alias.

Use value imports from the directory `index.ts` when code relies on
registration. The package root imports every exported component index and
registers all exported `cf-*` elements at once. Use type-only imports for type
references.

## 📚 Examples

### Form with Validation

```html
<cf-form>
  <cf-vstack gap="4">
    <cf-vgroup gap="1">
      <cf-label for="email" required>Email</cf-label>
      <cf-input id="email" type="email" name="email" required></cf-input>
    </cf-vgroup>

    <cf-vgroup gap="1">
      <cf-label for="message">Message</cf-label>
      <cf-textarea id="message" name="message" rows="4"></cf-textarea>
    </cf-vgroup>

    <cf-hstack gap="3" justify="end">
      <cf-button variant="outline" type="reset">Cancel</cf-button>
      <cf-button type="submit">Submit</cf-button>
    </cf-hstack>
  </cf-vstack>
</cf-form>
```

### Dashboard Layout

```html
<cf-vstack gap="4">
  <cf-card>
    <h2 slot="header">Dashboard</h2>
    <cf-grid slot="content" columns="3" gap="4">
      <cf-card>
        <cf-vstack slot="content" gap="2">
          <cf-badge variant="secondary">Active</cf-badge>
          <h3>Total Users</h3>
          <p style="font-size: 2rem">1,234</p>
        </cf-vstack>
      </cf-card>
      <!-- More cards... -->
    </cf-grid>
  </cf-card>
</cf-vstack>
```

### Event Handling

```javascript
// cf-* events
document.querySelector("cf-button").addEventListener("cf-click", (e) => {
  console.log("Button clicked:", e.detail);
});

document.querySelector("cf-form").addEventListener("cf-submit", (e) => {
  e.preventDefault();
  console.log("Form data:", e.detail.formData);
});
```

## 🎨 Styling

Components support CSS custom properties and parts:

```css
/* Custom properties */
cf-button {
  --background: #3b82f6;
  --foreground: white;
}

/* CSS parts */
cf-input::part(input) {
  font-family: monospace;
}

cf-card::part(header) {
  background: #f3f4f6;
}
```

### TypeScript/JSX Support

For React/TypeScript projects, add type definitions:

```typescript
// types/jsx.d.ts
declare namespace JSX {
  interface IntrinsicElements {
    "cf-button": {
      variant?:
        | "default"
        | "destructive"
        | "outline"
        | "secondary"
        | "ghost"
        | "link";
      size?: "default" | "sm" | "lg" | "icon";
      disabled?: boolean;
    } & React.HTMLAttributes<HTMLElement>;
    // ... other components
  }
}
```

## 🤝 Contributing

1. Follow established patterns in `BaseElement`
2. Maintain security constraints
3. Include comprehensive JSDoc documentation
4. Add test files for new components
5. Update type definitions
6. Follow the style guide in existing components

## 📄 License

MIT License - see LICENSE file for details

## 🙏 Acknowledgments

- Design system based on [shadcn/ui](https://ui.shadcn.com/)
- Built with [Lit](https://lit.dev/) web components
- Optimized for [Deno](https://deno.land/) runtime
- Secured for sandboxed environments
