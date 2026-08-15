/** Windows IPC：named pipe，无磁盘文件。 */
export const PIPE_NAME = "ai.wiseria.pie";

export function win32IpcPath(): string {
  return `\\\\.\\pipe\\${PIPE_NAME}`;
}
