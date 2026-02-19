# Contributing to snbatch

## Getting Started

```bash
git clone https://github.com/nicholasalawrence/snbatch.git
cd snbatch
npm install
npm test
```

## Project Structure

```
bin/snbatch.js          CLI entry point
src/
  commands/             One file per CLI command
  api/                  ServiceNow REST API clients
  models/               Manifest and Package models
  mcp/                  MCP server and tool definitions
  utils/                Shared utilities
test/
  unit/                 Pure logic tests (no API calls)
  integration/          Mock-server-based workflow tests
  live/                 Optional tests against a real instance
```

## Running Tests

```bash
npm test                 # Unit + integration tests
npm run test:coverage    # With coverage report
npm run test:live        # Against a real instance (requires env vars)
```

## Coding Guidelines

- ESM modules throughout (`import`/`export`, not `require`)
- No `__dirname` — use `src/utils/paths.js` for home dir paths
- All terminal output through `src/utils/display.js` — never `console.log`
- MCP mode (`SNBATCH_MCP_MODE=1`) must produce zero non-JSON on stdout
- Confirmation gates for destructive operations must never be bypassed

## Live Instance Tests

```bash
export SNBATCH_INSTANCE=https://your-pdi.service-now.com
export SNBATCH_USERNAME=admin
export SNBATCH_PASSWORD=yourpassword
npm run test:live
```

**Note:** Not affiliated with or endorsed by ServiceNow, Inc.
