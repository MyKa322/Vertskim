# Architecture

How the pieces fit together.

## Session lifecycle

`SessionStore.refresh` loads the session, calls `rotate`, and persists the
result through the `KeyValueStore` interface. Start at [the entry point](../src/index.ts).

## Reporting

The Python side lives in [tools](../tools/) and starts from `build_report`.
Back to [the top](#architecture) or the [readme](../README.md).
