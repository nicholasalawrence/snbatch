# snbatch — Product Spec v0.5

> **snbatch** is an open-source CLI tool for batch-updating ServiceNow store applications across multiple instances, with built-in safety rails, cross-environment replay, and LLM integration via MCP.
>
> **Not affiliated with or endorsed by ServiceNow.** Uses documented ServiceNow REST APIs; behavior may vary by release and instance configuration. Best-effort open-source support — always validate in non-production first.

---

## The Problem

After every ServiceNow upgrade, admins face hundreds of store applications needing updates. The platform provides no native batch update capability — it's one at a time, click-wait-repeat, for hours per instance. A typical demo instance has 800–900 apps with updates available after an upgrade. Multiply across dev, test, staging, and prod and it's days of manual work.

Community workarounds exist (CI/CD Spoke subflows, Flow Designer approaches) but are scoped apps inside a single instance. There's no external tool that handles this across environments safely.

---

## Architecture: External CLI Tool (Node.js)

**Decision:** External CLI, not a ServiceNow scoped app.

- **Cross-instance by nature.** Scan, plan, install, replay — fundamentally multi-instance workflows.
- **Lower enterprise risk.** Talks only through ServiceNow's published CI/CD REST APIs. Nothing installed on the instance.
- **Pipeline-native.** Fits Jenkins, GitHub Actions, and other CI/CD workflows.
- **LLM-native.** Exposes capabilities as MCP tools for Claude or other LLMs.

### API Dependencies

| API | Purpose |
|---|---|
| `POST /api/sn_cicd/app/batch/install` | Execute batch installation |
| `POST /api/sn_cicd/app/batch/rollback` | Rollback a batch |
| `GET /api/sn_cicd/progress/{id}` | Poll installation progress |
| `GET /api/now/table/sys_store_app` | Discover installed apps with updates |
| `GET /api/now/table/sys_app_version` | Get available versions per app |
| `GET /api/now/table/sys_properties` | Instance version detection |
| `GET /api/now/table/sys_plugins` | Plugin status (doctor command) |
| `GET /api/now/table/sys_db_object` | Web service access checks (doctor) |
| `GET /api/now/table/sys_user_has_role` | Role checks (doctor) |

**Instance prerequisites:**
- CI/CD spoke activated (`com.sn_cicd_spoke` and `com.glide.continuousdelivery`)
- Service account with `sn_cicd.sys_ci_automation` role
- Web service access enabled on `sys_store_app`, `sys_app_version`, `sys_properties`
- **CI/CD credential alias configured** (⚠️ manual UI step required — see below)
- The `snbatch doctor` command checks all of these and auto-fixes where possible

### Critical: CI/CD Credential Alias (Manual Setup Required)

The CI/CD Spoke requires a Basic Auth credential bound to the `sn_cicd_spoke.CICD` credential alias. **Without this, all installs silently hang at "Pending" forever.** The install engine uses this credential to authenticate with the ServiceNow App Repository when downloading packages.

**This cannot be automated.** The Credential alias field on the credential form has a UI-level lock icon that prevents programmatic writes via GlideRecord. It must be configured manually through the ServiceNow UI:

1. Navigate to **Connections & Credentials → Credentials**
2. Click **New → Basic Auth Credentials**
3. Set **Name**: `CICD Service Account`
4. Set **User name**: an admin user on the instance
5. Set **Password**: that user's password
6. Click the **lock icon** next to Credential alias to unlock it
7. Set **Credential alias**: `sn_cicd_spoke.CICD`
8. Click **Submit**

`snbatch doctor` checks for this configuration and provides these instructions when it's missing. `snbatch install` also pre-flight checks this and aborts early with instructions rather than letting installs silently hang.

### Important: Store Apps Only

**snbatch operates exclusively on store applications (`sys_store_app`), not platform plugins (`sys_plugins`).** Platform plugins are updated as part of the ServiceNow release upgrade process and cannot be independently updated through the CI/CD API.

### Install API: Sequential Single App Install

snbatch uses the **single app install API** (`/api/sn_cicd/app_repo/install`) rather than the batch install API. The batch API (`/api/sn_cicd/app/batch/install`) requires additional store connection configuration that most instances don't have. The single app API works reliably once the credential alias is configured.

**Request:** `POST /api/sn_cicd/app_repo/install?scope={scope}&version={version}[&load_demo_data=true]`

The `load_demo_data` parameter is passed when the manifest package has `loadDemoData: true` (set during `snbatch preview`).

