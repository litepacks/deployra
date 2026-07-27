import { GitshipDaemon } from '../../daemon.js';

export async function watchCommand(targetProjectName?: string): Promise<void> {
  const daemon = new GitshipDaemon();
  await daemon.start(targetProjectName);
}
