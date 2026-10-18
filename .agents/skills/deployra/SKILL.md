---
name: deployra
description: >-
  Comprehensive guide and runbook for Deployra, the lightweight, language-agnostic VPS deployment orchestrator.
  Use when configuring deployra.config.yaml, setting up deployment strategies (in-place, isolated, release, zero-downtime),
  managing canary traffic shifting and promotions, configuring systemd services via Unitup, defining post-deploy readiness checks
  (HTTP, TCP, command, process, file), setting up GitHub/GitLab webhooks, configuring multi-channel notifications
  (Slack, Discord, Telegram, webhooks), troubleshooting deployments or rollbacks, or using the Deployra programmatic TypeScript API.
---

# Deployra: Definitive Runbook & Developer Guide

Deployra is a lightweight, platform-independent, and language-agnostic VPS deployment orchestrator for Node.js, Go, Python, Rust, PHP, Java, Ruby, Docker, and static workloads. It monitors remote Git repositories (via polling and webhooks), queues background deployments in a persistent SQLite job engine (**Workmatic**), manages systemd services and zero-downtime HTTP generation switching (**Unitup**), verifies post-deploy readiness (**Ready-checker**), and executes automated rollbacks on failure.

---

## 🏗️ 1. Architecture & Internal Engines

Deployra composes three specialized engines under a unified configuration and CLI:

```text
Git Poller / Webhook Server ──► Change detection (git ls-remote with jitter/backoff + HTTP HMAC webhooks)
Workmatic (SQLite Queue)    ──► Persistent job queue, SHA deduplication, project locks & queue policies
DeploymentPipelineRunner    ──► Strategy execution (in-place, isolated, release, zero-downtime)
Unitup                      ──► Systemd user service manager, zero-downtime proxy router & canary splitter
Ready-checker               ──► Post-deploy health verification (HTTP/S, TCP, Process, Command, File)
RollbackManager             ──► Automated git SHA reset, symlink swap, or router generation revert
Self-Repair Watchdog        ──► Stale lock eviction, .git/index.lock recovery & crashed service healing
```

---

## ⚡ 2. Quick Reference & CLI Commands

| Command | Purpose | Key Options |
| :--- | :--- | :--- |
| `deployra init [path]` | Scaffold a sample `deployra.config.yaml` file | `[path]` |
| `deployra add [configPath]` | Register a project configuration in the SQLite registry | `-e, --env <name>` |
| `deployra remove [projectName]` | Remove project from registry and stop its systemd service | `[projectName]` |
| `deployra list` (`ls`) | List all registered projects, active SHAs, and strategies | — |
| `deployra watch [projectName]` | Start long-running polling & webhook daemon | `-d, --dry-run`, `-c, --concurrency <n>`, `-p, --webhook-port <port>` |
| `deployra check [projectName]` | Perform a one-shot remote Git SHA check | `[projectName]` |
| `deployra deploy [projectName]` | Trigger a manual deployment | `-e, --env <name>`, `-d, --dry-run`, `-i, --inline`, `--canary`, `--weight <pct>` |
| `deployra promote [projectName]` | Promote active canary generation to 100% primary traffic | `[projectName]` |
| `deployra rollback [projectName]` | Rollback to the previous or a specific successful deployment | `-t, --to <deploymentId\|sha>` |
| `deployra cancel [target]` | Cancel an active or queued deployment by project or ID | `[target]` |
| `deployra status [projectName]` | Show status summary or live real-time TUI dashboard | `-w, --watch`, `-i, --interval <ms>` |
| `deployra stats [projectName]` | Show deployment metrics, success rates, and step durations | `[projectName]` |
| `deployra logs [projectName]` | Inspect deployment pipeline step logs (`-a, --app` for app logs) | `-f, --follow`, `-d, --deployment <id>`, `-s, --step <name>`, `-a, --app`, `--format <pretty\|json\|jsonl>` |
| `deployra app-logs [project]` | View or stream live Unitup runtime application/service logs (`applogs`, `service-logs`) | `-f, --follow`, `-n, --lines <n>`, `--since <t>`, `--until <t>`, `-g, --grep <pat>`, `--stdout`, `--stderr`, `-c, --cat`, `--json` |
| `deployra history [projectName]` | View historical deployments for a project | `-l, --limit <number>` (default: `10`) |
| `deployra clean [projectName]` | Prune old deployment logs/history and `VACUUM` SQLite DB | `-k, --keep <n>` (default: `50`), `-d, --days <n>`, `--no-vacuum` |
| `deployra notify-test [project]` | Send a test alert to all configured notification channels | `[projectName]` |
| `deployra doctor [configPath]` | Run system diagnostics (Git, SQLite, systemd, disk, network) | `[configPath]` |
| `deployra service <action>` | Manage Deployra daemon systemd user service | `install \| start \| stop \| restart \| status \| logs \| uninstall` |
| `deployra upgrade` | Check for and install the latest Deployra CLI version | `-c, --check`, `-f, --force` |
| `deployra uninstall` | Uninstall Deployra daemon service and local state | `-k, --keep-data`, `-p, --purge`, `-g, --global` |

