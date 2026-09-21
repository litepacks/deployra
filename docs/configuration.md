---
title: Configuration Reference
description: Complete YAML configuration reference for Deployra projects and environments
order: 4
---

# Configuration Reference 📄

Deployra is configured via `deployra.config.yaml` located in the root of your application repository (or pointed to via `--config`).

---

## 📋 Complete Schema Overview

```yaml
project:
  name: my-app                  # Unique alphanumeric identifier
  path: /var/www/my-app          # Root working directory of project

source:
  remote: origin                # Git remote name (default: origin)
  branch: main                  # Target Git branch (default: main)

deploy:
  strategy: zero-downtime        # 'in-place' | 'isolated' | 'release' | 'zero-downtime'
  queueMode: latest             # 'latest' | 'fifo' | 'reject'
  
  # Directory settings
  workspacePath: /var/www/my-app # Used for isolated or release builds
  releasesToKeep: 5              # Retain last N releases (for release strategy)
  sharedPaths:                   # Symlinked shared folders & files across releases
    - .env
    - uploads
    - storage

  # Zero-downtime routing (Unitup 0.3.0)
  port: 8080                    # Public entry port for reverse proxy routing
  drainTimeout: 15s             # Grace period for connection draining
  canary:
    enabled: false              # Default canary state
    weight: 10%                 # Initial traffic split percentage

  # Lifecycle execution commands
  commands:
    install:
      - npm ci
    build:
      - npm run build
    migrate:
      - npm run db:migrate

  # Hooks
  hooks:
    beforeDeploy:
      - echo "Starting deployment"
    afterDeploy:
      - echo "Deployment finished successfully"
    onError:
      - echo "Deployment failed"

  # Process / Service management
  service:
    name: my-app
    action: restart             # 'restart' | 'reload' | 'start' | 'none'
    type: unitup                # 'unitup' | 'systemd'

  # Health & Readiness checking (ready-checker)
  readyCheck:
    endpoint: http://127.0.0.1:8080/health
    expectedStatus: 200
    timeout: 30s
    interval: 1s
    retries: 5

watch:
  interval: 10s                 # Git polling frequency
  enabled: true

notifications:
  slack:
    webhookUrl: https://hooks.slack.com/services/...
    onSuccess: true
    onFailure: true
  discord:
    webhookUrl: https://discord.com/api/webhooks/...
    onFailure: true
  telegram:
    botToken: 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
    chatId: "-1001234567890"
  webhook:
    url: https://ops.example.com/alerts
    headers:
      Authorization: Bearer my-secret-token

environments:
  staging:
    source:
      branch: develop
    deploy:
      service:
        name: my-app-staging
  production:
    deploy:
      readyCheck:
        timeout: 45s
```

---

## 🌐 Environment Overrides

Deployra natively supports multi-environment overrides. When invoking commands or running the daemon:

```bash
DEPLOYRA_ENV=staging deployra deploy my-app
```

Deployra deep-merges the `environments[envName]` section over your top-level configuration values cleanly.

---

## 🔒 Environment Variable Expansion

You can reference host environment variables inside `deployra.config.yaml` using standard `${VAR}` or `${VAR:-default}` syntax:

```yaml
notifications:
  slack:
    webhookUrl: ${SLACK_WEBHOOK_URL}
  telegram:
    botToken: ${TELEGRAM_BOT_TOKEN:-missing_token}
```
