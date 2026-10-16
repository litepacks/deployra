# Changelog

All notable changes to Deployra will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.4.3] - 2026-10-16

### 🛡️ Daemon Reliability, Watcher Live-lock & Log Flooding Fixes
- **Watcher In-Flight Protection & Live-lock Prevention**:
  - Replaced `checkingProjects: Set<string>` with `Map<string, InFlightCheck>` tracking execution start time, timeout timer, and `AbortController`.
  - Added in-flight protection to `syncProjects()` so in-flight projects are never marked stalled or rescheduled with a 0ms thundering loop.
  - Implemented 45-second zombie timeout enforcement that aborts child processes, clears locks, and backs off gracefully.
  - Throttled repetitive "already in progress" logs to at most once per 5 minutes per project.
- **Log Level Filtering & Systemd Journal Rate Limiting**:
  - Added strict log level priority (`debug: 0, info: 1, warn: 2, error: 3, silent: 4`) to suppress high-frequency debug output in production.
  - Defaulted log level to `info` in systemd and daemon modes.
  - Added systemd journal rate-limiting directives (`LogLevelMax=info`, `LogRateLimitIntervalSec=10s`, `LogRateLimitBurst=200`, `LOG_LEVEL=info`) to generated service units.
- **Git Timeout Enforcement**:
  - Added default 30s timeout across all Git commands and wired `AbortSignal` into `checkRemoteHead` and `fetchBranch`.

### ⚡ Systemic Resource Leak & Reliability Hardening
1. **Cancelled Deployments Infinite Retry Fix**:
   - Explicitly handled `cancelled` deployments in `SourceWatcher` to prevent automated polling retries.
   - Updated `DeploymentRepository.countRecentFailures` to accurately include `cancelled` alongside failures.
2. **SQLite WAL Checkpointing & Automatic Compaction**:
   - Added `PRAGMA wal_checkpoint(TRUNCATE)` and `VACUUM` into `vacuumDatabase()`.
   - Wired `vacuumDatabase()` into the daemon's periodic auto-retention cycle to prevent SQLite disk bloat.
3. **Orphan Release Directory Cleanup**:
   - Added automatic purge of failed/cancelled `releases/<deploymentId>` directories when `current` symlink does not point to them.
4. **Step Output Truncation (Heap OOM Prevention)**:
   - Added `MAX_STEP_OUTPUT_CHARS = 250_000` (~250 KB) tail-preserving output truncation in `runStep` to prevent huge build outputs from exhausting Node.js heap memory or bloating SQLite.
5. **Fresh Git Lock Preservation**:
   - Added `maxAgeMs` parameter to `repairStaleLocks` and enforced a 15-second age threshold on lock contention to avoid wiping locks belonging to actively running Git processes.
6. **Systemd D-Bus Query Resilience**:
   - Marked transient systemctl/D-Bus errors as `subState: 'query_failed'` and guarded daemon watchdog against false positive service restart loops.
7. **Ghost Timer Prevention on Watcher Stop**:
   - Added `isStopped` lifecycle state guards in `SourceWatcher` to prevent lingering callbacks from reviving timers after `stop()`.

---

## [0.4.1] - 2026-09-21

### 📚 Documentation & Developer Experience
- **Docboot Documentation Site**:
  - Integrated **Docboot v0.4.0** with the `ocean` theme preset, local client search, and GitHub source links.
  - Authored 10 comprehensive documentation guides in `docs/`:
    - `docs/index.md`: Architecture overview, core highlights, and system workflow.
    - `docs/getting-started.md`: Installation, interactive setup (`deployra init`), and systemd daemon service.
    - `docs/architecture.md`: Deep dive into Watcher, Workmatic Queue, Execution Pipeline, SQLite State, and Watchdog subsystems.
    - `docs/configuration.md`: Full `deployra.config.yaml` schema, environment overrides (`DEPLOYRA_ENV`), and variable expansion.
    - `docs/deployment-strategies.md`: Detailed guide to `in-place`, `isolated`, `release`, and `zero-downtime` strategies.
    - `docs/zero-downtime.md`: Unitup generation switching, canary traffic routing, and instant rollback.
    - `docs/cli.md`: Comprehensive reference for all 15 CLI commands with usage examples.
    - `docs/webhooks.md`: Built-in HTTP webhook receiver with GitHub HMAC-SHA256 and GitLab token verification.
    - `docs/self-repair.md`: Autonomous watchdog, stale lock auto-recovery, and process group management.
    - `docs/benchmarks.md`: SoftScope profiling metrics, caching mechanisms, and performance results.
  - Added dedicated documentation scripts to `package.json`: `docs:dev`, `docs:build`, `docs:serve`, and `docs:doctor`.
  - Verified documentation health via `docboot doctor` (10 pages, 65 internal links, 0 broken links).

