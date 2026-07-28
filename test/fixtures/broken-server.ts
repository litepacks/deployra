import http from 'node:http';

export interface BrokenServerInstance {
  server: http.Server;
  url: string;
  port: number;
  close: () => Promise<void>;
}

export function createBrokenServer(port = 3998): BrokenServerInstance {
  const server = http.createServer((_req, res) => {
    // Intentionally return 500 Internal Server Error to simulate broken server code
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'error', error: 'Internal Server Error: Server crashed due to syntax or runtime bug' }));
  });

  return {
    server,
    url: `http://127.0.0.1:${port}`,
    port,
    close: async () => {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

export const BROKEN_SERVER_CODE_SNIPPET = `
// Broken Server Script with intentional runtime syntax error
console.log("Starting server...");
throw new Error("FATAL: SyntaxError: Unexpected token '}' in server.js:14:2");
`;
