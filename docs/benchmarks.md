---
title: Benchmarks & Performance
description: Comprehensive benchmarks and SoftScope profiler metrics across Deployra's core hot paths
order: 10
---

# Benchmarks & Performance ⚡

Deployra is profiled and optimized using **SoftScope**, ensuring minimal CPU and memory consumption during high-frequency daemon polling and heavy deployment pipelines.

---

## 📊 Summary Performance Metrics

| Subsystem / Operation | Benchmark Workload | Baseline | Optimized | Speedup / Gain |
| :--- | :--- | :--- | :--- | :--- |
| **Secret Masking** | 20,000 log lines with secrets | 45.89 ms | **21.08 ms** | **+54.1% faster** |
| **Config Hash Computation** | SHA-256 JSON hashing | 69.00 ms | **28.00 ms** | **+59.4% faster** |
| **Config File Check** | 1,000 watcher polling checks | 840 ms (full YAML parse) | **4.62 ms** (mtime cache) | **>180x faster** (<5 µs / check) |
| **Lock Operations** | 100 acquire / release cycles | 38.40 ms | **12.67 ms** | **+67.0% faster** |
| **Pipeline Step Checks** | 1,100 pipeline step checks | 15,000 allocations | **0 allocations** (`getDeploymentStatus`) | **-100% redundant allocations** |
| **Active Query Checking** | 500 status & failures queries | 114.00 ms | **36.18 ms** | **+68.3% faster** |
| **Unitup Systemd Cache** | 500 status queries | 500 async checks | **1 check** (cached) | **-99.8% process checks** |

---

## 🔍 Key Architectural Optimizations

### 1. SQLite Prepared Statement Caching
All hot-path database queries utilize `getPreparedStatement`:
- Compiles SQL statement AST into SQLite VDBE bytecode once.
- Subsequent executions run directly with zero parsing overhead.
- Composite index `idx_deployments_proj_status ON deployments(project_name, status, created_at DESC)` covers high-volume status queries.

### 2. Pre-Compiled Secret Masking Regex
- Single compiled regular expression `COMBINED_SECRET_PATTERN` matches dynamic secrets, JWTs, AWS credentials, and SSH private keys in a single pass.
- Eliminates 9 sequential linear string sweeps and O(N·K) split-join operations.

### 3. Source Watcher mtime Verification
- Instead of re-reading and parsing `deployra.config.yaml` with Zod schema validation every 5 seconds, Deployra checks `fs.statSync(configPath).mtimeMs`.
- Only when the file is physically modified on disk does Deployra re-parse the configuration.

### 4. Zero-Clone Process Environment
- Command executions (`safeExec`) pass `process.env` directly when no custom variables are specified, eliminating redundant shallow-cloning of 100+ environment variables on every Git and process check.