---

## 📋 3. Configuration Reference (`deployra.config.yaml`)

Deployra automatically discovers `.deployra.json`, `deployra.json`, `deployra.config.yaml`, `deployra.config.yml`, or `deployra.config.json` in the working directory, `~/.config/deployra/config.yaml`, or `/etc/deployra/config.yaml`.

### Full Production Configuration Example

```yaml
project:
  name: api-service
  path: /srv/api-service

source:
  remote: origin
  branch: main

watch:
  interval: 30s # Supports ms, s, m, h (e.g., 500ms, 30s, 5m)

deploy:
  strategy: zero-downtime # in-place | isolated | release | zero-downtime
  workspacePath: /srv/.deployra/workspaces/api-service # Optional custom sandbox/release root
  releasesToKeep: 5       # Used when strategy: release
  concurrency: 1
  queueMode: latest       # latest | fifo | reject
  dirtyWorkspace: reject  # reject | reset | stash
  timeout: 10m

  retry:
    attempts: 2
    backoff: 10s

  envFile: .env.production
  env:
    NODE_ENV: production
    APP_SECRET: $APP_SECRET # Interpolates from host environment

  preflight:
    diskCheck: true
    minDiskFreeMb: 512
    maxDiskUsagePercent: 95

  commands:
    install:
      - npm ci --omit=dev
    build:
      - npm run build
    migrate: # Custom command phases are supported alongside install & build
      - npm run db:migrate

  # Zero-downtime & Canary settings
  port: 8080
  drainTimeout: 15s
  canary:
    enabled: false
    weight: 10% # 0.1 or 10%

  service:
    name: api-service
    action: restart # start | restart | reload | none
    stopBeforeBuild: false
    command: node dist/index.js
    memoryMax: 512M
    memoryHigh: 384M
    cpuQuota: 80%
    restartSec: 5s

  ready:
    url: http://127.0.0.1:8080/health # Shorthand HTTP/HTTPS 200 check
    timeout: 45s
    interval: 2s
    mode: all # all | any | sequence
    checks:
      - type: http
        url: http://127.0.0.1:8080/health
        expect:
          status: 200
          bodyIncludes: '"status":"ok"'
      - type: tcp
        host: 127.0.0.1
        port: 8080

  rollback:
    enabled: true
    on:
      - build-failure
      - service-failure
      - ready-failure

webhook:
  enabled: true
  secret: $DEPLOYRA_WEBHOOK_SECRET
  branch: main
  allowedIps:
    - 140.82.112.0/20 # GitHub Webhook CIDR example
    - 127.0.0.1
  trustProxy: true

notifications:
  events: [success, failure, rollback]
  slack:
    url: $SLACK_WEBHOOK_URL
  discord:
    url: $DISCORD_WEBHOOK_URL
  telegram:
    token: $TELEGRAM_BOT_TOKEN
    chatId: "-100123456789"
  webhook:
    url: https://ops.example.com/hooks/deployra
    headers:
      Authorization: Bearer $OPS_HOOK_TOKEN

environments:
  staging:
    source:
      branch: develop
    deploy:
      port: 8081
      env:
        NODE_ENV: staging
```

---

## 🚀 4. Deployment Strategies

Choose `deploy.strategy` based on your application runtime and uptime requirements:

| Strategy | Mechanism | Rollback Behavior | Best For |
| :--- | :--- | :--- | :--- |
| **`in-place`** *(default)* | Runs `git fetch` & `git reset --hard <sha>` directly in `project.path`, executes `commands`, and restarts the service. | Resets working tree back to `previousSha`, re-runs build, and restarts service. | Simple services, background workers, low-memory VPS instances. |
| **`isolated`** | Fetches and runs build commands in an isolated `workspacePath` sandbox, then syncs built artifacts to `project.path` before restarting. | Resets live tree to `previousSha` and restarts service. | Heavy compilation workloads where live files must not see partial build states. |
| **`release`** | Clones each deployment into `workspacePath/releases/<id>`, runs build, and atomically flips the `workspacePath/current` symlink. Prunes older releases beyond `releasesToKeep`. | Atomically re-points the `current` symlink to the previous release directory and restarts service (no rebuild required). | Web apps, PHP/Ruby/Node servers, static sites needing instant atomic rollbacks. |
| **`zero-downtime`** | Spawns a new application generation on a dynamic internal loopback port via **Unitup**, verifies readiness, atomically switches the public HTTP router (`deploy.port`), drains in-flight connections (`drainTimeout`), and retires the old generation. | Immediately switches Unitup HTTP proxy routing back to the previous generation in sub-milliseconds. | High-traffic HTTP APIs and web services requiring 0 dropped requests. |

