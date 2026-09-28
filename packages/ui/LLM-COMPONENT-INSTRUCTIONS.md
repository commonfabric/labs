# LLM Component Composition Guide

> **Where this fits:**
> [`docs/common/components/COMPONENTS.md`](../../docs/common/components/COMPONENTS.md)
> is the agent-facing component index and usage narrative. This file remains the
> HTML-attribute-table reference. For live, type-checked usage see the catalog
> stories under `packages/patterns/catalog/stories/`.

This document provides comprehensive component specifications for Language
Models to assist with web component composition using the Common Fabric UI
library.

## Component Library Overview

The Common Fabric UI library provides a full set of secure web components that
follow the shadcn/ui design system. All components:

- Use custom element tags prefixed with `cf-`
- Support Shadow DOM encapsulation
- Emit custom events prefixed with `cf-`
- Follow strict security constraints (no external resources, limited events)

## Automation and Accessibility

Interactive `cf-*` components expose semantic roles and ARIA state through the
browser's flattened accessibility tree. Single-control components such as
`cf-button` anchor semantics on the custom-element host; composite components
use separately named native controls inside their shadow roots. Prefer role/name
lookups first:

```bash
agent-browser find role button click --name "Save"
agent-browser find role textbox fill "Ada" --name "Name"
```

Use visible text, `aria-label`, an associated label, or a placeholder to give
controls stable accessible names. Pierce selectors such as `[data-cf-input]`
remain available as a fallback for older components.

## Theme System First

When composing a polished UI with `cf-*` components, prefer `cf-theme` for
overall typography, color, spacing, radius, and motion, then use component
`--cf-*` custom properties only for local refinement.

Working references:

- `src/v2/components/cf-theme/cf-theme.ts`
- `src/v2/components/theme-context.ts`
- `../../docs/common/patterns/style.md`
- `../../docs/common/components/COMPONENTS.md`

## Component Reference

### 1. cf-button

**Purpose**: Interactive button element **Tag**: `<cf-button>` **Attributes**:

- `variant` - "default" | "destructive" | "outline" | "secondary" | "ghost" |
  "link"
- `size` - "default" | "sm" | "lg" | "icon"
- `disabled` - boolean
- `type` - "button" | "submit" | "reset" **Events**:
- `cf-click` - Fired on click with detail: `{ variant, size }` **Slots**:
  Default slot for button content **Example**:

```html
<cf-button variant="primary" size="lg">Click Me</cf-button>
```

**Accessibility/Automation**:

- Host role: `button`
- Host state: `aria-disabled`
- Accessible name: visible button text or `aria-label`
- Preferred locator:

```bash
agent-browser find role button click --name "Click Me"
```

### 2. cf-input

**Purpose**: Text input field **Tag**: `<cf-input>` **Attributes**:

- `type` - "text" | "email" | "password" | "number" | "search" | "tel" | "url" |
  "date" | "time" | "datetime-local"
- `placeholder` - string
- `value` - string
- `disabled` - boolean
- `readonly` - boolean
- `required` - boolean
- `name` - string
- `min` - string/number
- `max` - string/number
- `step` - string/number
- `pattern` - string
- `autocomplete` - string **Events**:
- `cf-input` - Fired on input with detail: `{ value, name }`
- `cf-change` - Fired on change with detail: `{ value, name }`
- `cf-focus` - Fired on focus
- `cf-blur` - Fired on blur **Example**:

```html
<cf-input type="email" placeholder="Enter email" required></cf-input>
```

**Accessibility/Automation**:

- Host role: `textbox` (text, email, password, search, tel, url), `spinbutton`
  (number), or unset (date, time, datetime-local)
- Host state: `aria-disabled`, `aria-readonly`, `aria-required`, `aria-invalid`
- Accessible name: associated label, `aria-label`, or placeholder
- Preferred locators:

```bash
agent-browser snapshot -i              # → textbox "Email" [ref=e3]
agent-browser type @e3 "user@example.com"
```

**`fill()` caveat:** Playwright's `fill()` does not work on `cf-input` or
`cf-textarea` hosts because they are custom elements, not native `<input>`
elements. Use `type @ref` in agent-browser, or `pressSequentially()` in
Playwright:

