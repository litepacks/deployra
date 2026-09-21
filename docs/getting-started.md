---
title: Getting Started
description: Installation, initial project setup, configuration, and running the Deployra daemon
order: 2
---

# Getting Started 🚀

Learn how to install Deployra, configure your first application repository, and run automated deployments on your server.

---

## 📥 Installation

Deployra requires **Node.js >= 20.0.0**. Install it globally using your preferred package manager:

```bash
# Using npm
npm install -g deployra

# Using pnpm
pnpm add -g deployra

# Using bun
bun add -g deployra
```

Verify your installation:

```bash
deployra --version
```

---

## 🛠️ Initializing a Project

Navigate to your application directory on your VPS server and run:

```bash
cd /var/www/my-app
deployra init
```

The interactive wizard inspects your repository, detects your Git remote and branch, scans for common package managers (`npm`, `pnpm`, `yarn`, `cargo`, `go`), and creates a production-ready `deployra.config.yaml` file:

```yaml
project:
  name: my-app
  path: /var/www/my-app

source:
  remote: origin
  branch: main

deploy:
  strategy: in-place
  commands:
    install:
      - npm ci
    build:
      - npm run build
  service:
    name: my-app
    action: restart
    type: unitup

watch:
  interval: 10s
```

---

## 🚀 Running Your First Deployment

Deployra supports both automated daemon execution and manual commands:

### 1. Manual Immediate Deployment

Trigger an immediate deployment with full step output:

```bash
deployra deploy my-app
```

To simulate a deployment without modifying production state or invoking shell commands:

```bash
deployra deploy my-app --dry-run
```

### 2. Checking Status and History

Inspect your deployments and active services:

```bash
# Show project status and active daemon state
deployra status

# View deployment history
deployra history my-app --limit 10

# Tail deployment logs in real time
deployra logs my-app --tail 50
```

---

## 🔄 Starting the Background Daemon

To continuously monitor your repository for new commits, start the background daemon:

```bash
# Foreground runner (ideal for systemd or tmux)
deployra up

# Alternatively, manage as a detached background service
deployra daemon start
deployra daemon status
deployra daemon stop
```

---

## 🐧 Running Deployra under Systemd

Deployra can run as a persistent systemd service on Linux VPS hosts. Run:

```bash
sudo deployra up --systemd
```

Or manually create `/etc/systemd/system/deployra.service`:

```ini
[Unit]
Description=Deployra Continuous Deployment Orchestrator
After=network.target

[Service]
Type=simple
User=deploy
ExecStart=/usr/local/bin/deployra up
Restart=always
RestartSec=5s
Environment=NODE_ENV=production
Environment=DEPLOYRA_DB_PATH=/var/lib/deployra/deployra.db

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now deployra
```
