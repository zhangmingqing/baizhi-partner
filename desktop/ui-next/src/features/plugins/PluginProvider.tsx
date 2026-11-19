// 插件运行时:加载已安装插件、应用主题变量,并把操作后的结果广播给
// 侧栏与设置页。插件本身只贡献声明式数据,不执行任意 JS(CSP 仍为
// script-src 'self')。
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { engineRestart } from "@/lib/ipc/engine";
import {
  pluginsInstall,
  pluginsInstallUrl,
  pluginsInstallZip,
  pluginsList,
  pluginsMarketRefresh,
  pluginsSetEnabled,
  pluginsProcessAllowed,
  pluginsProcessCall,
  pluginsSetProcessAllowed,
  pluginsUninstall,
  type PluginView,
} from "@/lib/ipc/plugins";

interface PluginsContextValue {
  plugins: PluginView[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  installDir: (path: string) => Promise<PluginView>;
  installZip: (path: string) => Promise<PluginView>;
  installUrl: (url: string) => Promise<PluginView>;
  uninstall: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  marketRefresh: (url: string) => Promise<unknown[]>;
  processAllowed: boolean;
  setProcessAllowed: (allowed: boolean) => Promise<void>;
  callProcess: (id: string, method: string, params?: unknown) => Promise<unknown>;
}

const NOOP = (): Promise<never> => Promise.reject(new Error("插件运行时未初始化"));
const PluginsContext = createContext<PluginsContextValue>({
  plugins: [],
  loading: false,
  error: null,
  reload: () => Promise.resolve(),
  installDir: NOOP,
  installZip: NOOP,
  installUrl: NOOP,
  uninstall: NOOP,
  setEnabled: NOOP,
  marketRefresh: () => Promise.resolve([]),
  processAllowed: false,
  setProcessAllowed: NOOP,
  callProcess: NOOP,
});

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function PluginProvider({ children }: { children: ReactNode }) {
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processAllowed, setProcessAllowedState] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [next, allowed] = await Promise.all([
        pluginsList(),
        pluginsProcessAllowed().catch(() => false),
      ]);
      // 浏览器模式/测试桩可能没有宿主实现,统一退化为空列表。
      setPlugins(Array.isArray(next) ? next : []);
      setProcessAllowedState(Boolean(allowed));
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  // 主题令牌按启用顺序叠加;停用/卸载后把本运行时写过的变量还原。
  useEffect(() => {
    const root = document.documentElement;
    const applied: string[] = [];
    for (const plugin of plugins ?? []) {
      if (!plugin?.enabled) continue;
      for (const [key, value] of Object.entries(plugin.theme ?? {})) {
        if (!key.startsWith("--")) continue;
        root.style.setProperty(key, value);
        applied.push(key);
      }
    }
    return () => {
      for (const key of applied) root.style.removeProperty(key);
    };
  }, [plugins]);

  const needsEngine = useCallback(
    (plugin: PluginView) => (plugin.models ?? []).length > 0 || Object.keys(plugin.mcp_servers ?? {}).length > 0,
    [],
  );

  const afterChange = useCallback(
    async (plugin?: PluginView) => {
      await reload();
      if (plugin && needsEngine(plugin)) {
        // 模型/MCP 是引擎派生配置:让壳重启引擎重读物化结果。失败不掩盖
        // 插件已安装的事实,错误留给设置页下一次操作外显。
        await engineRestart().catch(() => {});
      }
    },
    [needsEngine, reload],
  );

  const installDir = useCallback(
    async (path: string) => {
      const plugin = await pluginsInstall(path);
      await afterChange(plugin);
      return plugin;
    },
    [afterChange],
  );
  const installZip = useCallback(
    async (path: string) => {
      const plugin = await pluginsInstallZip(path);
      await afterChange(plugin);
      return plugin;
    },
    [afterChange],
  );
  const installUrl = useCallback(
    async (url: string) => {
      const plugin = await pluginsInstallUrl(url);
      await afterChange(plugin);
      return plugin;
    },
    [afterChange],
  );
  const uninstall = useCallback(
    async (id: string) => {
      const plugin = plugins.find((p) => p.id === id);
      await pluginsUninstall(id);
      await afterChange(plugin);
    },
    [afterChange, plugins],
  );
  const setEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      const plugin = plugins.find((p) => p.id === id);
      await pluginsSetEnabled(id, enabled);
      await afterChange(plugin);
    },
    [afterChange, plugins],
  );
  const marketRefresh = useCallback(async (url: string) => {
    const data = await pluginsMarketRefresh(url);
    return (data.items ?? data.plugins ?? []) as unknown[];
  }, []);

  const setProcessAllowed = useCallback(async (allowed: boolean) => {
    await pluginsSetProcessAllowed(allowed);
    setProcessAllowedState(allowed);
  }, []);

  const callProcess = useCallback(
    (id: string, method: string, params?: unknown) => pluginsProcessCall(id, method, params),
    [],
  );

  const value = useMemo<PluginsContextValue>(
    () => ({
      plugins,
      loading,
      error,
      reload,
      installDir,
      installZip,
      installUrl,
      uninstall,
      setEnabled,
      marketRefresh,
      processAllowed,
      setProcessAllowed,
      callProcess,
    }),
    [
      plugins,
      loading,
      error,
      reload,
      installDir,
      installZip,
      installUrl,
      uninstall,
      setEnabled,
      marketRefresh,
      processAllowed,
      setProcessAllowed,
      callProcess,
    ],
  );

  return <PluginsContext.Provider value={value}>{children}</PluginsContext.Provider>;
}

export function usePlugins(): PluginsContextValue {
  return useContext(PluginsContext);
}