```bash
# use type with a ref — not bare type after click
agent-browser snapshot -i              # → textbox "Email" [ref=e3]
agent-browser type @e3 "user@example.com"
```

```typescript
// Playwright equivalent:
const input = page.getByRole("textbox", { name: "Email" });
await input.pressSequentially("user@example.com");
```

### 3. cf-textarea

**Purpose**: Multi-line text input **Tag**: `<cf-textarea>` **Attributes**:

- `placeholder` - string
- `value` - string
- `disabled` - boolean
- `readonly` - boolean
- `required` - boolean
- `name` - string
- `rows` - number
- `cols` - number
- `maxlength` - number
- `auto-resize` - boolean **Events**:
- `cf-input` - Fired on input with detail: `{ value, name }`
- `cf-change` - Fired on change with detail: `{ value, name }` **Example**:

```html
<cf-textarea rows="4" placeholder="Enter message" auto-resize></cf-textarea>
```

### 4. cf-checkbox

**Purpose**: Binary selection input **Tag**: `<cf-checkbox>` **Attributes**:

- `checked` - boolean
- `disabled` - boolean
- `name` - string
- `value` - string
- `required` - boolean
- `indeterminate` - boolean **Events**:
- `cf-change` - Fired on change with detail: `{ checked, indeterminate }`

**Example**:

```html
<cf-checkbox name="terms" checked>Accept terms</cf-checkbox>
```

### 5. cf-radio

**Purpose**: Single selection from group **Tag**: `<cf-radio>` **Attributes**:

- `checked` - boolean
- `disabled` - boolean
- `name` - string (required for grouping)
- `value` - string (required)
- `required` - boolean **Events**:
- `cf-change` - Fired on change with detail: `{ value, checked }` **Note**: Must
  be used within `cf-radio-group` for proper functionality **Example**:

```html
<cf-radio-group name="color" value="blue">
  <cf-radio value="red">Red</cf-radio>
  <cf-radio value="blue">Blue</cf-radio>
</cf-radio-group>
```

### 6. cf-radio-group

**Purpose**: Container for radio buttons **Tag**: `<cf-radio-group>`
**Attributes**:

- `name` - string (required)
- `value` - string (currently selected value)
- `disabled` - boolean **Events**:
- `cf-change` - Fired when selection changes with detail: `{ value }` **Slots**:
  Default slot for cf-radio elements

### 7. cf-switch

**Purpose**: Toggle switch **Tag**: `<cf-switch>` **Attributes**:

- `checked` - boolean
- `disabled` - boolean
- `name` - string **Events**:
- `cf-change` - Fired on toggle with detail: `{ checked }` **Example**:

```html
<cf-switch name="notifications" checked>Enable notifications</cf-switch>
```

### 8. cf-slider

**Purpose**: Range input slider **Tag**: `<cf-slider>` **Attributes**:

- `value` - number
- `min` - number (default: 0)
- `max` - number (default: 100)
- `step` - number (default: 1)
- `disabled` - boolean
- `name` - string **Events**:
- `cf-change` - Fired on value change with detail: `{ value }` **Example**:

```html
<cf-slider min="0" max="100" value="50" step="5"></cf-slider>
```

### 9. cf-toggle

**Purpose**: Toggle button **Tag**: `<cf-toggle>` **Attributes**:

- `pressed` - boolean
- `disabled` - boolean
- `variant` - "default" | "outline"
- `size` - "default" | "sm" | "lg"
- `value` - string (for toggle groups) **Events**:
- `cf-change` - Fired on toggle with detail: `{ pressed }` **Slots**: Default
  slot for content **Example**:

```html
<cf-toggle pressed>Bold</cf-toggle>
```

### 10. cf-toggle-group

**Purpose**: Group of toggle buttons **Tag**: `<cf-toggle-group>`
**Attributes**:

- `type` - "single" | "multiple"
- `value` - string (for single) | string[] (for multiple)
- `disabled` - boolean **Events**:
- `cf-change` - Fired on selection change with detail: `{ value }` **Slots**:
  Default slot for cf-toggle elements

### 11. cf-label

**Purpose**: Form field label **Tag**: `<cf-label>` **Attributes**:

