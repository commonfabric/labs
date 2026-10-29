# Debugging Workflow

## 5-Step Debugging Process

### 1. Check TypeScript Errors

```bash
deno task cf check pattern.tsx --no-run
```

Fix all type errors before deploying. Most issues are caught here.

### 2. Match Error to Doc

- **Type errors** - [@writeable](../../common/concepts/types-and-schemas/writable.md)
- **Reactivity issues** - [@reactivity](../../common/concepts/reactivity.md)
- **Component questions** - [@COMPONENTS](../../common/components/COMPONENTS.md)
- **Pattern examples** - [@index](../../../patterns/index.md)

### 3. Inspect Cell Values

Right-click a rendered piece and choose **Data** to see its live argument and
result values, or **Actions** to dispatch an event to one of its handler
streams. The menu (`cf-piece-menu`) comes with `cf-render`, so any host that
renders pieces has it; see
[COMPONENTS.md](../../common/components/COMPONENTS.md) under "The piece
context menu".

### 4. Inspect Deployed Piece

```bash
deno task cf piece inspect --identity key.json --api-url URL --space SPACE --cell ID
```

### 5. Simplify Until It Works

1. Comment out code until you have a minimal working pattern
2. Add back features one at a time
3. Test after each addition

## Quick Fixes

| Problem | Fix |
|---------|-----|
| Can't call `.set()` | Add `Writable<T>` to type signature |
| Filter not updating | Use `computed(() => items.filter(...))` |
| Checkbox not syncing | Use `$checked` not `checked` |
| Style not applying | Check element type (object vs string syntax) |
| LLM in handler | Move `generateText` to pattern body |
| UI blocking | Use `fetchJson` instead of `await` in handlers |

## 6. Check Runtime Logs and Stats

The runtime has structured loggers across all modules (`runner`, `runtime-client`,
etc.). Most are disabled by default to keep the console clean. Enabling them
produces tagged output in the browser console, which is useful for tracing what
the runtime is doing under the hood.

```javascript
// Shown inside a pattern body.
// Enable a logger and set it to debug level — this produces console output
commonfabric.logger["runner"].disabled = false
commonfabric.logger["runner"].level = "debug"

// Turn it back off when done to reduce noise
commonfabric.logger["runner"].disabled = true
```

Even when loggers are disabled, call counts and timing stats are still tracked.
You can inspect these without turning on console output:

```javascript
// Shown inside a pattern body.
// See which loggers exist and their call counts
commonfabric.getLoggerCountsBreakdown()

// Check timing stats (IPC latency, cell operations, etc.)
commonfabric.getTimingStatsBreakdown()

// Check for actions with invalid inputs (schema mismatches)
commonfabric.getLoggerFlagsBreakdown()
```

See [console-commands](./console-commands.md) for the full reference.

## See Also

- [Console Commands](./console-commands.md) - Browser console reference
- [Logger Internals](../../features/logger-internals.md) - Creating loggers in runtime code
- [cli-debugging](./cli-debugging.md) - CLI-based debugging and testing workflows
