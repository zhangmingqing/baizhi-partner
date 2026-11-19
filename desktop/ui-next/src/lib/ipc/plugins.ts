// 插件宿主 IPC。命令名必须是字面量(契约守卫按正则扫描 ui-next/src)。
import { inDesktopShell, invoke } from "./ipc";

export type PluginAction =
  | { type: "open_settings"; section: string }
  | { type: "open_url"; url: string }
  | { type: "copy"; text: string };

export type PluginSidebarBlock =
  | { type: "text"; text: string }
  | { type: "list"; items: string[] }
  | { type: "button"; label: string; action: PluginAction | null }
  | { type: "link"; label: string; url: string }
  | { type: "divider" };

export interface PluginSidebarPanel {
  id: string;
  title: string;
  icon: string;
  placement: "top" | "above-list" | "below-list" | "bottom" | "";
  order: number;
  blocks: PluginSidebarBlock[];
}

export interface PluginView {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  homepage: string;
  icon: string;
  enabled: boolean;
  plugin_dir: string;
  sidebar: PluginSidebarPanel[];
  theme: Record<string, string>;
  models: Record<string, unknown>[];
  mcp_servers: Record<string, Record<string, unknown>>;
}

export function pluginsList(): Promise<PluginView[]> {
  if (!inDesktopShell()) return Promise.resolve([]);
  return invoke<PluginView[]>("plugins_list");
}

export function pluginsInstall(path: string): Promise<PluginView> {
  return invoke<PluginView>("plugins_install", { path });
}

export function pluginsInstallZip(path: string): Promise<PluginView> {
  return invoke<PluginView>("plugins_install_zip", { path });
}

export function pluginsInstallUrl(url: string): Promise<PluginView> {
  return invoke<PluginView>("plugins_install_url", { url });
}

export function pluginsUninstall(id: string): Promise<void> {
  return invoke<void>("plugins_uninstall", { id });
}

export function pluginsSetEnabled(id: string, enabled: boolean): Promise<void> {
  return invoke<void>("plugins_set_enabled", { id, enabled });
}

export function pluginsMarketRefresh(url: string): Promise<{ items?: unknown[]; plugins?: unknown[] }> {
  return invoke<{ items?: unknown[]; plugins?: unknown[] }>("plugins_market_refresh", { url });
}

/** 原生选择器:目录侧载 / ZIP 侧载共用;取消或浏览器模式返回 null。 */
export async function pickPluginPath(directory: boolean): Promise<string | null> {
  if (!inDesktopShell()) return null;
  const result = await invoke<string | string[] | null>("plugin:dialog|open", {
    options: {
      title: directory ? "选择插件目录" : "选择插件 ZIP",
      directory,
      multiple: false,
      filters: directory ? undefined : [{ name: "Plugin ZIP", extensions: ["zip"] }],
    },
  });
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result[0] ?? null;
  return null;
}
