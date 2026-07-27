# Gitship 🚢

Lightweight, platform-independent VPS deployment orchestrator.

Gitship automatically monitors remote Git repositories, queues background deployments via an embedded execution engine (**Workmatic**), manages systemd service lifecycles via **Unitup**, verifies application post-deploy readiness via **Ready-checker**, and executes automated rollbacks on failure.

---

## Architecture

```text
Remote Git repository
        ↓
Gitship watcher
        ↓
Deployment pipeline
        ↓
Systemd service
        ↓
Readiness verification
```

> [!NOTE]
> **Internal Execution Engines**: Gitship integrates `workmatic` (persistent SQLite job queue), `unitup` (systemd service manager), and `ready-checker` (application readiness engine) as internal implementation layers. Users **never** have to write package names like `workmatic`, `unitup`, or `ready-checker` in their configuration files.

---

## Features

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
# Clone and build
cd gitship
npm install
npm run build

# Link CLI globally (optional)
npm link
```

---

## Quick Start

### 1. Initialize Sample Configuration

```bash
gitship init
```

This creates a `gitship.config.yaml` file in the current directory:

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

### 2. Register Project

```bash
gitship add gitship.config.yaml
```

### 3. Run System Diagnostics

```bash
gitship doctor
```

### 4. Start Watcher Daemon

```bash
gitship watch
```

---

## CLI Reference

| Command | Description |
|---|---|
| `gitship init [path]` | Generate a sample `gitship.config.yaml` file |
| `gitship add [configPath]` | Register a project configuration with Gitship |
| `gitship remove <app>` | Deregister a project from Gitship registry |
| `gitship list` | List all registered projects and SHA statuses |
| `gitship watch [app]` | Start long-running polling daemon |
| `gitship check [app]` | Perform a one-shot remote change check |
| `gitship deploy <app>` | Trigger a manual deployment |
| `gitship cancel <target>` | Cancel an active or queued deployment |
| `gitship status [app]` | View status summary of projects |
| `gitship stats [app]` | Display deployment metrics and success statistics |
| `gitship logs [app]` | View deployment step logs and errors |
| `gitship history <app>` | View past deployment history |
| `gitship doctor` | Run system diagnostics |
| `gitship service <action>` | Manage Gitship as a systemd service (`install\|start\|stop\|restart\|status\|uninstall`) |

---

## Configuration Reference

### `project`
- `name` (string, required): Unique project name.
- `path` (string, required): Absolute filesystem path to working tree.

### `source`
- `remote` (string, default: `origin`): Git remote name.
- `branch` (string, default: `main`): Target branch to track.

### `watch`
- `interval` (duration, default: `30s`): Polling interval (`500ms`, `30s`, `5m`, `1h`).

### `deploy`
- `concurrency` (number, default: `1`): Max concurrent deployments for project.
- `queueMode` (`latest` \| `fifo` \| `reject`, default: `latest`): Queue behavior when new commit arrives during active deployment.
- `dirtyWorkspace` (`reject` \| `reset` \| `stash`, default: `reject`): Action when working tree has uncommitted local changes.
- `timeout` (duration, default: `10m`): Deployment pipeline timeout.
- `retry.attempts` (number, default: `2`): Command retry attempts.
- `retry.backoff` (duration, default: `10s`): Backoff delay between retries.
- `commands.install` (array of strings): Install commands executed sequentially.
- `commands.build` (array of strings): Build commands executed sequentially.
- `service.name` (string): Service name managed via Unitup systemd manager.
- `service.action` (`start` \| `restart` \| `reload` \| `none`, default: `restart`): Action performed post-build.
- `ready.url` (string, optional): Shorthand HTTP readiness check URL.
- `ready.timeout` (duration, default: `45s`): Readiness check timeout.
- `ready.interval` (duration, default: `2s`): Readiness check retry interval.
- `ready.mode` (`all` \| `any` \| `sequence`, default: `all`): Readiness evaluation mode.
- `ready.checks` (array): Advanced composite checks (`http`, `https`, `tcp`, `command`, `process`, `file`).
- `rollback.enabled` (boolean, default: `true`): Enable automated rollback on failure.
- `rollback.on` (array): Failures triggering rollback (`build-failure`, `service-failure`, `ready-failure`).

---

## Systemd Installation

To install Gitship daemon as a systemd user service:

```bash
gitship service install
gitship service start
gitship service status
```

---

## Security Best Practices

1. **No Shell Injection**: Commands are spawned using explicit argument arrays (`execFile`/`spawn`).
2. **Secret Redaction**: Environment secrets, bearer tokens, passwords, and private keys are automatically masked in log files.
3. **Non-Root Execution**: Running Gitship directly as `root` is warned against. Dedicated deployment service accounts should be used.
4. **Path Traversal Protection**: Project working tree paths are normalized and bounded.

---

## Troubleshooting

- **Doctor Check**: Run `gitship doctor` to verify Git, SQLite permissions, systemd access, and remote connectivity.
- **Inspect Logs**: Run `gitship logs <app>` to view step-level exit codes and tracebacks.
- **Reset DB**: SQLite database is located at `~/.gitship/gitship.db` (or custom path set via `GITSHIP_DB_PATH`).

---

## License

MIT © litepacks