**Response:**
```json
{
  "result": {
    "status": "0",
    "status_label": "Pending",
    "links": {
      "progress": { "id": "abc123..." }
    },
    "percent_complete": 0,
    "rollback_version": "2.0.21"
  }
}
```

**Progress polling:** `GET /api/sn_cicd/progress/{id}`
- Status `0` = Pending, `1` = Running, `2` = Succeeded, `3` = Failed
- Poll every 5 seconds until status is 2 or 3

**Rollback:** `POST /api/sn_cicd/app_repo/rollback?scope={scope}&version={rollback_version}`

---

## v1 Scope

v1 priorities: **correctness, clear failure modes, recoverability.** A tool that's lean, trustworthy, and immediately useful after `npm install -g snbatch`.

---

### v1 Commands

#### 1. Doctor (Prerequisite Check & Fix)

**Command:** `snbatch doctor`

Checks all instance prerequisites and reports pass/fail for each. Optionally fixes issues with `--fix`.

**Checks performed (in order):**

1. **Connectivity** — instance reachable
2. **Authentication** — credentials valid
3. **Instance version** — `glide.buildname` property lookup
4. **CI/CD Spoke** — `com.sn_cicd_spoke` active
5. **CI/CD REST API** — `com.glide.continuousdelivery` active
6. **CI/CD Role** — user has `sn_cicd.sys_ci_automation`
7. **Web Service Access** — `sys_store_app` has `ws_access=true`
8. **Web Service Access** — `sys_app_version` has `ws_access=true`
9. **Web Service Access** — `sys_properties` has `ws_access=true`
10. **CI/CD Credential Alias** — `sn_cicd_spoke.CICD` has a credential bound (**⚠️ manual fix only**)
11. **Updates available** — count of apps with `update_available=true`

**Auto-fix (`snbatch doctor --fix`):**
- Assigns `sn_cicd.sys_ci_automation` role to current user
- Enables `ws_access` on required tables
- Requires admin role and typed hostname confirmation
- **Cannot fix** the CI/CD credential alias — displays step-by-step manual UI instructions instead

**Why this matters:** On a fresh or recently upgraded instance, `sys_store_app` and `sys_app_version` typically have web service access **disabled by default**, and the CI/CD credential alias is **never** pre-configured. Without web service access, scans return 403. Without the credential alias, installs silently hang at "Pending" forever — the #1 setup gotcha.

---

#### 2. Scan

**Command:** `snbatch scan`

Connects to the active instance and inventories available store app updates.

**Server-side filtering:** Queries `sys_store_app` with `active=true^update_available=true` so only apps that actually need updating are returned. Also fetches `apps_in_jumbo` and `demo_data` fields. Pagination handles instances with 1000+ apps.

**Output per package:**
- Name, scope
- Current installed version
- Latest available version
- Version delta: 🟢 patch, 🟡 minor, 🔴 major

**Jumbo app detection:** Some apps are bundles containing multiple `com.*` platform plugins. These are identified by a non-empty `apps_in_jumbo` field on `sys_store_app`. They are automatically excluded from the installable update list because the CI/CD API requires an "offering plugin ID" to select which sub-plugins to install — a choice that requires manual intervention. Excluded jumbo apps are listed in a warning block after the main scan summary:

```
Summary: 108 patches, 12 minor, 3 major — 123 total (2 excluded — jumbo apps, see below)

⚠  2 app(s) excluded — jumbo bundles requiring manual installation:
  • Healthcare CSC Bundle (sn_hs_csc)
  • SAM SaaS Integration (sn_sam_saas_int)
  These contain bundled platform plugins. Install them via the ServiceNow UI:
  System Applications → All Available Applications → All
```

**Flags:**
- `--format table|json|csv` — output format (default: table for TTY, json when piped)
- `--patches-only` — show only patch-level updates
- `--profile <n>` — target a specific instance
- `--json` — alias for `--format json`

---

#### 3. Preview & Manifest Generation

**Command:** `snbatch preview`

Generates a detailed upgrade plan and saves it as a manifest file. Primary safety mechanism.

**Flags:**
- `--patches` / `--minor` / `--major` / `--all` — scope the preview
- `--exclude <scope1,scope2>` — exclude specific packages
- `--out <filename>` — custom manifest filename
- `--profile <n>` — target a specific instance
- `-y, --yes` — skip interactive prompts (no demo data)

**Jumbo app warning:** Same jumbo exclusion warning as scan — displayed before the manifest table when jumbo apps exist.

