#!/bin/bash
# Script to rename Cell<T> to Writable<T> in patterns
#
# This script:
# 1. Replaces Cell< with Writable< (type annotations only)
# 2. Adds Writable to commonfabric imports using perl for proper multi-line handling
#
# Preserves Cell.of(), Cell.equals(), Cell.for() method calls

set -e

PATTERNS_DIR="patterns"

echo "=== Step 1: Replacing Cell< with Writable< in type annotations ==="

files=$(find "$PATTERNS_DIR" -type f \( -name "*.ts" -o -name "*.tsx" \) | sort)

count1=0
for file in $files; do
    if grep -q 'Cell<' "$file"; then
        echo "Processing types: $file"
        # Only replace Cell< (type annotation) not Cell. (method call)
        sed -i '' 's/Cell</Writable</g' "$file"
        count1=$((count1 + 1))
    fi
done

echo "Processed $count1 files for type annotations"
echo ""
echo "=== Step 2: Adding Writable to imports ==="

# Now add Writable to imports using perl for multi-line handling
count2=0
for file in $files; do
    # Check if file uses Writable< anywhere
    if grep -q 'Writable<' "$file"; then
        # Check if there's an import from commonfabric
        if grep -q 'from "commonfabric"' "$file"; then
            # Get the import block (everything between import { and } from "commonfabric")
            import_block=$(perl -0777 -ne 'print $1 if /import\s*\{([^}]*)\}\s*from\s*"commonfabric"/s' "$file")

            # Check if Cell is in import but not Writable
            if echo "$import_block" | grep -qw 'Cell' && ! echo "$import_block" | grep -qw 'Writable'; then
                echo "Adding Writable to import: $file"

                # Use perl to add Writable after Cell in import statements only
                # This handles multi-line imports correctly
                perl -i -0777 -pe 's/(import\s*\{[^}]*)\bCell\b([^}]*\}\s*from\s*"commonfabric")/$1Cell, Writable$2/s' "$file"

                count2=$((count2 + 1))
            fi
        fi
    fi
done

echo "Added Writable to imports in $count2 files"
echo ""
echo "=== Done! ==="
echo ""
echo "Next steps:"
echo "1. Review changes: git diff patterns | head -200"
echo "2. Test patterns: deno task cf check patterns/examples/todo-list.tsx --no-run"
