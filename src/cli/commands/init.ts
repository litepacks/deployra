import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';

export function initCommand(targetPath = 'gitship.config.yaml'): void {
  const resolved = path.resolve(targetPath);
  if (fs.existsSync(resolved)) {
    console.log(chalk.yellow(`Configuration file already exists at: ${resolved}`));
    return;
  }

  const defaultContent = `# Gitship Configuration
project:
  name: api
  path: /var/www/api

source:
  remote: origin
  branch: main

watch:
  interval: 30s

deploy:
  concurrency: 1
  queueMode: latest
  dirtyWorkspace: reject
  timeout: 10m

  retry:
    attempts: 2
    backoff: 10s

  commands:
    install:
      - npm ci
    build:
      - npm run build

  service:
    name: api
    action: restart

  ready:
    url: http://127.0.0.1:3000/health
    timeout: 45s
    interval: 2s

  rollback:
    enabled: true
    on:
      - build-failure
      - service-failure
      - ready-failure
`;

  fs.writeFileSync(resolved, defaultContent, 'utf-8');
  console.log(chalk.green(`✔ Initialized sample Gitship configuration at: ${resolved}`));
}