**Demo data selection (interactive TTY only):**

If any packages in the update list have demo data available (`demo_data = "Has demo data"` on `sys_store_app`), the user is prompted before the manifest is written:

```
📦 63 apps have optional demo data available.
? Install demo data for:
  ❯ [N] None (skip demo data for all)
    [A] All apps with demo data
    [S] Select specific apps
```

If the user selects **S**, a numbered list of only demo-capable apps is shown and the user enters a comma-separated list of numbers. Selected apps get `loadDemoData: true` in the manifest and are marked with 📦 in the preview table.

In non-interactive mode (piped stdin/stdout, or `--yes`), demo data defaults to false and a notice is printed. This prevents CI/CD pipelines from hanging on a prompt.

> **MCP usage note:** When snbatch is invoked via the ServiceNow MCP server, the interactive terminal prompt is replaced by natural language conversation. Claude asks the user which apps should receive demo data, interprets their response, and sets the appropriate manifest flags before proceeding with install. The manifest format and install behavior are identical regardless of which interface is used.

**Manifest structure:**
```json
{
  "manifestVersion": 1,
  "metadata": {
    "createdAt": "2026-02-20T01:42:54.000Z",
    "instance": "https://nickalectrizurichaic.service-now.com",
    "instanceVersion": "Yokohama Patch 3",
    "profile": "dev",
    "snbatchVersion": "0.1.0"
  },
  "packages": [
    {
      "sysId": "abc123...",
      "scope": "sn_docker_spoke",
      "name": "Docker Spoke",
      "currentVersion": "2.3.3",
      "targetVersion": "2.3.4",
      "upgradeType": "patch",
      "sourceId": "def456...",
      "packageType": "app",
      "hasDemoData": false,
      "loadDemoData": false
    }
  ],
  "stats": { "total": 110, "patch": 110, "minor": 0, "major": 0, "none": 0 }
}
```

**Determinism:** Packages sorted alphabetically by scope. Timestamps in metadata only.

---

#### 4. Install

**Command:** `snbatch install [options]`

Executes a batch update from flags or a manifest.

**Confirmation behavior:**
- 🟢 Patch/minor installs: y/N prompt (skippable with `-y`)
- 🔴 Any major updates: typed hostname confirmation (never skippable)

**During installation:**
- Real-time progress polling (default every 10 seconds)
- Batch processing is server-side — survives client disconnects

**After installation:**
- Summary: succeeded / failed / skipped
- Rollback ID stored in `~/.snbatch/history.json`
- Full log written to `~/.snbatch/logs/`

**Idempotent:** Re-running the same manifest skips already-current packages.

---

#### 5. Rollback

**Command:** `snbatch rollback [options]`

All-or-nothing batch rollback via CI/CD API. Always requires typed hostname confirmation.

---

#### 6. Reconcile (Cross-Environment Replay)

**Command:** `snbatch reconcile --manifest <file> --profile <target>`

Adapts a manifest from one environment to another, categorizing each package as matched, already current, version mismatch, not installed, or extra available.

---

#### 7. Profile Management

Multi-profile credential management with encrypted storage.

**Credential resolution (highest priority first):**
1. Environment variables (`SNBATCH_INSTANCE`, `SNBATCH_USERNAME`, `SNBATCH_PASSWORD`)
2. Encrypted profile file (`~/.snbatch/profiles.json`, AES-256, convenience encryption)
3. Interactive prompt (`--prompt-password`)

---

#### 8. MCP Server Mode

**Command:** `snbatch serve --mcp`

Exposes all capabilities as MCP tools. Install/rollback always require human confirmation via token relay.

---

#### 9. Config File

**File:** `.snbatchrc` (project-local) or `~/.snbatch/config.json` (global)

Stores default flag values and permanent exclusions.

---

### v1 Command Summary

| Command | Purpose |
|---|---|
| `snbatch doctor` | Check & fix instance prerequisites |
| `snbatch scan` | Discover available updates |
| `snbatch preview` | Generate reviewable manifest |
| `snbatch install` | Execute batch update |
| `snbatch rollback` | Roll back a batch |
| `snbatch reconcile` | Adapt manifest for different environment |
| `snbatch profile` | Manage instance connections |
| `snbatch serve --mcp` | LLM connector |

---

## Known Instance Gotchas

Issues discovered during live testing that users will encounter:

### 1. Web Service Access Disabled (403 on Table API)

**Symptom:** `Request failed with status code 403` on scan even with admin + CI/CD role.

