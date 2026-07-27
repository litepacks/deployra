import { DeployraDaemon } from '../../daemon.js';

export async function watchCommand(targetProjectName?: string): Promise<void> {
  const daemon = new DeployraDaemon();
  await daemon.start(targetProjectName);
}
