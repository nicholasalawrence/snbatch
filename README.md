# snbatch

> **Not affiliated with or endorsed by ServiceNow.** Uses documented ServiceNow REST APIs; behavior may vary by release and instance configuration. Best-effort open-source support — always validate in non-production first.

Batch-update ServiceNow store applications across multiple instances, with built-in safety rails, cross-environment replay, and LLM integration via MCP.

After every ServiceNow upgrade, admins face hundreds of store applications needing updates — and the platform provides no native batch capability. It's one at a time, click-wait-repeat, for hours per instance. **snbatch** solves this.

## Install

```bash
npm install -g snbatch
```

**Requirements:** Node.js ≥ 22

## Quick Start

```bash
# 1. Add your instance
snbatch profile add dev --instance https://dev.service-now.com --username svc_cicd

# 2. Check prerequisites (and fix if needed)
snbatch doctor
snbatch doctor --fix    # auto-fix common issues

# 3. See what needs updating
snbatch scan

# 4. Generate a reviewable plan (patches only = safest)
snbatch preview --patches

# 5. Install from the manifest
snbatch install --manifest snbatch-manifest-*.json
```

## Instance Prerequisites

snbatch needs four things on the ServiceNow side:

1. **CI/CD spoke activated** (`com.sn_cicd_spoke` + `com.glide.continuousdelivery`)
2. **Service account with `sn_cicd.sys_ci_automation` role**
3. **Web service access enabled** on `sys_store_app`, `sys_app_version`, `sys_properties`
4. **CI/CD credential alias configured** (⚠️ manual UI step — see below)

**The `snbatch doctor` command checks all of these.** Run `snbatch doctor --fix` to auto-repair issues 1–3 (requires admin role).

> ⚠️ **Common gotcha:** `sys_store_app` and `sys_app_version` often have web service access *disabled* by default. This causes 403 errors even for admin users. `snbatch doctor --fix` resolves this automatically.

### Critical: CI/CD Credential Alias (Manual Setup Required)

The CI/CD install API requires a credential to authenticate with the ServiceNow App Repository. **Without this, all installs silently hang at "Pending" forever.** This step cannot be automated — it must be done once through the ServiceNow UI:

1. Navigate to **Connections & Credentials → Credentials**
2. Click **New → Basic Auth Credentials**
3. Set **Name**: `CICD Service Account`
4. Set **User name**: an admin user on the instance
5. Set **Password**: that user's password
6. Click the **lock icon** 🔒 next to "Credential alias" to unlock it
7. Set **Credential alias**: `sn_cicd_spoke.CICD`
8. Click **Submit**

`snbatch doctor` checks for this and provides these exact instructions when it's missing. `snbatch install` also pre-flight checks and aborts early with instructions rather than letting installs silently hang.

## Commands

### `snbatch doctor`

Check instance prerequisites and optionally fix issues.

```bash
snbatch doctor              # Check all prerequisites
snbatch doctor --fix        # Auto-fix (requires admin + typed confirmation)
```

### `snbatch scan`

Discover available store app updates with risk classification.

```bash
snbatch scan                        # All updates
snbatch scan --patches-only         # Patches only
snbatch scan --json                 # JSON output for piping
snbatch scan --profile prod         # Target a specific instance
```

Updates are classified as 🟢 patch (low risk), 🟡 minor (medium), or 🔴 major (high — potential breaking changes).

### `snbatch preview`

Generate a reviewable upgrade manifest. Nothing gets installed without a plan.

```bash
snbatch preview --patches                    # Patches only (safest)
snbatch preview --minor                      # Patches + minor
snbatch preview --all                        # Everything
snbatch preview --patches --exclude sn_atf   # With exclusions
snbatch preview --out my-plan.json           # Custom filename
```

The manifest is a JSON file that can be reviewed, edited, committed to Git, or shared with a change manager before execution.

### `snbatch install`

Execute a batch update.

```bash
snbatch install --patches                        # All patches on active instance
snbatch install --manifest dev-manifest.json     # From a manifest
snbatch install --manifest plan.json -y          # Skip confirmation (patches/minor only)
```

**Safety:**
- Patches/minor: y/N confirmation prompt (skippable with `-y`)
- Major updates: must type the instance hostname — **never skippable**
- Batch install runs server-side — if your terminal disconnects, the install continues

### `snbatch rollback`

Roll back a batch installation (all-or-nothing).

