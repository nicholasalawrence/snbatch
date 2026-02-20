# snbatch

> **Not affiliated with or endorsed by ServiceNow.** Uses documented ServiceNow REST APIs; behavior may vary by release and instance configuration. Best-effort open-source support — always validate in non-production first.

Batch-update ServiceNow store applications across multiple instances, with built-in safety rails, cross-environment replay, and LLM integration via MCP.

After every ServiceNow upgrade, admins face 100–200+ store applications needing updates. The platform provides no native batch update capability — it's one at a time, click-wait-repeat, for hours per instance. **snbatch** solves this.

## Install

```bash
npm install -g snbatch
```

**Requirements:** Node.js ≥ 22, ServiceNow CI/CD REST API plugin (`com.glide.continuousdelivery`) activated, App Repo Install API enabled (`sn_cicd.apprepo.install.enabled = true`), service account with `sn_cicd.sys_ci_automation` role. Run `snbatch doctor` to verify prerequisites.

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
snbatch scan [--profile <name>] [--patches-only] [--json]
```

### `snbatch preview`

Generate a reviewable upgrade manifest. Nothing gets installed without a plan.

```
snbatch preview [--patches|--minor|--all] [--exclude <scope1,scope2>] [--out <file>]
```

**Manifest file:** `snbatch-manifest-{instance}-{timestamp}.json`

### `snbatch install`

Install app updates sequentially (one at a time, with per-app progress).

```bash
snbatch install --patches                        # All patches, active instance
snbatch install --manifest dev-manifest.json     # From manifest
snbatch install --scope sn_hr_service_delivery   # Single app
snbatch install --start-at "02:00"               # Schedule for 2 AM
snbatch install --patches --continue-on-error    # Don't stop on failure
snbatch install --patches --stop-on-error        # Halt immediately on failure
snbatch install --batch --patches                # Legacy batch API (advanced)
```

**Flags:**
- `--continue-on-error` — skip failed packages and continue
- `--stop-on-error` — halt immediately on first failure (no prompt)
- `--start-at <HH:MM|ISO>` — schedule start with countdown
- `--batch` — use legacy batch install API instead of sequential

**Confirmation:**
- Patches / minor: y/N prompt (skippable with `-y`)
- Any major updates: must type the instance hostname — **not skippable**

**Non-TTY / CI:** Without a terminal, failures halt immediately (same as `--stop-on-error`) unless `--continue-on-error` is set.

### `snbatch rollback`

Roll back installed apps to their previous versions. Supports both per-app rollback (from sequential installs) and legacy batch rollback.

```bash
snbatch rollback --last                 # Roll back most recent install
snbatch rollback --batch-id <id>        # Roll back a specific history entry
snbatch rollback --list                 # Show rollback-eligible entries
snbatch rollback --token <token>        # Legacy batch rollback token
```

Always requires typed instance hostname confirmation.

### `snbatch doctor`

Check instance prerequisites and optionally auto-fix issues.

```bash
snbatch doctor                          # Check all prerequisites
snbatch doctor --fix                    # Auto-fix what's possible (requires admin)
snbatch doctor --json                   # Output results as JSON
```

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
3. Interactive prompt (only available when running in a TTY)

**HTTPS enforcement:** HTTP URLs are rejected by default to prevent credentials from being sent in plaintext. Use `--allow-insecure-http` or set `SNBATCH_ALLOW_HTTP=1` to override (not recommended).

**Profile encryption:** Profiles are encrypted with AES-256-GCM using a passphrase derived from a fixed app constant and your machine hostname. This provides at-rest protection against casual file reads but is **not** a substitute for a secrets manager. If an attacker has both file access and knowledge of the hostname, they can derive the key. For stronger security, set the `SNBATCH_KEYFILE` environment variable to the path of a file containing your preferred passphrase.

**Config file:** `.snbatchrc` (project-local) or `~/.snbatch/config.json` (global)

```json
{
  "defaults": { "format": "table", "poll_interval": 10, "retries": 3 },
  "exclude_always": ["sn_devstudio", "sn_atf"]
}
```

## CI/CD Pipeline Example (GitHub Actions)

```yaml
- name: Install ServiceNow patch updates
  run: snbatch install --patches --yes --continue-on-error
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
| `POST /api/sn_cicd/app_repo/install` | Install a single app (default) |
| `POST /api/sn_cicd/app_repo/rollback` | Roll back a single app |
| `GET /api/sn_cicd/progress/{id}` | Poll installation progress |
| `GET /api/now/table/sys_store_app` | Discover installed apps and available updates |
| `POST /api/sn_cicd/app/batch/install` | Batch install (`--batch` flag) |
| `POST /api/sn_cicd/app/batch/rollback` | Batch rollback (legacy) |

## License

MIT — see [LICENSE](LICENSE).
