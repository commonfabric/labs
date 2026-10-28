# Component Development Patterns

This document covers standard patterns and conventions for developing Lit
components in Common UI.

## Component Categories

Common UI components fall into distinct categories, each with specific patterns:

### 1. Layout Components

Components that arrange other components without providing content themselves.

**Examples:** `cf-vstack`, `cf-hstack`, `cf-screen`, `cf-autolayout`

**Characteristics:**

- Use flexbox or grid
- Accept child elements via slots
- Provide gap, alignment, and spacing controls
- No theme color consumption (mostly)
- Simple property-based configuration

**Pattern:**

```typescript
export class CFVStack extends BaseElement {
  static override properties = {
    gap: { type: String },
    align: { type: String },
    justify: { type: String },
  };

  declare gap: string;
  declare align: string;
  declare justify: string;

  override render() {
    const classes = {
      stack: true,
      [`gap-${this.gap}`]: true,
      [`align-${this.align}`]: true,
      [`justify-${this.justify}`]: true,
    };

    return html`
      <div class="${classMap(classes)}" part="stack">
        <slot></slot>
      </div>
    `;
  }
}
```

### 2. Visual Components

Components that display content with styling.

**Examples:** `cf-label`, `cf-separator`, `cf-skeleton`

**Characteristics:**

- May consume theme
- Provide visual feedback or decoration
- Usually simple with few properties

**Pattern:**

```typescript
export class CFSeparator extends BaseElement {
  static override properties = {
    orientation: { type: String },
    decorative: { type: Boolean },
  };

  declare orientation: "horizontal" | "vertical";
  declare decorative: boolean;

  override render() {
    return html`
      <div
        class="separator ${this.orientation}"
        part="separator"
        role="${this.decorative ? "none" : "separator"}"
      ></div>
    `;
  }
}
```

### 3. Input Components

Components that capture user input.

**Examples:** `cf-button`, `cf-input`, `cf-checkbox`, `cf-textarea`

**Characteristics:**

- Draw the ambient theme through `var(--cf-theme-*)` in their styles
- Emit custom events (use `this.emit()`)
- May use `InputTimingController` for debouncing
- Handle disabled states

**Pattern:**

```typescript
export class CFButton extends BaseElement {
  // Draws the ambient theme by inheritance: its styles read
  // `var(--cf-theme-*)`, and nothing is written on the host for it.
  /** A theme given to this element directly, written over the ambient one. */
  @property({ attribute: false })
  accessor theme: CFTheme | undefined = undefined;

  static override properties = {
    variant: { type: String },
    disabled: { type: Boolean, reflect: true },
  };

  override updated(changed: Map<string | number | symbol, unknown>) {
    super.updated(changed);
    if (changed.has("theme")) applyThemeToElement(this, this.theme);
  }

  private _handleClick(e: Event) {
    if (this.disabled) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Emit custom event
    this.emit("cf-click", {/* detail */});
  }
}
```

### 4. Complex/Integrated Components

Components that deeply integrate with the runtime and Cell abstractions.

**Examples:** `cf-render`, `cf-code-editor`, legacy tree editor implementations

**Characteristics:**

- Work with Cell properties
- Manage subscriptions
- Handle transactions for mutations
- Complex lifecycle management
- May use reactive controllers

**Pattern:** See `references/cell-integration.md` for detailed patterns.

## File Structure

Each component should follow this structure:

```
cf-component-name/
├── cf-component-name.ts    # Component implementation
├── index.ts                # Export and registration
└── styles.ts               # Optional: extracted styles (for complex components)
```

### Component Implementation File

```typescript
// cf-button.ts
import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

export type ButtonVariant = "primary" | "secondary" | "destructive";

export class CFButton extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      /* component styles */
    `,
  ];

  static override properties = {
    variant: { type: String },
  };

  declare variant: ButtonVariant;

  constructor() {
    super();
    this.variant = "primary";
  }

  override render() {
    return html`
      <button><slot></slot></button>
    `;
  }
}

globalThis.customElements.define("cf-button", CFButton);
```

### Index File

```typescript
// index.ts
import { ButtonVariant, CFButton } from "./cf-button.ts";

if (!customElements.get("cf-button")) {
  customElements.define("cf-button", CFButton);
}

export { CFButton };
export type { ButtonVariant };
```

Note: Both registrations are intentional. The component file registers
unconditionally on import (the dominant convention in
`packages/ui/src/v2/components/`); the index file's conditional check is then a
safe no-op, and prevents duplicate registration errors during hot module
replacement or alternate import paths. Keep both.

## Type Safety

### Export Types

Always export types separately:

```typescript
export type { ButtonSize, ButtonVariant };
```

### Property Type Declarations

Use `declare` for typed properties:

```typescript
static override properties = {
  variant: { type: String },
  size: { type: String },
  disabled: { type: Boolean, reflect: true },
};