- `for` - string (ID of associated input)
- `required` - boolean (shows asterisk)
- `disabled` - boolean **Events**:
- `cf-label-click` - Fired on click with detail: `{ targetId, targetElement }`

**Slots**: Default slot for label text **Example**:

```html
<cf-label for="email" required>Email Address</cf-label>
<cf-input id="email" type="email"></cf-input>
```

### 12. cf-card

**Purpose**: Content container **Tag**: `<cf-card>` **Attributes**: None
**Events**: None **Slots**:

- `header` - Card header content
- `content` - Main card content
- `footer` - Card footer content

**CSS custom properties**:

- `--cf-card-background` - Card background, default inherits from surface color.
  Accepts any CSS `background` value including gradients.
- `--cf-card-backdrop-blur` - Backdrop blur radius, default `0px`. Set to a blur
  value (e.g. `8px`) for a frosted-glass effect.

**Example**:

```html
<cf-card>
  <h3 slot="header">Card Title</h3>
  <p slot="content">Card content goes here</p>
  <cf-button slot="footer">Action</cf-button>
</cf-card>

<!-- Gradient tinted card -->
<cf-card
  style="--cf-card-background: linear-gradient(145deg, rgba(255, 255, 255, 0.52), #ece9ff); --cf-card-backdrop-blur: 8px"
>
  <p slot="content">Frosted glass card</p>
</cf-card>
```

### 13. cf-badge

**Purpose**: Status indicator or label **Tag**: `<cf-badge>` **Attributes**:

- `variant` - "default" | "secondary" | "destructive" | "outline"
- `removable` - boolean (shows X button) **Events**:
- `cf-remove` - Fired when X clicked (if removable) **Slots**: Default slot for
  badge text **Example**:

```html
<cf-badge variant="secondary" removable>Status</cf-badge>
```

### 13b. cf-chip

**Purpose**: Compact label / tag / action pill **Tag**: `<cf-chip>`
**Attributes**:

- `label` - string, display text
- `size` - "sm" | "md" | "lg" (default: "md")
- `removable` - boolean (shows X button)
- `interactive` - boolean (makes the label a primary action)

**Events**:

- `cf-remove` - Fired when X button clicked (if removable)
- `cf-click` - Fired when the primary action is activated (if interactive)

**Slots**:

- `icon` - Optional presentational icon before the label
- Default - Label content; when `interactive`, keep this content non-interactive
  because it is rendered inside the primary native button

**Accessibility/Automation**:

- An interactive chip exposes a named primary button
- A removable chip exposes a separate `Remove <label>` button
- A display-only chip has no button or tab stop

**CSS custom properties** (per-instance color overrides):

- `--cf-chip-background` - chip background color or gradient
- `--cf-chip-color` - chip text color
- `--cf-chip-border-color` - chip border color

**Example**:

```html
<!-- Basic chip -->
<cf-chip label="Draft"></cf-chip>

<!-- Size variants -->
<cf-chip label="Small" size="sm"></cf-chip>
<cf-chip label="Large" size="lg"></cf-chip>

<!-- Color override via CSS custom properties -->
<cf-chip
  label="Review"
  size="sm"
  style="--cf-chip-background: linear-gradient(135deg, #5f89ff, #4d77fb); --cf-chip-color: white"
></cf-chip>

<!-- Removable -->
<cf-chip label="Tag" removable></cf-chip>

<!-- Separate primary and destructive actions -->
<cf-chip label="Roadmap" interactive removable></cf-chip>
```

### 14. cf-alert

**Purpose**: Alert message display **Tag**: `<cf-alert>` **Attributes**:

- `status` - "info" | "error" | "warning" | "success"
- `dismissible` - boolean **Events**:
- `cf-dismiss` - Fired when dismissed **Slots**:
- `icon` - Alert icon
- `title` - Alert title
- `description` - Alert description
- Default slot - Alert content **Example**:

```html
<cf-alert status="error" dismissible>
  <span slot="icon">⚠️</span>
  <h4 slot="title">Error</h4>
  <p slot="description">Something went wrong</p>
</cf-alert>
```

### 15. cf-separator

**Purpose**: Visual divider **Tag**: `<cf-separator>` **Attributes**:

- `orientation` - "horizontal" | "vertical"
- `decorative` - boolean **Example**:

