# Sample App

A tiny service used to test the Vertskim indexer.

## Layout

- `src/auth/session.ts` holds the `SessionStore`.
- Tokens are rotated by `rotate()` in `tokens.ts`.
- Reports are built by `tools/report.py`.

See the [architecture notes](docs/architecture.md#session-lifecycle) and the
[logo](assets/logo.svg).

## Running

```bash
# this heading inside a fence must not become a section
node src/index.ts
```
