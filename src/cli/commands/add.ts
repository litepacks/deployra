import chalk from 'chalk';
import { loadConfig } from '../../config/parser.js';
import { ProjectRepository } from '../../storage/project-repository.js';

export function addCommand(configPath?: string): void {
  try {
    const config = loadConfig(configPath);
    const repo = new ProjectRepository();
    const saved = repo.saveProject(config);

    console.log(
      chalk.green(
        `✔ Added project '${saved.name}' (${saved.remote}/${saved.branch}) pointing to '${saved.path}'`,
      ),
    );
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to add project: ${err.message}`));
    process.exit(1);
  }
}
