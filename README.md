# snbatch

> **Not affiliated with or endorsed by ServiceNow.** Uses documented ServiceNow REST APIs; behavior may vary by release and instance configuration. Best-effort open-source support — always validate in non-production first.

Batch-update ServiceNow store applications and plugins across multiple instances, with built-in safety rails, cross-environment replay, and LLM integration via MCP.

After every ServiceNow upgrade, admins face 100–200+ store applications needing updates. The platform provides no native batch update capability — it's one at a time, click-wait-repeat, for hours per instance. **snbatch** solves this.

## Install

```bash
npm install -g snbatch
```

**Requirements:** Node.js ≥ 22, ServiceNow CI/CD spoke activated, service account with `sn_cicd.sys_ci_automation` role.

## Quick Start

```bash
# Configure your instance
snbatch profile add dev --instance https://dev.service-now.com --username svc_cicd

# Discover available updates
snbatch scan

# Generate a reviewable manifest
snbatch preview --patches

# Install from the manifest
snbatch install --manifest snbatch-manifest-dev-*.json
```

## Commands

### `snbatch scan`

Discover available updates on the active instance.

```
snbatch scan [--profile <name>] [--type app|plugin|all] [--patches-only] [--json]
```

### `snbatch preview`

Generate a reviewable upgrade manifest. Nothing gets installed without a plan.

```
snbatch preview [--patches|--minor|--all] [--exclude <scope1,scope2>] [--out <file>]
```

**Manifest file:** `snbatch-manifest-{instance}-{timestamp}.json`

### `snbatch install`

Execute a batch update.

```bash
snbatch install --patches                        # All patches, active instance
snbatch install --manifest dev-manifest.json     # From manifest
snbatch install --scope sn_hr_service_delivery   # Single app
```

**Confirmation:**
- Patches / minor: y/N prompt (skippable with `-y`)
- Any major updates: must type the instance hostname — **not skippable**

### `snbatch rollback`

Roll back a batch installation (all-or-nothing).

```bash
snbatch rollback --last
snbatch rollback --batch-id <id>
snbatch rollback --list
```

Always requires typed instance hostname confirmation.

### `snbatch reconcile`

Adapt a manifest from one environment for a different environment.

```bash
snbatch reconcile --manifest dev-manifest.json --profile prod
```

### `snbatch profile`

Manage instance connections.

```bash
snbatch profile add dev --instance https://dev.service-now.com --username svc_cicd
snbatch profile list
snbatch profile switch test
snbatch profile remove old-sandbox
```

### `snbatch serve --mcp`

Start an MCP server for Claude / LLM integration.

```bash
snbatch serve --mcp
```

**Claude Desktop config:**
```json
{
  "mcpServers": {
    "snbatch": {
      "command": "snbatch",
      "args": ["serve", "--mcp"],
      "env": {
        "SNBATCH_INSTANCE": "https://dev.service-now.com",
        "SNBATCH_USERNAME": "svc_cicd",
        "SNBATCH_PASSWORD": "${SNBATCH_PASSWORD}"
      }
    }
  }
}
```

## Configuration

**Credential resolution order:**
1. `SNBATCH_INSTANCE`, `SNBATCH_USERNAME`, `SNBATCH_PASSWORD` environment variables (recommended for CI/CD)
2. Encrypted profile file `~/.snbatch/profiles.json` (AES-256, convenience encryption for local dev)
3. Interactive prompt (`--prompt-password`)

**Config file:** `.snbatchrc` (project-local) or `~/.snbatch/config.json` (global)

```json
{
  "defaults": { "format": "table", "poll_interval": 10, "retries": 3 },
  "exclude_always": ["sn_devstudio", "sn_atf"]
}
```

## CI/CD Pipeline Example (GitHub Actions)

```yaml
- name: Batch update ServiceNow patches
  run: snbatch install --patches --yes
  env:
    SNBATCH_INSTANCE: ${{ secrets.SN_INSTANCE }}
    SNBATCH_USERNAME: ${{ secrets.SN_USERNAME }}
    SNBATCH_PASSWORD: ${{ secrets.SN_PASSWORD }}
```

## Files Written

| Path | Purpose |
|---|---|
| `~/.snbatch/profiles.json` | Encrypted credential store |
| `~/.snbatch/history.json` | Operation history (JSON Lines) |
| `~/.snbatch/logs/` | Structured logs (JSON Lines, credentials redacted) |

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | All succeeded |
| 1 | Partial failure |
| 2 | Fatal error |

## API Dependencies

| API | Purpose |
|---|---|
| `POST /api/sn_cicd/app/batch/install` | Execute batch installation |
| `POST /api/sn_cicd/app/batch/rollback` | Rollback a batch |
| `GET /api/sn_cicd/progress/{id}` | Poll installation progress |
| `GET /api/now/table/sys_store_app` | Discover installed apps |
| `GET /api/now/table/sys_app_version` | Available versions |
| `GET /api/now/table/sys_plugins` | Discover plugins |

These APIs have been stable since the Orlando release.

## License

MIT — see [LICENSE](LICENSE).
