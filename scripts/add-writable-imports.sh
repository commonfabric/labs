#!/bin/bash
# Script to add Writable to imports in patterns files
# Handles both single-line and multi-line import statements

set -e

PATTERNS_DIR="patterns"

echo "=== Adding Writable to imports in $PATTERNS_DIR ==="

files=$(find "$PATTERNS_DIR" -type f \( -name "*.ts" -o -name "*.tsx" \) | sort)

count=0
for file in $files; do
    # Check if file uses Writable<
    if grep -q 'Writable<' "$file"; then
        # Check if file has import from commonfabric
        if grep -q 'from "commonfabric"' "$file"; then
            # Extract just the import block (20 lines before 'from "commonfabric"')
            import_block=$(grep -B 20 'from "commonfabric"' "$file" | head -21)

            # Check if Writable is already in the import
            if ! echo "$import_block" | grep -qw 'Writable'; then
                echo "Adding Writable import: $file"

                # Try to add after "Cell," (handles both single and multi-line)
                if grep -q 'Cell,' "$file"; then
                    sed -i '' 's/Cell,/Cell, Writable,/' "$file"
                    count=$((count + 1))
                # Or add after Cell if it's followed by newline
                elif grep -q 'Cell$' "$file"; then
                    sed -i '' 's/Cell$/Cell, Writable/' "$file"
                    count=$((count + 1))
                else
                    echo "  WARNING: Could not determine where to add Writable in $file"
                fi
            fi
        fi
    fi
done

echo ""
echo "=== Done! Updated imports in $count files ==="