---

## 🚦 5. Zero-Downtime & Canary Workflows

### How Zero-Downtime Port Routing Works
1. **Public Entry Port (`deploy.port`)**: Unitup's HTTP reverse proxy listens on `deploy.port` (e.g., `8080`).
2. **Internal Generation Spawning**: Each generation is spawned with an isolated internal `PORT` environment variable (e.g., `127.0.0.1:4001`, `127.0.0.1:4002`). Your application **must** listen on `process.env.PORT`.
3. **Readiness Verification**: Deployra probes the new generation before any public traffic is routed to it.
4. **Atomic Cutover & Connection Draining**: Once healthy, traffic shifts atomically to the new generation while the old generation drains active requests for `drainTimeout` (default `10s`).

### Canary Traffic Splitting
Deploy a new commit as a canary generation receiving a controlled percentage of live traffic:

```bash
# 1. Start canary generation receiving 15% of public traffic
deployra deploy api-service --canary --weight 15%

# 2. Monitor generation health, PIDs, and traffic split
deployra status api-service --watch

# 3. Promote canary to 100% traffic (drains and retires old generation)
deployra promote api-service

# Or abort and revert 100% traffic back to the primary generation:
deployra rollback api-service
```

---

## 🩺 6. Post-Deploy Readiness Checks (`deploy.ready`)

Deployra uses **Ready-checker** to verify service health after deployment. Supports 5 check types and 3 evaluation modes (`all`, `any`, `sequence`):

```yaml
deploy:
  ready:
    timeout: 45s   # Must be strictly greater than interval
    interval: 2s
    mode: all      # 'all' (parallel) | 'any' (first pass) | 'sequence' (ordered)
    checks:
      # 1. HTTP / HTTPS Check
      - type: http
        url: http://127.0.0.1:8080/healthz
        expect:
          status: 200
          headers:
            content-type: application/json
          bodyIncludes: '"ok":true'

      # 2. TCP Socket Check
      - type: tcp
        host: 127.0.0.1
        port: 6379

      # 3. Shell Command Check
      - type: command
        command: pg_isready -h 127.0.0.1 -p 5432
        expectedExitCode: 0

      # 4. Process Check
      - type: process
        name: worker-daemon
        pidFile: /run/worker.pid

      # 5. File Existence Check
      - type: file
        path: /tmp/app.ready
```

---

## 🪝 7. Webhooks & Remote Triggers

When `deployra watch` is running, Deployra starts an embedded HTTP Webhook Server (default port `3939`, configurable via `--webhook-port` or `DEPLOYRA_WEBHOOK_PORT`).

### Endpoints
- `POST /webhook/:projectName` or `POST /api/v1/webhook/:projectName`
- `GET /health` or `GET /api/v1/health` (returns `200 {"status":"ok","service":"deployra-webhook"}`)

### Supported Signature & Token Headers
When `webhook.secret` (or `DEPLOYRA_WEBHOOK_SECRET`) is configured, Deployra enforces constant-time (`crypto.timingSafeEqual`) verification:
1. **GitHub**: `X-Hub-Signature-256: sha256=<hex>` (HMAC-SHA256 of raw request body; also responds `200 {"message":"pong"}` to `X-GitHub-Event: ping`).
2. **GitLab**: `X-Gitlab-Token: <secret>`.
3. **Generic / CI**: `Authorization: Bearer <secret>` or `X-Webhook-Secret: <secret>`.

### Security Controls
- **IP Allowlisting**: Set `webhook.allowedIps: ["140.82.112.0/20", "192.168.1.10"]` to restrict webhook callers by IPv4/IPv6 address or CIDR range.
- **Reverse Proxy Support**: Set `webhook.trustProxy: true` when running behind Nginx, Caddy, or Cloudflare to evaluate `X-Forwarded-For`.
- **Body Size Limit**: Requests exceeding 5 MB are automatically rejected with HTTP `413 Payload Too Large`.

---

