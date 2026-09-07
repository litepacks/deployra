import chalk from 'chalk';
import { resolveProjectName } from '../../config/parser.js';
import { NotificationService } from '../../notifications/notification-service.js';
import { closeDatabase } from '../../storage/database.js';
import { ProjectRepository } from '../../storage/project-repository.js';

export async function notifyTestCommand(projectName?: string): Promise<void> {
  const targetProject = resolveProjectName(projectName);
  if (!targetProject) {
    console.error(
      chalk.red(
        '✖ Error: Project name is required. Specify project name or run in project directory.',
      ),
    );
    process.exit(1);
  }

  try {
    const projRepo = new ProjectRepository();
    const project = projRepo.getProject(targetProject);
    if (!project) {
      console.error(chalk.red(`✖ Error: Project '${targetProject}' not found in registry.`));
      process.exit(1);
    }

    const channels = project.config.notifications;
    if (!channels || channels.length === 0) {
      console.log(
        chalk.yellow(`ℹ No notification channels configured for project '${targetProject}'.`),
      );
      return;
    }

    console.log(
      chalk.bold(
        `🔔 Testing ${channels.length} notification channel(s) for project '${targetProject}'...`,
      ),
    );

    const notifier = new NotificationService();
    await notifier.sendDeploymentNotification(project.config, {
      projectName: targetProject,
      deploymentId: 'test_notification',
      status: 'success',
      targetSha: '0000000000000000000000000000000000000000',
      durationMs: 1234,
      triggerType: 'cli-test',
    });

    for (const ch of channels) {
      console.log(chalk.green(`  ✔ Dispatched test alert to ${ch.type.toUpperCase()}`));
    }
    console.log(chalk.green.bold('✔ Notification test completed successfully!'));
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to send test notification: ${err.message}`));
    process.exitCode = 1;
  } finally {
    closeDatabase();
  }
}
