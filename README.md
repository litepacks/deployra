# Deployra 🚀

Lightweight, platform-independent & language-agnostic VPS deployment orchestrator.

Deployra is 100% language and framework independent. Whether your application is built with **Node.js, Go, Python, Rust, PHP, Java, Ruby, Docker binaries, or static HTML**, Deployra automatically monitors remote Git repositories, queues background deployments via an embedded execution engine (**Workmatic**), manages systemd service lifecycles via **Unitup**, verifies application post-deploy readiness via **Ready-checker**, and executes automated rollbacks on failure.

---

## Architecture

```text
Remote Git repository
        ↓
Deployra watcher
        ↓
Deployment pipeline
        ↓
Systemd service
        ↓
Readiness verification
```

> [!NOTE]
> **Internal Execution Engines**: Deployra integrates `workmatic` (persistent SQLite job queue), `unitup` (systemd service manager), and `ready-checker` (application readiness engine) as internal implementation layers. Users **never** have to write package names like `workmatic`, `unitup`, or `ready-checker` in their configuration files.

---

## Features

- 🌐 **Language & Framework Agnostic**: Deploys any stack (Node.js, Go, Python, Rust, PHP, Java, Docker, Static HTML) without language-specific plugins.
- 🔄 **Provider-Independent Polling**: Uses lightweight `git ls-remote` for remote SHA change detection.
- ⚡ **Workmatic Engine Integration**: Persistent background job queue with concurrency locks (`1` per project by default) and configurable queue modes (`latest`, `fifo`, `reject`).
- 🛠 **Systemd Service Management**: Zero-downtime service restart and reload powered by Unitup.
- 🩺 **Comprehensive Readiness Verification**: Supports HTTP, HTTPS, TCP, command, process, and file checks in `all`, `any`, or `sequence` modes.
- ⏪ **Automated Rollback**: Reverts repository to previous successful commit SHA and restarts service on deployment failures.
- 🔐 **Security & Secret Masking**: Command execution with argument arrays (no shell injection risk) and automatic redaction of tokens/passwords from logs.
- 📦 **SQLite Persistence**: Stores projects, locks, deployment histories, and step metrics reliably.

---

## Installation

```bash
# Install via npm
npm install -g deployra

# Or clone and build
cd deployra
npm install
npm run build
npm link
```

---

## Quick Start

### 1. Initialize Sample Configuration

```bash
deployra init
```

This creates a `deployra.config.yaml` file in the current directory:

```yaml
project:
  name: api
  path: /var/www/api

source:
  remote: origin
  branch: main

watch:
  interval: 30s

deploy:
  concurrency: 1
  queueMode: latest
  dirtyWorkspace: reject
  timeout: 10m

  retry:
    attempts: 2
    backoff: 10s

  commands:
    install:
      - npm ci
    build:
      - npm run build

  service:
    name: api
    action: restart

  ready:
    url: http://127.0.0.1:3000/health
    timeout: 45s
    interval: 2s

  rollback:
    enabled: true
    on:
      - build-failure
      - service-failure
      - ready-failure
```

### 2. Register & Validate Project

```bash
deployra add deployra.config.yaml
deployra doctor
```

### 3. Start Watcher Daemon

```bash
deployra watch
```

---

## CLI Reference

| Command | Description |
| :--- | :--- |
| `deployra init [path]` | Generate a sample `deployra.config.yaml` file |
| `deployra add [configPath]` | Register a project configuration with Deployra |
| `deployra remove <app>` | Deregister a project from Deployra registry |
| `deployra list` | List all registered projects and SHA statuses |
| `deployra watch [app]` | Start long-running polling daemon |
| `deployra check [app]` | Perform a one-shot remote change check |
| `deployra deploy <app>` | Trigger a manual deployment |
| `deployra cancel <target>` | Cancel an active or queued deployment |
| `deployra status [app]` | View status summary of projects |
| `deployra stats [app]` | Display deployment metrics and success statistics |
| `deployra logs [app]` | View deployment step logs and errors |
| `deployra history <app>` | View past deployment history |
| `deployra doctor` | Run system diagnostics |
| `deployra service <action>` | Manage Deployra as a systemd service (`install\|start\|stop\|restart\|status\|uninstall`) |

---

## Configuration Reference

