---
title: Self-Repair & Reliability
description: Autonomous self-repair watchdog, stale lock recovery, and process tree termination
order: 9
---

# Self-Repair & Reliability 🛡️

Production VPS servers face real-world disruptions: abrupt server reboots, kernel OOM-killer invocations, network hiccups, and corrupted Git lock files. Deployra is designed with multi-layer defensive programming to recover autonomously without requiring manual human intervention.

---

## 🐶 Autonomous Watchdog Engine

Every 30 seconds, Deployra's Watchdog runs an autonomous self-repair cycle:

### 1. Stale SQLite Lock Pruning
When a deployment starts, Deployra writes a lock record to `project_locks`. If the node power-cycles mid-deployment, standard runners remain locked forever. Deployra's Watchdog compares active running worker IDs in Workmatic against `project_locks`:
- Locks held by dead or non-running deployment IDs are evicted automatically.
- Prevents deployment deadlocks following machine restarts.

### 2. Timed-Out Deployment Recovery
If a custom build command hangs indefinitely, Deployra marks stale deployments as `failed` after their timeout expires and terminates any lingering subprocesses.

### 3. Service Liveness Auto-Healing
For registered services managed by Unitup or systemd, the Watchdog checks runtime status:
- If a service has crashed (`inactive` or `failed`) and no active deployment is currently in progress, Deployra triggers an automated recovery restart.

### 4. Auto-Retention Pruning
Archived deployments, step logs, and old release folders are kept within healthy limits (`keepCount: 100`, `maxAgeDays: 30`) to prevent disk bloat.

---

## 🔒 Reactive Git Lock Recovery

Standard Git CLI operations abort with fatal errors if `.git/index.lock` or `.git/FETCH_HEAD.lock` remain on disk after a crash.

Deployra handles this reactively inside `GitClient`:
```typescript
try {
  return await safeExec('git', args, { cwd, ...options });
} catch (err) {
  if (err.message.includes('index.lock') || err.message.includes('Another git process seems to be running')) {
    logger.warn(`Detected Git lock contention in '${cwd}'. Attempting automated self-repair...`);
    this.repairStaleLocks(cwd);
    return await safeExec('git', args, { cwd, ...options });
  }
  throw err;
}
```
If a stale lock is encountered, Deployra logs the incident, purges the orphaned lock file, and automatically retries the command.

---

## 🌲 Clean POSIX Process Tree Termination

When a command times out or is cancelled, simply terminating the top-level PID often leaves orphaned children running in the background (e.g. `npm` killed but `node server.js` still listening on the port).

Deployra spawns subprocesses in isolated process groups:
```typescript
// Sends SIGTERM to entire process tree via negative PID group
process.kill(-pid, 'SIGTERM');

// Escalates to SIGKILL if processes linger after 1 second
setTimeout(() => {
  killProcessTree(pid, 'SIGKILL');
}, 1000);
```
This guarantees 100% port release and zero orphaned zombie processes.
