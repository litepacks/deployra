import http from 'node:http';

export interface SampleServerInstance {
  server: http.Server;
  url: string;
  port: number;
  setVersion: (version: string) => void;
  getVersion: () => string;
  close: () => Promise<void>;
}

export function createSampleServer(initialVersion = 'v1.0.0', port = 3999): SampleServerInstance {
  let currentVersion = initialVersion;

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: currentVersion }));
    } else if (req.url === '/version') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(currentVersion);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`Deployra Fixture Server ${currentVersion}`);
    }
  });

  return {
    server,
    url: `http://127.0.0.1:${port}`,
    port,
    setVersion: (v: string) => {
      currentVersion = v;
    },
    getVersion: () => currentVersion,
    close: async () => {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
