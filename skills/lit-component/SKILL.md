---
name: lit-component
description: Guide for developing Lit web components in the Common UI v2 system (@commonfabric/ui). Use when creating or modifying cf- prefixed components, implementing theme integration, working with Cell abstractions, or building reactive UI components that integrate with the Common Fabric runtime.
---

# Lit Component Development for Common UI

This skill provides guidance for developing Lit web components within the Common
UI v2 component library (`packages/ui/src/v2`).

## When to Use This Skill

Use this skill when:

- Creating new `cf-` prefixed components in the UI package
- Modifying existing Common UI v2 components
- Implementing theme-aware components
- Integrating components with Cell abstractions from the runtime
- Building reactive components for pattern UIs
- Debugging component lifecycle or reactivity issues

Do NOT use this skill when authoring or styling pattern UIs that consume `cf-`
components — that's `pattern-ui`'s job. Patterns must never touch component
internals, and pattern JSX uses `theme={...}`, not Lit's `.theme=${...}`.

## Core Philosophy

Common UI is inspired by SwiftUI and emphasizes:

1. **Default Configuration Works**: Components should work together with minimal
   configuration
2. **Composition Over Control**: Emphasize composing components rather than
   granular styling
3. **Adaptive to User Preferences**: Respect system preferences and theme
   settings (theme is ambient context, not explicit props)
4. **Reactive Binding Model**: Integration with FRP-style Cell abstractions from
   the runtime
5. **Progressive Enhancement**: Components work with plain values but enhance
   with Cells for reactivity
6. **Separation of Concerns**: Presentation components, theme-aware inputs,
   Cell-aware state, runtime-integrated operations

## Quick Start Pattern

### 1. Choose Component Category

Identify which category the component falls into:

- **Layout**: Arranges other components (vstack, hstack, screen)
- **Visual**: Displays styled content (separator, skeleton, label)
- **Input**: Captures user interaction (button, input, checkbox)
- **Complex/Integrated**: Deep runtime integration with Cells (render,
  code-editor, outliner)

**Complexity spectrum:** Components range from pure presentation (no runtime) to
deeply integrated (Cell operations, pattern execution, backlink resolution).
Choose the simplest pattern that meets requirements.

See `references/component-patterns.md` for detailed patterns for each category
and `references/advanced-patterns.md` for complex integration patterns.

### 2. Create Component Files

Create the component directory structure:

```
packages/ui/src/v2/components/cf-component-name/
├── cf-component-name.ts    # Component implementation
├── index.ts                # Export and registration
└── styles.ts               # Optional: for complex components
```

### 3. Implement Component

Basic template:

```typescript
import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

export class CFComponentName extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        box-sizing: border-box;
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }
    `,
  ];

  static override properties = {
    // Define reactive properties
  };

  constructor() {
    super();
    // Set defaults
  }

  override render() {
    return html`
      <!-- component template -->
    `;
  }
}

globalThis.customElements.define("cf-component-name", CFComponentName);
```

### 4. Create Index File

```typescript
import { CFComponentName } from "./cf-component-name.ts";

if (!customElements.get("cf-component-name")) {
  customElements.define("cf-component-name", CFComponentName);
}

export { CFComponentName };
export type {}; /* exported types */
```

Both registrations are the codebase convention, not a contradiction: the
component file registers unconditionally when it is imported, and the index
file's guarded define is a safe no-op in that case — it only registers when the
component module didn't (and prevents duplicate-registration errors during hot
module replacement). Keep both.

### Never setAttribute in the constructor

The custom-element spec forbids setting attributes during construction — the
browser throws
`Failed to execute 'createElement' on 'Document': The result
must not have attributes`
and the component silently fails to render. Set host attributes (`role`,
`exportparts`, ARIA defaults) in `connectedCallback` instead, which is what the
existing components do: `cf-tabs`, `cf-progress`, `cf-tab-list` and their
siblings call `super.connectedCallback()` and then assign. Lit schedules the
first update asynchronously, so attributes set immediately after the `super`
call are still in place before rendering — only impose a specific ordering where
a component actually needs one. A unit test that depends on these attributes has
to connect the element (append it, or call `connectedCallback` directly in a
narrow harness); `updated()` is a post-update hook and does not run the
connection lifecycle.

## Theme Integration

Components use `var(--cf-theme-*)` CSS variables with fallbacks (`--cf-theme-*`
first, then `--cf-*` base token, then a literal), and inherit their values from
the `cf-theme` or host page above them. Only `cf-theme` writes tokens for the
ambient theme; any other component writes none on its own host for it. Consume
`cfThemeContext` only when JavaScript needs the theme object for runtime logic
or derived values, and carry the tokens onto an overlay mounted outside the
subtree with `copyThemeProperties`.

**Theme consumption code and complete reference:** See
`references/theme-system.md` for all available CSS variables and helper
functions, and `references/component-patterns.md` for the `@consume` example.

## Cell Integration

For components that work with reactive runtime data, declare the cell as
`@property({ attribute: false })`, subscribe with
`cell.sink(() =>
this.requestUpdate())` when the `cell` property changes, and
read with `cell.get()` in `render()` (guarding the no-cell case). The pitfalls
that matter:

- Clean up the previous subscription before subscribing to a new cell, and
  unsubscribe in `disconnectedCallback()` (memory leaks)
- Check `isCell(this.cell)` before subscribing
- Mutate cells through transactions, never directly

**Subscription boilerplate and complete Cell patterns:** See
`references/cell-integration.md` for subscription management, nested property
access with `.key()`, array cell manipulation, transaction-based mutations, and
finding cells by equality.

## Reactive Controllers

For reusable component behaviors, use reactive controllers. Example:
`InputTimingController` for debouncing/throttling:

```typescript
import { InputTimingController } from "../../core/input-timing-controller.ts";

