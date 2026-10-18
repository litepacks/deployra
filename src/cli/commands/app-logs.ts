import chalk from 'chalk';
import { loadConfigFromDir, resolveProjectName } from '../../config/parser.js';
import { maskSecrets, registerSecrets } from '../../logging/masker.js';
import type { AppLogOptions } from '../../runtime/runtime-manager.js';
import { UnitupAdapter } from '../../runtime/unitup-adapter.js';
import { closeDatabase } from '../../storage/database.js';
import { ProjectRepository } from '../../storage/project-repository.js';

export interface AppLogsCommandOptions {
  follow?: boolean;
  lines?: string | number;
  since?: string;
  until?: string;
  grep?: string;
  priority?: string;
  stdout?: boolean;
  stderr?: boolean;
  cat?: boolean;
  json?: boolean;
}

function handleMissingTarget(json?: boolean): void {
  if (json) {
    console.log(
      JSON.stringify(
        { error: 'No project or service specified to fetch application logs for' },
        null,
        2,
      ),
    );
  } else {
    console.log(
      chalk.yellow(
        'No project or service found to fetch application logs for. Specify a project name (e.g. deployra app-logs <app>) or run inside a project directory.',
      ),
    );
  }
}

export async function appLogsCommand(
  projectName?: string,
  options: AppLogsCommandOptions = {},
): Promise<void> {
  const targetProject = resolveProjectName(projectName);

  if (!targetProject) {
    handleMissingTarget(options.json);
    return;
  }

  let serviceName = targetProject;
  const projRepo = new ProjectRepository();

  try {
    const project = projRepo.getProject(targetProject);
    if (project) {
      serviceName = project.config.deploy.service?.name || project.name;
      if (project.config.deploy.env) {
        registerSecrets(Object.values(project.config.deploy.env).filter(Boolean));
      }
    } else {
      const localConfig = loadConfigFromDir(process.cwd());
      if (localConfig && localConfig.project.name === targetProject) {
        serviceName = localConfig.deploy.service?.name || localConfig.project.name;
        if (localConfig.deploy.env) {
          registerSecrets(Object.values(localConfig.deploy.env).filter(Boolean));
        }
      }
    }
  } finally {
    closeDatabase();
  }

  const parsedLines =
    options.lines !== undefined ? Number.parseInt(String(options.lines), 10) : 100;
  const lines = Number.isNaN(parsedLines) || parsedLines <= 0 ? 100 : parsedLines;

  const logOptions: AppLogOptions = {
    follow: Boolean(options.follow),
    lines,
    since: options.since,
    until: options.until,
    grep: options.grep,
    priority: options.priority,
    stdout: Boolean(options.stdout),
    stderr: Boolean(options.stderr),
    cat: Boolean(options.cat),
    json: Boolean(options.json),
  };

  const unitup = new UnitupAdapter();

  try {
    if (logOptions.follow && !logOptions.cat && !logOptions.json) {
      console.log(
        chalk.gray(
          `\nStreaming live application logs for '${serviceName}'... (Press Ctrl+C to stop)\n`,
        ),
      );
    }

    const output = await unitup.logs(serviceName, logOptions);

    if (output && typeof (output as any).on === 'function') {
      const emitterOrChild = output as any;
      await new Promise<void>((resolve) => {
        const cleanup = () => {
          if (typeof emitterOrChild.stop === 'function') {
            emitterOrChild.stop();
          } else if (typeof emitterOrChild.kill === 'function') {
            emitterOrChild.kill('SIGTERM');
          }
          process.off('SIGINT', cleanup);
          process.off('SIGTERM', cleanup);
          resolve();
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
        emitterOrChild.once('close', cleanup);
        emitterOrChild.once('error', (err: Error) => {
          console.error(chalk.red(`✖ Error streaming logs: ${err.message}`));
          cleanup();
        });
      });
      return;
    }

    const rawText = typeof output === 'string' ? output : 'No logs found.';
    const maskedText = maskSecrets(rawText);

    if (logOptions.json) {
      if (maskedText.trim() === 'No logs found.' || !maskedText.trim()) {
        console.log(JSON.stringify([], null, 2));
      } else {
        console.log(maskedText);
      }
      return;
    }

    if (!logOptions.cat) {
      const projectLabel =
        targetProject && targetProject !== serviceName ? ` (project: ${targetProject})` : '';
      console.log(
        chalk.bold(`\n📦 Application Logs for '${chalk.cyan(serviceName)}'${projectLabel}:\n`),
      );
    }

    if (maskedText.trim() === 'No logs found.' || !maskedText.trim()) {
      console.log(chalk.gray('No application logs found for this service.'));
    } else {
      console.log(maskedText);
    }
  } catch (err: any) {
    if (logOptions.json) {
      console.error(JSON.stringify({ error: err.message }, null, 2));
    } else {
      console.error(
        chalk.red(`✖ Failed to retrieve application logs for '${serviceName}': ${err.message}`),
      );
    }
    process.exitCode = 1;
  }
}
