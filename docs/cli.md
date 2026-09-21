---
title: CLI Reference
description: Complete command-line reference for Deployra management, deployments, and troubleshooting
order: 7
---

# CLI Reference 💻

Deployra provides an extensive command-line interface for orchestrating deployments, monitoring daemons, and diagnosing issues.

---

## 📌 Command Summary

| Command | Description |
| :--- | :--- |
| `deployra init` | Initialize a new `deployra.config.yaml` with interactive guidance |
| `deployra up` | Start watcher and deployment daemon in foreground |
| `deployra daemon <start\|stop\|restart\|status>` | Manage background daemon process |
| `deployra status [project]` | Show live status of projects, queue, and service generations |
| `deployra deploy [project]` | Trigger a manual deployment |
| `deployra rollback [project]` | Rollback to last successful SHA or previous generation |
| `deployra promote [project]` | Promote active canary generation to 100% traffic |
| `deployra cancel <id\|project>` | Cancel a queued or running deployment |
| `deployra history [project]` | List past deployment records and durations |
| `deployra logs [project]` | Stream or tail deployment execution logs |
| `deployra clean [project]` | Prune old release folders and archived deployments |
| `deployra repair [project]` | Self-repair stale Git locks and orphan SQLite locks |
| `deployra stats [project]` | View detailed execution durations and metrics |
| `deployra upgrade` | Self-upgrade Deployra CLI to latest version |
| `deployra uninstall` | Cleanly remove Deployra configuration and data directories |

---

## 📖 Command Details

### `deployra init`
Scans the current directory, detects Git repository parameters and runtime languages, and scaffolds `deployra.config.yaml`.

```bash
deployra init
```

### `deployra up`
Starts the daemon in the foreground. Ideal for Docker containers, systemd service units, or screen/tmux sessions:

```bash
deployra up [--dry-run] [--project <name>]
```

### `deployra deploy`
Triggers an immediate deployment of the target project or current working directory:

```bash
# Basic deployment
deployra deploy my-app

# Dry-run simulation (no commands executed, no state mutated)
deployra deploy my-app --dry-run

# Deploy specific commit SHA
deployra deploy my-app --sha 8f3c1b0

# Canary deployment with traffic weight
deployra deploy my-app --canary --weight 25
```

### `deployra promote`
Promotes an active canary generation to 100% traffic:

```bash
deployra promote my-app
```

### `deployra rollback`
Rolls back to the previous successful commit or generation:

```bash
deployra rollback my-app
```

### `deployra cancel`
Cancels an ongoing or queued deployment:

```bash
# Cancel by deployment ID
deployra cancel dep_12345

# Cancel current active deployment for project
deployra cancel my-app
```

### `deployra logs`
Streams real-time deployment logs:

```bash
deployra logs my-app --tail 100 --follow
```

### `deployra repair`
Manually triggers the self-repair engine:
- Removes stale `.git/*.lock` files.
- Evicts abandoned project locks in SQLite.
- Heals stalled timer loops.

```bash
deployra repair
```
