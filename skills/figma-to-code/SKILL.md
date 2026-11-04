---
name: figma-to-code
description: Translate a Figma design selection into cf-* Lit component code. Use when implementing a design from Figma, reviewing component alignment, or checking how Figma properties map to code. Triggers include "implement this design", "translate from Figma", "what cf- component matches this", or having a Figma node selected to implement.
---

# Figma → Code Translation

Translates Figma component selections into correct `cf-*` Lit HTML using the
documented mappings in `*.figma.ts` files.

## Workflow

### 1. Get the Figma component

Use the Figma MCP tools to inspect the selected or specified node:

```
mcp__figma-desktop__get_metadata  → structure, variant props, layer names
mcp__figma-desktop__get_screenshot → visual reference
```

Extract from the metadata:

- Component name (e.g. "button", "badge", "input")
- Variant properties and their current values (e.g. `Style=Primary`,
  `State=Disabled`)
- Child instances and slots
- Layer names that hint at content structure

### 2. Find matching cf-\* component

Search for a `.figma.ts` mapping file that matches the Figma component:

```
Glob: runtime/ui/src/v2/components/**/*.figma.ts
```

Read matching files to get the prop mapping. The `.figma.ts` files export a
`figmaMapping` object with this structure:

```typescript
export const figmaMapping = {
  figmaUrl: "https://www.figma.com/design/...",
  element: "cf-button",
  props: {
    // Figma prop name → code mapping
    "FigmaPropName": {
      codeProp: "code-attribute-name",
      values: { "FigmaValue": "code-value", ... },
    },
  },
  unmapped: ["FigmaFeature1", "FigmaFeature2"],
  example: `<cf-button variant="primary">Label</cf-button>`,
};
```

If no `.figma.ts` file exists, fall back to searching for a component whose name
matches the Figma component name:

```
Glob: runtime/ui/src/v2/components/cf-{name}/cf-{name}.ts
```

Read the component source to understand its props, variants, and slots.

### 3. Translate properties

For each Figma property on the selected node:

1. Look up the Figma prop name in the `.figma.ts` mapping
2. Map the Figma value to the code value
3. If the prop maps to `"slot"`, it becomes child content
4. If the prop maps to a boolean extracted from an enum (e.g. `State=Disabled` →
   `disabled`), render it as a boolean attribute
5. If unmapped, note it in a comment

### 4. Generate code

Output Lit HTML that a pattern developer can use directly:

```html
<cf-button variant="primary" disabled>Click me</cf-button>
```

For composite designs (multiple components), generate the full tree:

```html
<cf-vstack gap="md">
  <cf-heading level="2">Title</cf-heading>
  <cf-button variant="primary">Action</cf-button>
</cf-vstack>
```

### 5. Report gaps

After generating code, report:

- **Mapped**: Properties that translated cleanly
- **Unmapped**: Figma features with no code equivalent (potential enhancement
  opportunities)
- **Missing mapping file**: If no `.figma.ts` exists for a component that should
  have one, suggest creating it

## When no mapping file exists

If implementing a Figma component that has no `.figma.ts` file:

1. Read the component source to understand available props
2. Make best-effort mapping based on naming similarity
3. Flag uncertain mappings
4. Suggest creating a `.figma.ts` file with the discovered mapping

## Creating new mapping files

When asked to create a mapping for a component, use this template:

```typescript
/**
 * Figma ↔ Code mapping for cf-{name}
 *
 * Figma component: "{figma-name}"
 * @see {figma-url}
 */
export const figmaMapping = {
  figmaUrl: "{figma-url}",
  element: "cf-{name}",
  props: {
    // For each Figma property, document the code equivalent
    "FigmaPropName": {
      codeProp: "attribute-name",
      values: {
        "FigmaValue1": "code-value-1",
        "FigmaValue2": "code-value-2",
      },
    },
  },
  unmapped: [
    // Figma features not yet implemented in code
  ],
  example: `<cf-{name} prop="value">Content</cf-{name}>`,
};
```

Place the file at: `runtime/ui/src/v2/components/cf-{name}/cf-{name}.figma.ts`

## Key files

- Mapping files: `runtime/ui/src/v2/components/**/*.figma.ts`
- Component source: `runtime/ui/src/v2/components/cf-*/cf-*.ts`
- Component catalog: `patterns/dev/catalog/catalog.tsx`
- UI component docs: `docs/common/components/COMPONENTS.md`