```html
<cf-separator orientation="vertical"></cf-separator>
```

### 16. cf-progress

**Purpose**: Progress indicator **Tag**: `<cf-progress>` **Attributes**:

- `value` - number (0-100)
- `max` - number (default: 100)
- `indeterminate` - boolean **Example**:

```html
<cf-progress value="60"></cf-progress>
```

### 17. cf-skeleton

**Purpose**: Loading placeholder **Tag**: `<cf-skeleton>` **Attributes**: None
(style with CSS width/height) **Example**:

```html
<cf-skeleton style="width: 200px; height: 20px"></cf-skeleton>
```

### 18. cf-accordion

**Purpose**: Collapsible content panels **Tag**: `<cf-accordion>`
**Attributes**:

- `type` - "single" | "multiple"
- `value` - string | string[] (open items)
- `collapsible` - boolean (for single type) **Events**:
- `cf-change` - Fired on expand/collapse with detail: `{ value }` **Slots**:
  Default slot for cf-accordion-item elements **Example**:

```html
<cf-accordion type="single" collapsible>
  <cf-accordion-item value="item1">
    <div slot="trigger">Section 1</div>
    <div slot="content">Content 1</div>
  </cf-accordion-item>
</cf-accordion>
```

### 19. cf-accordion-item

**Purpose**: Individual accordion panel **Tag**: `<cf-accordion-item>`
**Attributes**:

- `value` - string (required, unique identifier)
- `disabled` - boolean **Slots**:
- `trigger` - Clickable header
- `content` - Collapsible content

### 20. cf-collapsible

**Purpose**: Single collapsible section **Tag**: `<cf-collapsible>`
**Attributes**:

- `open` - boolean
- `disabled` - boolean **Events**:
- `cf-toggle` - Fired on open/close with detail: `{ open }` **Slots**:
- `trigger` - Clickable trigger element
- `content` - Collapsible content

### 21. cf-tabs

**Purpose**: Tabbed interface container **Tag**: `<cf-tabs>` **Attributes**:

- `default-value` - string (initially active tab)
- `orientation` - "horizontal" | "vertical" **Events**:
- `cf-change` - Fired on tab change with detail: `{ value }` **Slots**: Default
  slot for cf-tab-list and cf-tab-panel elements **Example**:

```html
<cf-tabs default-value="tab1">
  <cf-tab-list>
    <cf-tab value="tab1">Tab 1</cf-tab>
    <cf-tab value="tab2">Tab 2</cf-tab>
  </cf-tab-list>
  <cf-tab-panel value="tab1">Content 1</cf-tab-panel>
  <cf-tab-panel value="tab2">Content 2</cf-tab-panel>
</cf-tabs>
```

### 22. cf-tab-list

**Purpose**: Container for tab buttons **Tag**: `<cf-tab-list>` **Slots**:
Default slot for cf-tab elements

### 23. cf-tab

**Purpose**: Individual tab button **Tag**: `<cf-tab>` **Attributes**:

- `value` - string (required)
- `disabled` - boolean **Events**:
- `click` - Native click event

### 24. cf-tab-panel

**Purpose**: Tab content panel **Tag**: `<cf-tab-panel>` **Attributes**:

- `value` - string (required, matches tab value) **Slots**: Default slot for
  content

### 25. cf-scroll-area

**Purpose**: Custom scrollable area **Tag**: `<cf-scroll-area>` **Attributes**:

- `orientation` - "vertical" | "horizontal" | "both" **Slots**: Default slot for
  scrollable content **Example**:

```html
<cf-scroll-area style="height: 200px">
  <div>Long content...</div>
</cf-scroll-area>
```

### 26. cf-aspect-ratio

**Purpose**: Maintains aspect ratio of content **Tag**: `<cf-aspect-ratio>`
**Attributes**:

- `ratio` - string (e.g., "16/9", "1/1", "4/3") **Slots**: Default slot for
  content **Example**:

```html
<cf-aspect-ratio ratio="16/9">
  <div style="background: gray">Video placeholder</div>
</cf-aspect-ratio>
```

### 27. cf-form

**Purpose**: Form wrapper with validation **Tag**: `<cf-form>` **Attributes**:

- `action` - string
- `method` - string
- `novalidate` - boolean **Events**:
- `cf-submit` - Fired on valid submission with detail: `{ formData }`
- `cf-form-invalid` - Fired on validation failure with detail: `{ errors }`

**Slots**: Default slot for form elements **Methods**:

- `submit()` - Programmatically submit
- `reset()` - Reset form
- `validate()` - Validate and return boolean

### 28. cf-input-otp

**Purpose**: One-time password input **Tag**: `<cf-input-otp>` **Attributes**:

- `length` - number (default: 6)
- `value` - string
- `disabled` - boolean
- `name` - string **Events**:
- `cf-change` - Fired on value change with detail: `{ value, complete }`
- `cf-complete` - Fired when all digits entered with detail: `{ value }`

**Methods**:

- `focus()` - Focus first input
- `clear()` - Clear all inputs **Example**:

```html
<cf-input-otp length="6" name="otp"></cf-input-otp>
```

### 29. cf-resizable-panel-group

**Purpose**: Container for resizable panels **Tag**:
`<cf-resizable-panel-group>` **Attributes**:

- `direction` - "horizontal" | "vertical" **Events**:
- `cf-resize` - Fired on resize with detail: `{ panels }` **Slots**: Default
  slot for panels and handles

### 30. cf-resizable-panel

**Purpose**: Individual resizable panel **Tag**: `<cf-resizable-panel>`
**Attributes**:

- `default-size` - number (percentage)
- `min-size` - number (percentage)
- `max-size` - number (percentage)
- `collapsible` - boolean **Slots**: Default slot for content

### 31. cf-resizable-handle

**Purpose**: Drag handle between panels **Tag**: `<cf-resizable-handle>`
**Attributes**: None

## Layout Components

### 32. cf-hstack

**Purpose**: Horizontal flexbox container **Tag**: `<cf-hstack>` **Attributes**:

- `gap` - "0" | "1" | "2" | "3" | "4" | "5" | "6" | "8"
- `align` - "start" | "center" | "end" | "stretch" | "baseline"
- `justify` - "start" | "center" | "end" | "between" | "around" | "evenly"
- `wrap` - boolean
- `reverse` - boolean **Slots**: Default slot for child elements **Example**:

```html
<cf-hstack gap="4" align="center" justify="between">
  <cf-button>Left</cf-button>
  <cf-button>Right</cf-button>
</cf-hstack>
```

### 33. cf-vstack

**Purpose**: Vertical flexbox container **Tag**: `<cf-vstack>` **Attributes**:
Same as cf-hstack **Example**:

```html
<cf-vstack gap="2" align="stretch">
  <cf-card>Card 1</cf-card>
  <cf-card>Card 2</cf-card>
</cf-vstack>
```

### 34. cf-hgroup

**Purpose**: Horizontal group with semantic spacing **Tag**: `<cf-hgroup>`
**Attributes**:

- `gap` - "xs" | "sm" | "md" | "lg" | "xl" **Slots**: Default slot for grouped
  elements

### 35. cf-vgroup

**Purpose**: Vertical group with semantic spacing **Tag**: `<cf-vgroup>`
**Attributes**: Same as cf-hgroup

### 36. cf-hscroll

**Purpose**: Horizontal scroll container **Tag**: `<cf-hscroll>` **Attributes**:

- `fade-edges` - boolean (gradient fade on edges)
- `show-scrollbar` - boolean
- `snap` - boolean (scroll snapping) **Events**:
- `cf-scroll` - Fired on scroll with detail:
  `{ scrollLeft, scrollWidth, clientWidth }` **Methods**:
- `scrollToX(x, smooth)` - Scroll to position
- `scrollByX(x, smooth)` - Scroll by amount

### 37. cf-screen

**Purpose**: Full-height app layout with pinned header/footer and auto-scrolling
main area **Tag**: `<cf-screen>`

**Slots**:

- `header` — Fixed content at the top
- (default) — Main content area; stretches to fill height, scrolls automatically
  when content overflows
- `footer` — Fixed content at the bottom

**Usage notes**:

- Content in the default slot scrolls automatically — no need for `cf-vscroll`
  unless you need snap-to-bottom (chat), fade-edges, or styled scrollbar