export class CFInput extends BaseElement {
  @property()
  timingStrategy: "immediate" | "debounce" | "throttle" | "blur" = "debounce";

  @property()
  timingDelay: number = 500;

  private inputTiming = new InputTimingController(this, {
    strategy: this.timingStrategy,
    delay: this.timingDelay,
  });

  private handleInput(event: Event) {
    const value = (event.target as HTMLInputElement).value;

    this.inputTiming.schedule(() => {
      this.emit("cf-change", { value });
    });
  }
}
```

## Common Patterns

### Event Emission

Use the `emit()` helper from `BaseElement`:

```typescript
private handleChange(newValue: string) {
  this.emit("cf-change", { value: newValue });
}
```

Events are automatically `bubbles: true` and `composed: true`.

### Dynamic Classes

Use `classMap` for conditional classes:

```typescript
import { classMap } from "lit/directives/class-map.js";

const classes = {
  button: true,
  [this.variant]: true,
  disabled: this.disabled,
};

return html`
  <button class="${classMap(classes)}">...</button>
`;
```

### List Rendering

Use `repeat` directive with stable keys:

```typescript
import { repeat } from "lit/directives/repeat.js";

return html`
  ${repeat(
    items,
    (item) => item.id, // stable key
    (item) =>
      html`
        <div>${item.title}</div>
      `,
  )}
`;
```

## Testing

Colocate tests with components:

```typescript
// cf-button.test.ts
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFButton } from "./cf-button.ts";

describe("CFButton", () => {
  it("should be defined", () => {
    expect(CFButton).toBeDefined();
  });

  it("should have default properties", () => {
    const element = new CFButton();
    expect(element.variant).toBe("primary");
  });
});
```

Run with: `deno task test` (includes required flags)

## Package Structure

Each component is declared in its own directory under
`packages/ui/src/v2/components/`. `packages/ui/src/v2/index.ts` re-exports every
component, and the package root re-exports that in turn, so consumers import
them from `@commonfabric/ui`:

```typescript
// packages/ui/src/v2/index.ts
export * from "./components/cf-button/index.ts";
```

## Reference Documentation

Load these references as needed for detailed guidance:

- **`references/component-patterns.md`** - Detailed patterns for each component
  category, file structure, type safety, styling conventions, event handling,
  and lifecycle methods
- **`references/theme-system.md`** - Theme philosophy, `cf-theme` provider,
  CFTheme interface, CSS variables, and theming patterns
- **`references/cell-integration.md`** - Comprehensive Cell integration patterns
  including subscriptions, mutations, array handling, and common pitfalls
- **`references/advanced-patterns.md`** - Advanced architectural patterns
  revealed by complex components: context provision, third-party integration,
  reactive controllers, path-based operations, diff-based rendering, and
  progressive enhancement

## Key Conventions

1. **Always extend `BaseElement`** - Provides `emit()` helper and base CSS
   variables
2. **Include box-sizing reset** - Ensures consistent layout behavior
3. **Use `attribute: false`** for objects/arrays/Cells - Prevents serialization
   errors
4. **Prefix custom events with `cf-`** - Namespace convention
5. **Export types separately** - Use `export type { ... }`
6. **Clean up subscriptions** - Always unsubscribe in `disconnectedCallback()`
7. **Use transactions for Cell mutations** - Never mutate cells directly
8. **Provide CSS variable fallbacks** - Components should work without theme
   context
9. **Document with JSDoc** - Include `@element`, `@attr`, `@fires`, `@example`
10. **Run tests with `deno task test`** - Not plain `deno test`

## Common Pitfalls to Avoid

- ❌ Forgetting to clean up Cell subscriptions (causes memory leaks)
- ❌ Mutating Cells without transactions (breaks reactivity)
- ❌ Using array index as key in `repeat()` (breaks reactivity)
- ❌ Missing box-sizing reset (causes layout issues)
- ❌ Not providing CSS variable fallbacks (breaks without theme)
- ❌ Using `attribute: true` for objects/arrays (serialization errors)
- ❌ Skipping `super` calls in lifecycle methods (breaks base functionality)

## Architecture Patterns to Study

Study these components to understand architectural patterns:

**Basic patterns:**

- **Simple visual:** `cf-separator` - Minimal component, CSS parts, ARIA
- **Layout:** `cf-vstack` - Flexbox abstraction, utility classes with `classMap`
- **Themed input:** `cf-button` - Theme consumption, event emission, variants

**Advanced patterns:**

- **Context provider:** `cf-theme` - Ambient configuration with `@provide`,
  `display: contents`, reactive Cell subscriptions
- **Runtime rendering:** `cf-render` - Pattern loading, UI extraction, lifecycle
  management
- **Third-party integration:** `cf-code-editor` - CodeMirror lifecycle,
  Compartments, bidirectional sync, CellController
- **Legacy tree editor patterns:** historical outliner implementation -
  Path-based operations, diff-based rendering, keyboard commands,
  MentionController

Each component reveals deeper patterns - study them not just for API but for
architectural principles.
