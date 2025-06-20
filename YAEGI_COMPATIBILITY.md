# Yaegi Compatibility

This middleware is designed to be compatible with Yaegi, the Go interpreter used by Traefik for loading plugins.

## Build Tags

The codebase uses build tags to ensure compatibility:

- **`yaegi`** - Excludes OpenTelemetry and other incompatible dependencies when building for Traefik
- **`tracing`** - Includes OpenTelemetry tracing support (for standalone mode only)

## Building for Different Modes

### For Traefik Plugin (Yaegi-compatible)
```bash
go build -tags yaegi ./src/...
```

### For Standalone Mode (with tracing)
```bash
go build -tags tracing ./cmd/standalone
```

## Testing Yaegi Compatibility

Run the compatibility test:
```bash
./test-yaegi-build.sh
```

This test will:
1. Build the plugin with the `yaegi` tag
2. Verify that the package can be imported
3. Check for any compatibility issues

## Implementation Details

The tracing functionality is abstracted behind interfaces:
- `tracing.Tracer` - Main tracer interface
- `tracing.Span` - Span interface

When building with the `yaegi` tag:
- A stub implementation is used (no actual tracing)
- No OpenTelemetry dependencies are included
- The plugin remains fully functional without tracing

When building with the `tracing` tag:
- Full OpenTelemetry implementation is included
- Tracing data is sent to configured endpoints
- Used only in standalone mode

## Known Limitations

When running as a Traefik plugin:
- No distributed tracing support (use Traefik's built-in tracing instead)
- Metrics are not exposed (use Traefik's metrics)
- Must use the `yaegi` build tag or default build