## 🔄 8. Concurrency, Queue Modes & Self-Repair

### Queue Policies (`deploy.queueMode`)
- **`latest`** *(default)*: If a deployment is currently running and multiple new commits arrive, older queued jobs are superseded so only the latest commit deploys next.
- **`fifo`**: Every triggered commit is queued and deployed in strict First-In, First-Out order.
- **`reject`**: Incoming triggers are dropped if a deployment is already active or queued for the project.

### Autonomous Self-Repair Watchdog (Every 30s)
1. **Stale SQLite Lock Eviction**: Evicts locks in `project_locks` held by dead/crashed workers after 5 minutes.
2. **Timed-Out Job Cleanup**: Marks hung deployments as `failed` and kills orphaned process trees via negative PID group (`kill(-pid, 'SIGTERM')` -> `SIGKILL`).
3. **Reactive Git Lock Recovery**: Automatically detects `.git/index.lock` or `FETCH_HEAD.lock` errors during Git operations, removes stale lock files, and retries.
4. **Crashed Service Auto-Healing**: Polls `UnitupAdapter.status(serviceName)` for projects with a prior successful deployment; if a service is `inactive` or `failed` outside of an active deployment, Deployra restarts it automatically.
5. **Auto-Retention & Compaction**: Automatically prunes historical deployments (`keepCount: 100`, `maxAgeDays: 30`) and runs `VACUUM` on `~/.deployra/deployra.db`.

---

## 💻 9. Programmatic TypeScript API

Deployra exports its core classes and utilities for custom orchestration scripts or CI/CD runners:

```typescript
import {
  DeployraDaemon,
  DeploymentPipelineRunner,
  RollbackManager,
  WorkmaticEngine,
  SourceWatcher,
  loadConfig,
  normalizeAndValidateConfig,
  ProjectRepository,
  DeploymentRepository,
} from 'deployra';

// 1. Load and validate configuration with optional environment profile
const config = loadConfig('./deployra.config.yaml', 'production');

// 2. Register project in SQLite storage
const projectRepo = new ProjectRepository();
projectRepo.upsertProject({
  name: config.project.name,
  path: config.project.path,
  config,
});

// 3. Run an inline deployment pipeline directly
const runner = new DeploymentPipelineRunner();
await runner.run({
  deploymentId: 'dep_manual_01',
  projectName: config.project.name,
  trigger: 'manual',
  targetSha: 'HEAD',
  dryRun: false,
});

// 4. Or start the full background daemon (Watcher + Workmatic Queue + Webhook Server + Watchdog)
const daemon = new DeployraDaemon({
  concurrency: 4,
  webhookPort: 3939,
  enableWebhook: true,
});
await daemon.start();
```

---

## 🛠️ 10. Troubleshooting & Diagnostics Runbook

| Symptom / Error | Root Cause | Resolution |
| :--- | :--- | :--- |
| `ConfigValidationError: deploy.ready.interval must be shorter than deploy.ready.timeout` | Readiness check interval is `>=` timeout. | Ensure `deploy.ready.interval` (e.g., `2s`) is strictly less than `deploy.ready.timeout` (e.g., `45s`). |
| `DirtyWorkspaceError` during deployment | Uncommitted local modifications exist in `project.path`. | Set `deploy.dirtyWorkspace: stash` or `reset` in config, or clean the target repo manually. |
| Zero-downtime deployment times out on readiness | Application hardcodes its port instead of listening on `process.env.PORT`. | Ensure the app binds to `process.env.PORT` so Unitup can spawn generations on dynamic internal ports while routing public traffic from `deploy.port`. |
| Webhook returns `401 Invalid webhook signature` | Mismatched secret or missing `$VAR` export in daemon environment. | Verify `webhook.secret` / `DEPLOYRA_WEBHOOK_SECRET` matches the GitHub/GitLab secret and restart daemon. |
| Webhook returns `403 Access denied: Client IP ...` | Reverse proxy IP seen instead of caller IP. | Enable `webhook.trustProxy: true` if behind Nginx/Caddy, or add proxy IP to `webhook.allowedIps`. |
| Pre-flight fails with disk space error | Target disk usage exceeds `maxDiskUsagePercent` (default `98%`) or `minDiskFreeMb`. | Run `deployra clean --keep 20` to prune logs/releases, free disk space, or adjust `deploy.preflight`. |
| Inspecting SQLite state or resetting environment | Corrupted local test state or custom DB location needed. | Default DB is `~/.deployra/deployra.db`. Override path via `DEPLOYRA_DB_PATH=/custom/path.db`. Run `deployra doctor` to verify environment health. |
