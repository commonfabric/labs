---
name: knowledge-base
description: Shared foundation for Oracle & Corrector agents. Establishes the source hierarchy for resolving conflicts between documentation, code, and specs. Load this skill first when investigating how the system works.
---

# Knowledge Base Foundation

## Before You Start

Read these docs to orient yourself:

1. **`docs/common/concepts/glossary.md`** - Terminology (Cell, Piece, Space,
   Spell, etc.)
2. **`docs/specs/pattern-construction/overview.md`** - Authoritative system
   design
3. **`AGENTS.md`** - Documentation reading list and codebase guidelines

## Source Hierarchy

When sources conflict, this is the authoritative order:

### 1. Specs (Highest Authority)

`docs/specs/` - Technical specifications with unambiguous intent

When specs contradict other docs, **specs win**.

### 2. Working Code

Tests and patterns that demonstrate actual behavior:

- `patterns/` - Pattern examples showing what works
- `**/test/**` - Test files proving expected behavior

These show reality, not aspirations.

### 3. Runtime Code

Core system implementation:

- `runtime/runner/` - Execution engine
- `runtime/runner/src/builder/` - Compilation
- `runtime/memory/` - Storage layer

Code is always right about what it does.

### 4. Plain Text Docs (Lowest Authority)

`docs/common/` - Guides, tutorials, learning materials

Good for learning, but may contain outdated or speculative information. Validate
against code when precision matters.

### Not evidence: `docs/history/`

`docs/history/` holds frozen point-in-time records (audits, executed plans,
superseded designs — see `docs/history/README.md`). They describe the system as
it was on their `created` date, not as it is. Use them for background and
provenance only, never as authority about current behavior, and never update
them.

## The Rule

**Concrete beats abstract. Specifications beat speculation. Code beats comments.
Tests beat documentation.**

## When Sources Conflict

1. Check specs first (`docs/specs/`)
2. Look at working code (tests, patterns)
3. Read runtime implementation
4. Use docs/common as learning guide only
5. If still unclear, surface the conflict explicitly
