import { invoke } from "@tauri-apps/api/core";
import type { IpcCommandMap } from "~/generated/ipc.ts";

export function invokeIpc<K extends keyof IpcCommandMap>(
  command: K,
  input: IpcCommandMap[K]["input"],
): Promise<IpcCommandMap[K]["output"]> {
  return invoke<IpcCommandMap[K]["output"]>(command, input);
}
