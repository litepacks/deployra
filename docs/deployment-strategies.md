---
title: Deployment Strategies
description: In-depth guide to in-place, isolated, release, and zero-downtime deployment patterns
order: 5
---

# Deployment Strategies 🔄

Deployra provides four purpose-built deployment strategies suited for different operational requirements, application types, and downtime tolerances.

---

## 1. `in-place` Strategy

The fastest and most resource-efficient strategy. The working directory is updated directly:

```yaml
deploy:
  strategy: in-place
```

### Execution Flow:
1. `git fetch origin <branch>`
2. `git reset --hard <target_sha>`
3. Run `install` & `build` commands directly inside repository root.
4. Restart service via systemd or Unitup.

### Best Used For:
- Development environments and staging VPS nodes.
- Applications with negligible downtime sensitivity during service restart.
- Servers with constrained disk space where duplicating build artifacts is prohibitive.

---

## 2. `isolated` Strategy

Builds your application in a secluded directory before updating the live service:

```yaml
deploy:
  strategy: isolated
```

### Execution Flow:
1. Copies working files or checks out commit to temporary directory `.deployra-isolated/<build_id>/`.
2. Runs `npm ci` and `npm run build` inside isolated directory.
3. If build succeeds, atomically replaces workspace contents.
4. If build fails, working directory remains untouched.

### Best Used For:
- Heavy compilation steps (e.g. Next.js, Rust, Go, TypeScript) that might fail and break live source code.
- Ensuring zero broken dependencies in `node_modules` during long build runs.

---

## 3. `release` Strategy

Capistrano / Deployer style release management using timestamped directories and atomic symlinks:

```yaml
deploy:
  strategy: release
  releasesToKeep: 5
  sharedPaths:
    - .env
    - storage
    - uploads
```

### Directory Structure:
```
/var/www/my-app/
├── current -> releases/20260921175000/   # Atomic symlink pointing to active release
├── releases/
│   ├── 20260921170000/
│   ├── 20260921173000/
│   └── 20260921175000/                   # Latest release
└── shared/
    ├── .env
    └── uploads/
```

### Execution Flow:
1. Creates new release directory `releases/<timestamp>/`.
2. Symlinks configured `sharedPaths` from `shared/` into release folder.
3. Runs install and build commands.
4. Atomically shifts symlink `current` to new release.
5. Prunes oldest releases exceeding `releasesToKeep`.

---

## 4. `zero-downtime` Strategy

Native generation switching and HTTP reverse-proxy traffic shifting powered by **Unitup 0.3.0**:

```yaml
deploy:
  strategy: zero-downtime
  port: 8080            # Public ingress port
  drainTimeout: 15s     # Grace period before stopping retired generation
```

See the [Zero-Downtime & Canary](./zero-downtime.md) guide for an end-to-end breakdown.