### `project`
- `name` (string, required): Unique project name.
- `path` (string, required): Absolute filesystem path to working tree.

### `source`
- `remote` (string, default: `origin`): Git remote name.
- `branch` (string, default: `main`): Target branch to track.

### `watch`
- `interval` (string/number, default: `30s`): Polling interval (e.g. `30s`, `1m`, `500ms`).

### `deploy`
- `strategy` (enum: `in-place` | `isolated`, default: `in-place`): Deployment workspace strategy.
- `workspacePath` (string, optional): Custom workspace directory for `isolated` strategy (defaults to `~/.deployra/workspaces/<project>`).
- `concurrency` (number, default: `1`): Concurrent deployment execution limit.
- `queueMode` (enum: `latest` | `fifo` | `reject`, default: `latest`): Queue behavior when new commits arrive.
- `dirtyWorkspace` (enum: `reject` | `reset` | `stash`, default: `reject`): Handling uncommitted workspace changes.
- `timeout` (string/number, default: `10m`): Maximum overall pipeline timeout.
- `retry.attempts` (number, default: `2`): Retry count for failed step commands.
- `retry.backoff` (string/number, default: `10s`): Delay between step retry attempts.
- `commands.install` (array of strings): Dependency installation shell commands.
- `commands.build` (array of strings): Application compilation/build shell commands.
- `service.name` (string): Unitup systemd service name (defaults to `project.name`).
- `service.action` (enum: `start` | `restart` | `reload` | `none`, default: `restart`): Action performed on service.
- `ready` (object): Post-deployment readiness check specifications.
- `rollback.enabled` (boolean, default: `true`): Auto-rollback trigger toggle.

---

## Concurrency & Queue Management

When a new deployment is triggered while another deployment is currently active, Deployra uses an embedded Workmatic job queue and SQLite project locking to guarantee safety:

1. **Project Locking (`acquire-lock`)**: Each deployment acquires an atomic project lock before executing workspace or git operations, preventing concurrent build conflicts.
2. **Execution Queue (`concurrency: 1`)**: Deployments for a project are queued and processed sequentially.
3. **Queue Modes (`deploy.queueMode`)**:
   - **`latest`** *(default)*: When a new commit is detected while a deployment is active, older pending/queued deployments are automatically cancelled and replaced by the newest commit.
   - **`fifo`**: All deployment requests are queued in First-In, First-Out order and executed one after another.
   - **`reject`**: If a deployment is currently running or queued, any incoming deployment requests are rejected immediately.
4. **SHA Deduplication**: Identical commit SHAs currently active or queued are skipped automatically to prevent redundant builds.

### Multi-Project Performance & Polling Safety

When monitoring dozens of projects simultaneously in a single daemon instance, Deployra incorporates built-in protections against thundering herd network spikes:

- **Initial Check Staggering**: Initial polling checks are staggered by a 250ms offset per project on startup, preventing burst network requests when monitoring multiple repositories.
- **Interval Desynchronization Jitter**: A randomized jitter (+0..500ms) is applied to recurring polling timers to desynchronize check cycles naturally over time.
- **Exponential Backoff on Errors**: Repositories encountering network or Git server failures automatically apply exponential backoff (up to 16x interval multiplier + random jitter) to prevent hammering failing remotes.

---

## Daemon & Service Management

To install Deployra daemon as a systemd user service:

```bash
deployra service install
deployra service start
deployra service status
```

---

## Security Best Practices

1. **Secret Masking**: Sensitive environment variables and secrets matching `KEY|TOKEN|SECRET|PASSWORD|AUTH` are automatically redacted from logs.
2. **Safe Command Execution**: Commands run with argument arrays (`safeExec`) to prevent shell injection vulnerabilities.
3. **Non-Root Execution**: Running Deployra directly as `root` is warned against. Dedicated deployment service accounts should be used.

---

## Troubleshooting

- **Doctor Check**: Run `deployra doctor` to verify Git, SQLite permissions, systemd access, and remote connectivity.
- **Inspect Logs**: Run `deployra logs <app>` to view step-level exit codes and tracebacks.
- **Reset DB**: SQLite database is located at `~/.deployra/deployra.db` (or custom path set via `DEPLOYRA_DB_PATH`).

---

## License

MIT © [litepacks](https://github.com/litepacks)
