#!/bin/bash
# Test that the plugin builds without OpenTelemetry for Yaegi compatibility

set -e

echo "Testing Yaegi-compatible build (without tracing)..."

# Build with yaegi tag to exclude OpenTelemetry
echo "Building with yaegi tag..."
go build -tags yaegi ./src/...

echo "✓ Build successful with yaegi tag"

# Test that we can import the package
echo "Testing package import..."
TESTDIR=$(mktemp -d)
cat > $TESTDIR/test-import.go << 'EOF'
package main

import (
    "fmt"
    _ "github.com/sevensolutions/traefik-oidc-auth/src"
)

func main() {
    fmt.Println("Import successful")
}
EOF

cd $TESTDIR
go mod init test-import
go mod edit -replace github.com/sevensolutions/traefik-oidc-auth=$OLDPWD
echo 'require github.com/sevensolutions/traefik-oidc-auth v0.0.0' >> go.mod
go mod tidy
go run -tags yaegi test-import.go

echo "✓ Package import successful"

# Clean up
cd $OLDPWD
rm -rf $TESTDIR

echo ""
echo "✅ All Yaegi compatibility tests passed!"