declare variant: ButtonVariant;
declare size: ButtonSize;
declare disabled: boolean;
```

### Type Imports

Import types with `type` keyword when possible:

```typescript
import type { Cell } from "@commonfabric/runner";
import type { CFTheme } from "../theme-context.ts";
```

## Styling Conventions

### Base Styles

Always extend `BaseElement.baseStyles` for CSS variables:

```typescript
static override styles = [
  BaseElement.baseStyles,
  css`
    /* component styles */
  `,
];
```

### Box Sizing

Always include box-sizing reset:

```css
:host {
  display: block;
  box-sizing: border-box;
}

*,
*::before,
*::after {
  box-sizing: inherit;
}
```

### CSS Parts

Expose major elements as parts for external styling:

```typescript
return html`
  <button class="button" part="button">
    <slot></slot>
  </button>
`;
```

### Class Organization

Use `classMap` from `lit/directives/class-map.js` for dynamic classes:

```typescript
import { classMap } from "lit/directives/class-map.js";

const classes = {
  button: true,
  [this.variant]: true,
  [this.size]: true,
  disabled: this.disabled,
};

return html`
  <button class="${classMap(classes)}">...</button>
`;
```

## Event Handling

### Emitting Events

Use the `emit()` helper from `BaseElement`:

```typescript
protected emit<T = any>(
  eventName: string,
  detail?: T,
  options?: EventInit,
): boolean
```

Events are automatically `bubbles: true` and `composed: true`.

**Pattern:**

```typescript
private handleChange(newValue: string) {
  this.emit("cf-change", { value: newValue });
}
```

### Event Naming

- Prefix custom events with `cf-`
- Use present tense: `cf-change`, not `cf-changed`
- Be specific: `cf-add-item`, `cf-remove-item`

### Event Documentation

Document events in JSDoc:

```typescript
/**
 * @fires cf-change - Fired when value changes with detail: { value }
 * @fires cf-submit - Fired when form is submitted with detail: { formData }
 */
```

## Property Conventions

### Reflecting Properties

Use `reflect: true` for boolean states that should be visible in DOM:

```typescript
static override properties = {
  disabled: { type: Boolean, reflect: true },
  readonly: { type: Boolean, reflect: true },
};
```

### Default Values

Set defaults in constructor:

```typescript
constructor() {
  super();
  this.variant = "primary";
  this.size = "default";
  this.disabled = false;
}
```

### Non-Attribute Properties

Use `attribute: false` for objects, arrays, and Cells:

```typescript
static override properties = {
  theme: { type: Object, attribute: false },
  cell: { attribute: false },
  items: { type: Array, attribute: false },
};
```

## Lifecycle Methods

### Common Lifecycle Pattern

```typescript
override firstUpdated(changed: Map<string | number | symbol, unknown>) {
  super.firstUpdated(changed);
  // One-time setup
  this._updateThemeProperties();
  this._setupEventListeners();
}

override updated(changed: Map<string | number | symbol, unknown>) {
  super.updated(changed);
  // React to property changes
  if (changed.has("theme")) {
    this._updateThemeProperties();
  }
}

override disconnectedCallback() {
  super.disconnectedCallback();
  // Cleanup
  this._cleanup();
}
```

## Documentation

### JSDoc Comments

Provide comprehensive JSDoc:

```typescript
/**
 * CFButton - Interactive button element with multiple variants
 *
 * @element cf-button
 *
 * @attr {string} variant - Visual style: "primary" | "secondary" | "destructive"
 * @attr {string} size - Button size: "default" | "sm" | "lg" | "icon"
 * @attr {boolean} disabled - Whether the button is disabled
 *
 * @slot - Default slot for button content
 *
 * @fires cf-click - Fired when button is clicked
 *
 * @example
 * <cf-button variant="primary" size="lg">Click Me</cf-button>
 */
```

## Testing

Tests should be colocated with components:

```
cf-component/
├── cf-component.ts
├── cf-component.test.ts
└── index.ts
```

### Basic Test Structure

```typescript
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFButton } from "./cf-button.ts";

describe("CFButton", () => {
  it("should be defined", () => {
    expect(CFButton).toBeDefined();
  });

  it("should create element instance", () => {
    const element = new CFButton();
    expect(element).toBeInstanceOf(CFButton);
  });

  it("should have default properties", () => {
    const element = new CFButton();
    expect(element.variant).toBe("primary");
    expect(element.disabled).toBe(false);
  });
});
```

Run tests with: `deno task test` (NOT `deno test` - the task includes important
flags)