- Do NOT nest `cf-screen` inside another `cf-screen`

**Example**:

```html
<cf-screen>
  <cf-heading slot="header" level="2">Title</cf-heading>
  <cf-vstack gap="4" padding="4">
    <!-- content scrolls if it overflows -->
  </cf-vstack>
  <cf-hstack slot="footer" gap="2" padding="4">
    <cf-button>Action</cf-button>
  </cf-hstack>
</cf-screen>
```

### 38. cf-vscroll

**Purpose**: Vertical scroll container **Tag**: `<cf-vscroll>` **Attributes**:

- `height` - string (CSS height)
- `fade-edges` - boolean
- `show-scrollbar` - boolean
- `snap` - boolean **Events**:
- `cf-scroll` - Fired on scroll with detail:
  `{ scrollTop, scrollHeight, clientHeight }` **Methods**:
- `scrollToY(y, smooth)` - Scroll to position
- `scrollByY(y, smooth)` - Scroll by amount

**Note**: `cf-vscroll` is only needed inside `cf-screen` when you need
snap-to-bottom, fade-edges, or styled scrollbar. `cf-screen` scrolls
automatically on its own.

### 39. cf-grid

**Purpose**: CSS Grid container **Tag**: `<cf-grid>` **Attributes**:

- `columns` - number | string (e.g., "3" or "repeat(auto-fit, minmax(200px,
  1fr))")
- `rows` - number | string
- `gap` - "0" | "1" | "2" | "3" | "4" | "5" | "6" | "8"
- `column-gap` - same as gap
- `row-gap` - same as gap
- `areas` - string (grid template areas)
- `auto-flow` - "row" | "column" | "dense" | "row dense" | "column dense"

**Example**:

```html
<cf-grid columns="3" gap="4">
  <div>Item 1</div>
  <div>Item 2</div>
  <div>Item 3</div>
</cf-grid>
```

### 40. cf-table

**Purpose**: Semantic HTML table **Tag**: `<cf-table>` **Attributes**:

- `striped` - boolean (zebra stripes)
- `bordered` - boolean
- `hover` - boolean (row hover effect)
- `compact` - boolean (reduced padding)
- `fixed` - boolean (fixed layout) **Slots**: Default slot for thead, tbody,
  tfoot **Example**:

```html
<cf-table striped hover>
  <thead>
    <tr>
      <th>Name</th>
      <th>Value</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Item 1</td>
      <td>100</td>
    </tr>
  </tbody>
</cf-table>
```

## Component Composition Guidelines

### Form Example

```html
<cf-form>
  <cf-vstack gap="4">
    <cf-vgroup gap="1">
      <cf-label for="name" required>Full Name</cf-label>
      <cf-input id="name" name="name" required></cf-input>
    </cf-vgroup>

    <cf-vgroup gap="1">
      <cf-label for="email" required>Email</cf-label>
      <cf-input id="email" name="email" type="email" required></cf-input>
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

### Dashboard Layout Example

```html
<cf-vstack gap="4" style="padding: 2rem">
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
      <!-- More stat cards... -->
    </cf-grid>
  </cf-card>

  <cf-tabs default-value="overview">
    <cf-tab-list>
      <cf-tab value="overview">Overview</cf-tab>
      <cf-tab value="analytics">Analytics</cf-tab>
      <cf-tab value="reports">Reports</cf-tab>
    </cf-tab-list>
    <cf-tab-panel value="overview">
      <!-- Overview content -->
    </cf-tab-panel>
  </cf-tabs>
</cf-vstack>
```

## Event Handling Patterns

All components emit custom events with the `cf-` prefix. Event details are
always in the `detail` property:

```javascript
document.querySelector("cf-button").addEventListener("cf-click", (e) => {
  console.log("Button clicked:", e.detail);
});

document.querySelector("cf-input").addEventListener("cf-change", (e) => {
  console.log("Input value:", e.detail.value);
});