```bash
snbatch rollback --last             # Most recent batch
snbatch rollback --batch-id <id>    # Specific batch
snbatch rollback --list             # Show rollback-eligible batches
```

Always requires typed instance hostname confirmation.

> **Note:** Rollback is all-or-nothing per batch. For granular rollback, run patches, minor, and major as separate batches.

### `snbatch reconcile`

Replay a manifest from one environment in another, with automatic diff detection.

```bash
snbatch reconcile --manifest dev-manifest.json --profile prod
```

Produces an adjusted manifest showing what's matched, already current, version mismatched, or not installed on the target.

### `snbatch profile`

Manage instance connections.

```bash
snbatch profile add dev --instance https://dev.service-now.com --username svc_cicd
snbatch profile list
snbatch profile switch test
snbatch profile remove old-sandbox
```

### `snbatch serve --mcp`

Start an MCP server for Claude or other LLM integration.

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

## Credential Management

**Resolution order (highest priority first):**

1. **Environment variables** — `SNBATCH_INSTANCE`, `SNBATCH_USERNAME`, `SNBATCH_PASSWORD` (recommended for CI/CD)
2. **Encrypted profile file** — `~/.snbatch/profiles.json`, AES-256 encrypted (convenience encryption for local dev — not a substitute for a secrets manager)
3. **Interactive prompt** — `--prompt-password` asks every time, stores nothing

For CI/CD pipelines, use your secrets manager (Vault, GitHub Actions secrets, AWS Secrets Manager) to populate the environment variables.

## Configuration

**Config file:** `.snbatchrc` (project-local) or `~/.snbatch/config.json` (global)

```json
{
  "defaults": { "format": "table", "poll_interval": 10, "retries": 3 },
  "exclude_always": ["sn_devstudio", "sn_atf"]
}
```

## CI/CD Pipeline Example

### GitHub Actions

```yaml
- name: Batch update ServiceNow patches
  run: |
    snbatch doctor
    snbatch install --patches --yes
  env:
    SNBATCH_INSTANCE: ${{ secrets.SN_INSTANCE }}
    SNBATCH_USERNAME: ${{ secrets.SN_USERNAME }}
    SNBATCH_PASSWORD: ${{ secrets.SN_PASSWORD }}
```

### Cross-Environment Replay

```yaml
- name: Generate manifest in dev
  run: snbatch preview --patches --out patch-plan.json --profile dev

- name: Reconcile and install in test
  run: |
    snbatch reconcile --manifest patch-plan.json --profile test
    snbatch install --manifest test-manifest-*.json --profile test -y
```

## Recommended Update Strategy

For the safest upgrade path, run patches, minor, and major as **separate batches**:

```bash
# 1. Patches first (lowest risk, best rollback granularity)
snbatch preview --patches
snbatch install --manifest <patches-manifest>.json

# 2. Minor updates next
snbatch preview --minor
snbatch install --manifest <minor-manifest>.json

# 3. Major updates individually or in small batches (review each one)
snbatch scan --json | jq '[.[] | select(.upgradeType == "major")]'
```

This gives you independent rollback capability per risk tier.

## Files Written

| Path | Purpose |
|---|---|
| `~/.snbatch/profiles.json` | Encrypted credential store |
| `~/.snbatch/history.json` | Operation history (JSON Lines) |
| `~/.snbatch/logs/` | Structured logs (JSON Lines, credentials redacted) |
| `~/.snbatch/config.json` | Global config (optional) |

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | All succeeded |
| 1 | Partial failure |
| 2 | Fatal error |

## Important Notes

- **Store apps only.** Platform plugins are updated during ServiceNow release upgrades and cannot be batch-updated through the CI/CD API.
- **Sequential installs.** snbatch installs apps one at a time using the single app install API (`/api/sn_cicd/app_repo/install`). Each install takes 30–90 seconds. The batch install API exists but requires additional store connection configuration that most instances don't have.
- **Installs are server-side.** Once submitted, each install continues on the ServiceNow instance even if your terminal disconnects.
- **Credential alias is mandatory.** The `sn_cicd_spoke.CICD` credential alias must have a Basic Auth credential bound to it. Without this, installs accept but never execute. Run `snbatch doctor` for setup instructions.
- **Rollback is per-app.** Each installed app tracks its own rollback version. You can rollback individual apps or all apps from a session.
- **Always run `snbatch doctor` first** on a new instance to verify prerequisites.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
