import { invoke } from "@tauri-apps/api/core";

export async function startLogin(): Promise<void> {
  await invoke("start_login");
}