document.querySelector("cf-form").addEventListener("cf-submit", (e) => {
  e.preventDefault();
  console.log("Form data:", e.detail.formData);
});
```

### cf-modal (Sheet Presentation)

**Purpose**: Modal dialog with optional bottom-sheet presentation **Tag**:
`<cf-modal>` **Attributes** (in addition to existing open, dismissable, size,
label):

- `presentation` - "dialog" | "sheet" (default: "dialog")
- `grabber` - boolean, decorative drag-handle indicator (sheet mode only)
- `detent` - "auto" | "half" | "full" (sheet max height, sheet mode only)

**Example**:

```html
<cf-modal open presentation="sheet" grabber detent="half" dismissable>
  <span slot="header">Options</span>
  <p>Sheet slides up from the bottom.</p>
</cf-modal>
```

### cf-tab-bar / cf-tab-bar-item

**Purpose**: Fixed-position app navigation bar (distinct from cf-tabs) **Tags**:
`<cf-tab-bar>`, `<cf-tab-bar-item>`

**cf-tab-bar Attributes**:

- `value` / `$value` - selected item value (Cell or string)
- `position` - "bottom" | "top" (default: "bottom")
- `variant` - "default" | "inset" (default: "default")

**cf-tab-bar-item Attributes**:

- `value` - unique identifier string
- `label` - text label below icon
- `disabled` - boolean

**Slots**:

- Default slot: `cf-tab-bar-item` elements
- `action` slot: optional primary action button (FAB)
- `icon` slot (on item): icon content above label

**Events**:

- `cf-change` - detail: `{ value, oldValue }`

**Example**:

```html
<cf-tab-bar value="home" variant="inset">
  <cf-tab-bar-item value="home" label="Home">
    <span slot="icon">🏠</span>
  </cf-tab-bar-item>
  <cf-tab-bar-item value="search" label="Search">
    <span slot="icon">🔍</span>
  </cf-tab-bar-item>
  <cf-button slot="action" variant="primary">＋</cf-button>
</cf-tab-bar>
```

### cf-toast / cf-toast-provider

**Purpose**: Floating ephemeral notification messages **Tags**:
`<cf-toast-provider>`, `<cf-toast>`

**cf-toast-provider Attributes**:

- `position` - "top" | "bottom" | "top-left" | "top-right" | "bottom-left" |
  "bottom-right" (default: "bottom")
- `max` - number, max visible toasts (default: 3)

**cf-toast Attributes**:

- `variant` - "default" | "success" | "error" | "warning"
- `duration` - number, auto-dismiss ms (default: 5000, 0 = persistent)
- `dismissable` - boolean, show X button
- `open` - boolean, visibility

**cf-toast Slots**: Default (message), `action`, `icon`

**Events**:

- `cf-toast-dismiss` - detail: `{ reason: "timeout" | "user" }`
- `cf-toast-action` - detail: `{}`

**Example**:

```html
<cf-toast-provider position="bottom">
  <cf-toast open variant="success" duration="4000">
    Changes saved.
    <button slot="action">View</button>
  </cf-toast>
</cf-toast-provider>
```

### cf-custody-seal

**Purpose**: The trusted host confirmation that seals the actor's draft into a
custody room's trusted-declassifier policy. The dialog is the host's, not the
pattern's: it shows what the runtime checked (room, readers, seats, policy
digest, the actor's sources) apart from what the room's terms say (question,
answers, and a leak bound conditional on the policy). **Tag**:
`<cf-custody-seal>`

**Bindings**:

- `$draft` - the value to seal
- `$terms` - the room's terms document
- `$policy` - a cell holding the room's custody policy reference
- `$sources` - the actor's source policy: a list of the actor's own `Context`
  and `Resource` atoms, in the actor's home space

**Events**:

- `cf-sealed` - no payload; fires when the seal commits. A binding that changes
  while a commit is in flight suppresses it, so read the room when you must
  know.

Only a trusted click on the dialog's **Seal & consent** seals; a scripted click
cannot. See `docs/common/components/COMPONENTS.md` and
`docs/specs/cfc-custody-seal.md`.

## Styling Components

Components expose CSS custom properties and parts for styling:

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

## Security Constraints

When composing components, remember:

- No `<img>`, `<svg>`, `<iframe>`, `<canvas>`, or `<a>` tags
- No external resource loading
- Use Unicode symbols for icons: ✓ ✕ → ← ↑ ↓ • ○ ▶ ▼ ▲
- All components use Shadow DOM for isolation
- Only allowed events are keyboard, mouse, focus, and form events
