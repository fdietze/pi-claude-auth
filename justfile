# Default: lint, build, test
default: all

# Compile TypeScript
build:
    pnpm run build

# Run unit tests
test:
    pnpm test

# Run model smoke tests
test-models:
    pnpm run test:models

# Lint with oxlint + oxfmt
lint:
    pnpm run lint

# Auto-fix lint issues
fix:
    pnpm run lint:fix

# Format with oxfmt
format:
    pnpm run format

# Remove compiled output
clean:
    rm -rf dist

# Lint + build + test
all: lint build test

# Bump version, tag, and push. CI publishes to npm automatically.
# npm version creates an annotated tag + commit; --follow-tags pushes both.
# Usage: just release 0.1.2
release version:
    npm version {{version}} --message "🔖 Release %s"
    git push origin main --follow-tags