**Cause:** `sys_store_app`, `sys_app_version`, and `sys_properties` tables have `ws_access=false` by default on many instances. This blocks all REST API access regardless of user roles.

**Fix:** `snbatch doctor --fix` enables web service access on all required tables. Manual fix: navigate to System Definition → Tables, find the table, check "Allow access to this table via web services."

### 2. URI Too Long (414 on Version Lookup)

**Symptom:** `Request failed with status code 414` during scan.

**Cause:** Querying `sys_app_version` with hundreds of source IDs in a single `sourceIN` query exceeds URL length limits.

**Fix:** Version queries are chunked into batches of 50 source IDs per request.

### 3. Invalid Source IDs

**Symptom:** Garbage values in version queries causing errors.

**Cause:** Some store apps have scope names (like `sn_csm.awa`) in their `source` field instead of valid 32-character sys_ids.

**Fix:** Source IDs are filtered through `/^[a-fA-F0-9]{32}$/` before querying.

### 4. Plugins vs. Store Apps

**Symptom:** Scan returns hundreds of plugins with "unknown" versions.

**Cause:** Platform plugins (`sys_plugins`) don't have independent version tracking or update capability through the CI/CD API. They're updated as part of the ServiceNow release upgrade.

**Fix:** snbatch operates exclusively on store applications. Plugins are excluded entirely.

### 5. Result Pagination

**Symptom:** Exactly 1000 results returned, missing apps.

**Cause:** `sysparm_limit=1000` cap on Table API queries.

**Fix:** Paginated queries using `sysparm_offset`, fetching 500 records per page.

### 6. Jumbo Apps (Offering Plugin ID Required)

**Symptom:** API returns `"Offering plugin id must be specified for application"` immediately on install.

**Cause:** Some store apps are bundles containing multiple `com.*` platform plugins. The CI/CD install API requires specifying which sub-plugin to install ("offering plugin ID"), a choice that can't be made programmatically.

**Fix:** snbatch automatically detects jumbo apps via the `apps_in_jumbo` field on `sys_store_app` (a non-empty JSON array of plugin IDs) and excludes them from all install operations. They are listed in a warning block after scan/preview so the user can install them manually through the ServiceNow UI (System Applications → All Available Applications → All).

Typical instances have 2–5 jumbo apps out of hundreds with updates available. They are identifiable by name — typically suite/bundle apps like "Healthcare CSC Bundle" or "SAM SaaS Integration".

### 7. CI/CD Credential Alias Not Configured (Installs Hang Forever)

**Symptom:** Install accepted by API (returns progress ID) but stays at "Pending" or "Pending resource locks" forever, never progresses to "Running."

**Cause:** The CI/CD Spoke's `sn_cicd_spoke.CICD` credential alias has no Basic Auth credential bound to it. The install engine can't authenticate with the app repository to download packages.

**Fix:** Must be done **manually through the UI** — the Credential alias field has a UI-level lock icon that prevents programmatic writes via GlideRecord.

1. Navigate to Connections & Credentials → Credentials
2. Create a new Basic Auth Credentials record
3. Set username/password to an admin account on the instance
4. Click the lock icon next to "Credential alias" to unlock it
5. Set Credential alias to `sn_cicd_spoke.CICD`
6. Submit

`snbatch doctor` checks for this and provides these instructions. `snbatch install` pre-flight checks and aborts early with instructions rather than silently hanging.

**This is the #1 most critical prerequisite** — everything else can be auto-fixed, but this requires a human in the UI.

---

## Reliability & Recoverability

### Deterministic Manifests
Same instance state produces identical manifest content. Packages sorted by scope.

### Idempotent Install
Re-running a manifest skips already-current packages. Safe to retry after partial failure.

### Resume After Interruption
Batch install executes server-side on the ServiceNow instance. If the client disconnects, the batch continues. `snbatch install --resume` (v2) will re-attach to an in-progress batch.

### Logging
JSON Lines format in `~/.snbatch/logs/`. Credentials redacted.

---

## Rate Limiting & Polling

- Scan/preview: 2-3 API calls + chunked version lookups
- Install: 1 call to start + progress polling every 10s
- Back off to 30s on 429 responses
- Max poll duration: 2 hours

---

## Error Handling

| Category | Examples | Behavior |
|---|---|---|
| Retryable | Network timeout, 503, 429 | Retry with backoff, max 3 attempts |
| Permanent | 401, 403, 404, 400 | Fail immediately, clear message |
| Partial | Some packages fail | Report per-package, store rollback ID |
| Fatal | Instance unreachable, malformed manifest | Abort, exit code 2 |

