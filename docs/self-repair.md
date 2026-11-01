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

### 2. Orphaned & Stuck Deployment Recovery
- Deployments still marked `running` after 15 minutes that **no live worker owns** (the process died) are marked `failed`. A long build the worker is still executing is never touched.
- Deployments stuck in `queued` for 15 minutes while the worker has free slots are marked `failed`; the watcher then retries the commit.
- Overlapping watchdog cycles are prevented, so a slow recovery never runs twice in parallel.

### 3. Service Auto-Healing
For every project with at least one successful deployment and no deployment in progress, the Watchdog checks the service:
- **Down** (`inactive` / `failed`): the existing systemd unit is started again *without re-registering it*, so zero-downtime units stay in supervisor mode and keep their env. Units stuck in systemd's start-limit `failed` state are reset first. For zero-downtime services Deployra waits for the supervisor IPC socket.
- **Unresponsive**: when `deploy.ready` checks exist, each cycle runs one health probe. After `healthFailureThreshold` consecutive failures the service is restarted.
- **Verification**: a recovery only counts once the ready checks pass (or the unit is active when no checks are configured).
- **Backoff & limit**: failed recoveries are retried after 30s, 1m, 2m, … (max 15m). After `maxRestarts` consecutive failures Deployra stops, logs an error and sends one `failure` notification. A healthy service or a new successful deployment resets the counter.

```yaml
selfRepair:
  enabled: true              # restart crashed services (default true)
  healthCheck: true          # also restart when deploy.ready checks keep failing
  healthFailureThreshold: 3  # consecutive failed probes before a restart
  maxRestarts: 5             # consecutive failed recoveries before giving up and alerting
```

### 3b. Failed Commit Retries
When a deployment of the latest commit fails, the watcher retries it up to 3 times with an exponential cooldown (1m, 2m, 4m).

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
