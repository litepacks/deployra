import http from 'node:http';
import type net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { UnitupAdapter } from '../src/runtime/unitup-adapter.js';
import { checkZeroDowntimePort, isPortOccupied } from '../src/security/port-check.js';

describe('Port Conflict & Supervisor Defense Suite', () => {
  let activeServers: http.Server[] = [];

  const startServer = async (): Promise<number> => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((resolve) => {
      srv.listen(0, '127.0.0.1', () => resolve());
    });
    activeServers.push(srv);
    const addr = srv.address() as net.AddressInfo;
    return addr.port;
  };

  afterEach(async () => {
    for (const s of activeServers) {
      await new Promise<void>((resolve) => {
        s.close(() => resolve());
      });
    }
    activeServers = [];
    vi.restoreAllMocks();
  });

  describe('1. Port Occupancy Detection', () => {
    it('detects an open listening port', async () => {
      const port = await startServer();
      const inUse = await isPortOccupied(port);
      expect(inUse).toBe(true);
    });

    it('returns false for an unused port', async () => {
      // Find a free port then close it
      const srv = http.createServer();
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
      const freePort = (srv.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => srv.close(() => resolve()));

      const inUse = await isPortOccupied(freePort);
      expect(inUse).toBe(false);
    });
  });

  describe('2. checkZeroDowntimePort Defense', () => {
    it('approves deployment when public port is completely free', async () => {
      // Find a port and close it
      const srv = http.createServer();
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
      const freePort = (srv.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => srv.close(() => resolve()));

      const res = await checkZeroDowntimePort('my-api', freePort);
      expect(res.ok).toBe(true);
      expect(res.isOccupied).toBe(false);
      expect(res.error).toBeUndefined();
    });

    it('rejects deployment when port is occupied by an external unmanaged process (IPC dead)', async () => {
      const busyPort = await startServer();

      const res = await checkZeroDowntimePort('unmanaged-service', busyPort);
      expect(res.ok).toBe(false);
      expect(res.isOccupied).toBe(true);
      expect(res.isSupervisorActive).toBe(false);
      expect(res.error).toContain(
        `Public port ${busyPort} is already occupied by an external or unmanaged process`,
      );
    });

    it('allows migration when the port is held by the service own non-zero-downtime unit', async () => {
      const busyPort = await startServer();
      const detectLegacyUnit = vi.fn(async () => true);

      const res = await checkZeroDowntimePort('legacy-svc', busyPort, { detectLegacyUnit });
      expect(detectLegacyUnit).toHaveBeenCalledWith('legacy-svc');
      expect(res.ok).toBe(true);
      expect(res.isOccupied).toBe(true);
      expect(res.isSupervisorActive).toBe(false);
      expect(res.isLegacyUnit).toBe(true);
      expect(res.error).toBeUndefined();
      expect(res.warning).toContain('migrated to Unitup supervisor mode');
    });

    it('still rejects when no legacy unit owns the occupied port', async () => {
      const busyPort = await startServer();

      const res = await checkZeroDowntimePort('foreign-svc', busyPort, {
        detectLegacyUnit: async () => false,
      });
      expect(res.ok).toBe(false);
      expect(res.isLegacyUnit).toBeUndefined();
    });

    it('does not consult legacy detection when the port is free', async () => {
      const srv = http.createServer();
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
      const freePort = (srv.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      const detectLegacyUnit = vi.fn(async () => true);

      const res = await checkZeroDowntimePort('free-svc', freePort, { detectLegacyUnit });
      expect(res.ok).toBe(true);
      expect(detectLegacyUnit).not.toHaveBeenCalled();
    });
  });

  describe('3. Configuration Schema & Normalization', () => {
    it('defaults preflight.portCheck to true', () => {
      const config = normalizeAndValidateConfig({
        project: { name: 'port-app', path: '/tmp/port-app' },
        deploy: {
          strategy: 'zero-downtime',
          port: 3051,
        },
      });

      expect(config.deploy.preflight.portCheck).toBe(true);
      expect(config.deploy.port).toBe(3051);
    });

    it('allows explicitly disabling portCheck in configuration', () => {
      const config = normalizeAndValidateConfig({
        project: { name: 'port-app', path: '/tmp/port-app' },
        deploy: {
          strategy: 'zero-downtime',
          port: 3051,
          preflight: {
            portCheck: false,
          },
        },
      });

      expect(config.deploy.preflight.portCheck).toBe(false);
    });
  });

  describe('4. UnitupAdapter Fast-Fail Defense', () => {
    it('aborts zero-downtime deployment fast if public port is occupied by an unmanaged process', async () => {
      const busyPort = await startServer();
      const adapter = new UnitupAdapter();

      await expect(
        adapter.deployZeroDowntime('conflict-svc', {
          publicPort: busyPort,
          cwd: '/tmp',
          script: 'server.js',
        }),
      ).rejects.toThrow(/already occupied by an external or unmanaged process/);
    });
  });
});