Exit codes: 0 = success, 1 = partial failure, 2 = fatal error.

---

## Security

### Credential Handling
- **CI/CD pipelines:** Environment variables sourced from secrets manager
- **Local development:** AES-256 encrypted profile file (convenience encryption, not HSM-grade)
- **One-off runs:** `--prompt-password` interactive prompt

### Confirmation Gates
| Operation | Confirmation |
|---|---|
| Install (patches/minor) | y/N prompt (skippable with `-y`) |
| Install (includes major) | Typed hostname (never skippable) |
| Rollback | Typed hostname (never skippable) |
| Doctor --fix | Typed hostname (never skippable) |
| MCP install/rollback | Confirmation token relay (never skippable) |

---

## Testing Strategy

- **Unit tests:** Version comparison, manifest determinism, reconcile logic, crypto, confirmations
- **Integration tests (mocked):** Full workflow against recorded API responses, retry behavior, pagination
- **Live smoke tests:** Optional `npm run test:live` against a real PDI

---

## Compatibility

> **snbatch** is not affiliated with or endorsed by ServiceNow, Inc. Uses documented CI/CD and Table REST APIs. Behavior may vary across releases and instance configurations. The CI/CD batch install API has been available since the Orlando release. Always validate in non-production first.

---

## v2 Roadmap

| Priority | Feature | Description |
|---|---|---|
| 1 | **Resume** | `--resume` to re-attach to in-progress server-side batch |
| 2 | **Strict reconcile** | `--strict` requires identical starting versions |
| 3 | **Instance comparison** | `snbatch compare --profiles dev,test` drift report |
| 4 | **Pipeline templates** | `snbatch init --github-actions` / `--jenkins` |
| 5 | **ATF integration** | `--test-after <suite>` with optional rollback on failure |
| 6 | **Dependency analysis** | Client-side dependency graph in preview |
| 7 | **Interactive mode** | `--interactive` step-through per package |
| 8 | **Multi-instance chain** | `--profiles dev,test,prod` sequential execution |
| 9 | **Plugin activation** | Activate new plugins (different API workflow) |
| 10 | **Notification hooks** | `--notify slack:<webhook>` on completion |
| 11 | **Web dashboard** | `snbatch serve --web` local browser UI |
| 12 | **LLM prompt library** | Curated prompts for better scan reasoning |

---

## Project Structure

```
snbatch/
├── bin/snbatch.js                    # CLI entry point
├── src/
│   ├── commands/
│   │   ├── doctor.js                 # Prerequisite check & fix
│   │   ├── scan.js                   # Discover updates
│   │   ├── preview.js                # Generate manifest
│   │   ├── install.js                # Execute batch update
│   │   ├── rollback.js               # Roll back a batch
│   │   ├── reconcile.js              # Cross-environment replay
│   │   └── profile.js                # Profile management
│   ├── mcp/
│   │   ├── server.js                 # MCP server (stdio transport)
│   │   ├── tools.js                  # Tool definitions
│   │   └── confirmations.js          # Token-based confirmation gates
│   ├── api/
│   │   ├── cicd.js                   # CI/CD API (batch install, rollback, progress)
│   │   ├── table.js                  # Table API (sys_store_app, sys_app_version)
│   │   ├── auth.js                   # Credential resolution chain
│   │   └── index.js                  # Axios client factory
│   ├── models/
│   │   ├── manifest.js               # Manifest CRUD, validation, diffing
│   │   └── package.js                # Package model, install payload conversion
│   └── utils/
│       ├── profiles.js               # Encrypted profile storage
│       ├── logger.js                 # JSON Lines structured logging
│       ├── display.js                # Terminal output (suppressed in MCP mode)
│       ├── version.js                # Semver parsing + risk classification
│       ├── retry.js                  # Exponential backoff
│       ├── crypto.js                 # AES-256-GCM encryption
│       ├── confirmations.js          # Typed confirmation logic
│       ├── config.js                 # Config file resolution
│       └── paths.js                  # ~/.snbatch directory paths
├── test/
│   ├── unit/                         # Version, manifest, reconcile, crypto, confirmations
│   ├── integration/                  # Full workflow with mock server
│   └── live/                         # Optional live instance smoke tests
├── .snbatchrc.example
├── package.json
├── README.md
├── LICENSE (MIT)
└── CONTRIBUTING.md
```