### 🚀 CI / CD & Automation
- **Litepacks Release Pipeline**:
  - Added `.github/workflows/release.yml` utilizing the centralized `litepacks/.github/.github/workflows/npm-release.yml@main` workflow.
  - Automated tag-driven releases (`v*`) with pre-flight version validation, lint checks, typecheck validation, test suite execution, production bundling (`tsup`), docboot gate (`run-docboot: auto`), dry-run pack validation, NPM trusted publishing with provenance, and GitHub Release generation.
- **GitHub Pages Continuous Deployment**:
  - Added `.github/workflows/docs.yml` to automatically build and deploy the documentation site (`dist-docs`) to GitHub Pages on every push to `main`.
  - Removed deprecated legacy workflows (`npm-publish.yml` and `static.yml`).

### 📦 Package & Metadata
- Added `repository`, `bugs`, and `homepage` metadata fields to `package.json`.
- Added `typecheck` script (`tsc --noEmit`) to `package.json` for CI validation.

---

## [0.4.0] - 2026-09-20

### 🚦 Zero-Downtime & Canary Deployments
- **Unitup v0.3.0 Integration**:
  - Upgraded `unitup` dependency to `^0.3.0` introducing generation-based process supervision and HTTP router traffic shifting.
  - Added `strategy: zero-downtime` with public entry port routing (`deploy.port`) and graceful connection draining (`deploy.drainTimeout`).
  - **Canary Releases**: Added canary traffic weighting support (`deployra deploy --canary --weight 20`) to test new commits with a fraction of live traffic before full cutover.
  - **Canary Promotion**: Added `deployra promote [projectName]` CLI command to promote active canary generations to 100% traffic.
  - **Zero-Downtime Rollback**: Instant generation rollback via Unitup without modifying unaffected services.

### ⚡ Performance & Profiling Optimizations (SoftScope Profiled)
- **Hot Path Prepared Statement Caching**:
  - Migrated state repository (`project_locks`) and deployment repository queries to global `getPreparedStatement` cache.
  - 100 complete lock acquire/release cycles execute in **12.67ms**.
- **Lightweight Step Cancellation & Status Checks**:
  - Replaced heavy `getDeployment` hydration inside `runStep` with `getDeploymentStatus` and `getDeploymentStartedAt`.
  - Completely eliminated 15,000 redundant `stepRows.map` allocations per 100 deployment runs.
- **Watcher Disk I/O & Config Caching**:
  - Added file `mtimeMs` cache to `SourceWatcher` to skip re-reading and parsing `deployra.config.yaml` on every 5s polling cycle (<5µs per check).
  - Replaced full deployment fetches with lightweight `countRecentFailures` and `getActiveDeploymentSummaries` queries.
- **Reactive Git Lock Recovery**:
  - Removed proactive synchronous disk checks before every Git CLI operation; converted to purely reactive self-repair on error contention in `execGit`.
- **Subprocess Environment Optimization**:
  - Optimized `safeExec` to pass `process.env` directly when no custom variables are specified, eliminating redundant shallow-cloning of 100+ environment variables.
- **High-Throughput Secret Redaction**:
  - Optimized `maskSecrets` with a single compiled `COMBINED_SECRET_PATTERN` regular expression, processing 20,000 log lines in **21.08ms** (+54% faster).
- **SQLite Index Optimization**:
  - Added composite index `idx_deployments_proj_status ON deployments(project_name, status, created_at DESC)`.

### 🔄 Dependencies
- Upgraded `workmatic` to `^1.2.0` with SQLite WAL mode and persistent lease-based job claim.

---

## [0.3.0] - 2026-09-19

### 🛡️ Enterprise Features & Self-Repair
- **Autonomous Watchdog Engine**:
  - Added background watchdog cycle to prune abandoned SQLite locks, clean timed-out deployments, and auto-heal crashed services.
  - Added automated failed deployment retries with exponential backoff and cooldown.
- **Clean Subprocess Termination**:
  - Implemented POSIX process group termination (`killProcessTree`) to eliminate orphaned child processes.
- **Symlink Release Strategy**:
  - Added `strategy: release` with timestamped release folders, atomic symlinks, and automatic release pruning (`releasesToKeep`).
- **Webhooks & Multi-Channel Alerting**:
  - Added built-in HTTP webhook receiver with GitHub HMAC-SHA256 and GitLab secret token verification.
  - Added notifications for Slack, Discord, Telegram, and generic HTTP webhooks.
