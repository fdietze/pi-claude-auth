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

# Exercise the extension in the real pi runtime (needs `vanilla-pi` on PATH).
# Unit tests run under node; pi runs an embedded Bun that proxies node:fs, so
# this is the only check that covers the runtime we actually ship into.
smoke:
    pnpm run smoke

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
