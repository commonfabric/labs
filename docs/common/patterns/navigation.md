# Navigation to Detail Views

Use `navigateTo()` for drilling into detail views from list patterns.

`navigateTo()` changes the current shell view while preserving the current shell
mode. If a pattern is running under the shell embed route
`/.embed/<space-name-or-did>/<piece-id-or-slug>`, navigation to another piece
stays under `/.embed/...`. Pattern authors do not need to handle embedded
navigation specially.

[Common Fabric URLs](../../specs/fabric-urls.md) is a concept for a possible
future ordinary browser route and treats embed routes as higher-priority hosted
resources. No deployment is planned. The current embed behavior above remains
authoritative.

## List Pattern

```typescript
// Shown at module scope.
import { navigateTo, pattern, UI, Writable } from "commonfabric";
import ItemDetail from "./item-detail.tsx";

interface Item {
  name: string;
  status: string;
}

interface Input {
  items: Writable<Item[]>;
}

export default pattern<Input>(({ items }) => ({
  [UI]: (
    <cf-screen>
      {items.map((item) => (
        <cf-card>
          {item.name}
          <cf-button onClick={() => navigateTo(ItemDetail({ item }))}>
            Edit
          </cf-button>
        </cf-card>
      ))}
    </cf-screen>
  ),
  items,
}));
```

## Detail Pattern with `.key()`

The detail pattern receives a `Writable<Item>` and uses `.key()` to access individual fields for editing:

```typescript
import { pattern, UI, Writable } from "commonfabric";

interface Item {
  name: string;
  status: string;
}

interface Input {
  item: Writable<Item>;  // Single Writable of the whole object
}

export default pattern<Input>(({ item }) => ({
  [UI]: (
    <cf-screen>
      <cf-input $value={item.key("name")} placeholder="Name" />
      <cf-select
        $value={item.key("status")}
        items={[
          { label: "Active", value: "active" },
          { label: "Done", value: "done" },
        ]}
      />
    </cf-screen>
  ),
  item,
}));
```

**Why `.key()`?** When you need to edit fields of an object passed from a list:
- Use `Writable<Item>` (not separate Writables for each field)
- Use `.key("fieldName")` to get a Writable for that specific field
- The `.key()` result works directly with `$value` bindings
- Changes sync automatically back to the list

## Canonical Example

See `packages/patterns/reading-list/` for a complete implementation:
- `reading-list.tsx` - List with navigation to detail
- `reading-item-detail.tsx` - Detail view using `.key()` for field editing

## See Also

- [Writable Methods](../concepts/types-and-schemas/writable.md) - `.key()` and other methods
- [Two-Way Binding](./two-way-binding.md) - `$value` binding syntax
- [Conditional Rendering](./conditional.md) - Plain ternaries for show/hide
- [View Switching](./view-switching.md) - Switching between views inline (without navigation)
