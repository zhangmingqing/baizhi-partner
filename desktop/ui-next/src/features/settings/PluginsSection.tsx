// 设置·插件:本地目录/ZIP 侧载、市场索引安装、启停与卸载。
// 插件是壳侧即时状态(plugins_* 命令),不进 config 草稿保存条。
import { IconDownload, IconFolderOpen, IconPlugConnected, IconRefresh, IconTrash } from "@tabler/icons-react";
import { useState } from "react";

import { usePlugins } from "@/features/plugins/PluginProvider";
import { pickPluginPath } from "@/lib/ipc/plugins";
import { useI18n } from "@/lib/i18n";

interface MarketItem {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  icon?: string;
  zip: string;
  url?: string;
}

function asMarketItem(value: unknown): MarketItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const zip = typeof item.zip === "string" ? item.zip : typeof item.url === "string" ? item.url : "";
  if (!zip) return null;
  return {
    id: typeof item.id === "string" ? item.id : undefined,
    name: typeof item.name === "string" ? item.name : undefined,
    description: typeof item.description === "string" ? item.description : undefined,
    version: typeof item.version === "string" ? item.version : undefined,
    icon: typeof item.icon === "string" ? item.icon : undefined,
    zip,
  };
}

export function PluginsSection() {
  const { t } = useI18n();
  const {
    plugins,
    loading,
    error,
    installDir,
    installZip,
    installUrl,
    uninstall,
    setEnabled,
    marketRefresh,
    processAllowed,
    setProcessAllowed,
  } = usePlugins();
  const [marketUrl, setMarketUrl] = useState("");
  const [marketItems, setMarketItems] = useState<MarketItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (key: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    setLocalError(null);
    setNotice(null);
    try {
      await action();
      setNotice(t("plugins.done"));
    } catch (e) {
      setLocalError(t("plugins.failed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const pickAndInstall = (directory: boolean) =>
    run("pick", async () => {
      const path = await pickPluginPath(directory);
      if (!path) return;
      if (directory) await installDir(path);
      else await installZip(path);
    });

  const refreshMarket = () =>
    run("market", async () => {
      const items = await marketRefresh(marketUrl.trim());
      setMarketItems(items.map(asMarketItem).filter((item): item is MarketItem => !!item));
    });

  return (
    <div data-settings-section="plugins" className="flex max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">{t("plugins.title")}</h2>
        <p className="text-xs leading-relaxed text-base-content/55">{t("plugins.intro")}</p>
      </div>

      <section className="rounded-lg border border-warning/40 bg-warning/5 p-3">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            className="toggle toggle-warning toggle-sm mt-0.5"
            checked={processAllowed}
            disabled={!!busy}
            onChange={() => void run("process", () => setProcessAllowed(!processAllowed))}
          />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{t("plugins.processAllowed")}</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-base-content/60">
              {t("plugins.processWarning")}
            </span>
          </span>
        </label>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-sm gap-2" disabled={!!busy} onClick={() => void pickAndInstall(true)}>
          <IconFolderOpen size={15} stroke={1.75} aria-hidden />
          {t("plugins.installDir")}
        </button>
        <button type="button" className="btn btn-sm gap-2" disabled={!!busy} onClick={() => void pickAndInstall(false)}>
          <IconDownload size={15} stroke={1.75} aria-hidden />
          {t("plugins.installZip")}
        </button>
        <span className="text-xs text-base-content/45">{t("plugins.restartHint")}</span>
      </div>

      {(localError || error) && (
        <div role="alert" className="alert alert-error alert-soft text-xs">
          {localError || error}
        </div>
      )}
      {notice && (
        <div role="status" className="alert alert-success alert-soft text-xs">
          {notice}
        </div>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <IconPlugConnected size={15} stroke={1.75} aria-hidden />
          <h3 className="text-sm font-semibold">{t("plugins.installed")}</h3>
          <span className="text-xs text-base-content/40">{plugins.length}</span>
        </div>
        {loading ? (
          <p className="text-xs text-base-content/50">{t("plugins.loading")}</p>
        ) : plugins.length === 0 ? (
          <p className="text-xs text-base-content/50">{t("plugins.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {plugins.map((plugin) => (
              <li key={plugin.id} className="rounded-lg border border-base-300 bg-base-100/60 p-3">
                <div className="flex items-start gap-3">
                  <span aria-hidden className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-base-200 text-sm">
                    {plugin.icon || "◆"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate text-sm font-semibold">{plugin.name}</span>
                      <span className="text-xs text-base-content/45">
                        {t("plugins.version")} {plugin.version || "—"}
                      </span>
                      <span
                        className={
                          "badge badge-xs " + (plugin.enabled ? "badge-success badge-soft" : "badge-ghost")
                        }
                      >
                        {plugin.enabled ? t("plugins.enabled") : t("plugins.disabled")}
                      </span>
                    </div>
                    {plugin.description && (
                      <p className="mt-1 text-xs leading-relaxed text-base-content/60">{plugin.description}</p>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-base-content/45">
                      <span>{t("plugins.sidebarCount", { n: (plugin.sidebar ?? []).length })}</span>
                      <span>{t("plugins.modelCount", { n: (plugin.models ?? []).length })}</span>
                      <span>{t("plugins.mcpCount", { n: Object.keys(plugin.mcp_servers ?? {}).length })}</span>
                      {plugin.has_process && (
                        <span className="badge badge-xs badge-warning badge-soft">{t("plugins.processBadge")}</span>
                      )}
                      {plugin.author && (
                        <span>
                          {t("plugins.by")} {plugin.author}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate font-mono text-[10px] text-base-content/30" title={plugin.plugin_dir}>
                      {plugin.plugin_dir}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <button
                      type="button"
                      className="btn btn-xs"
                      disabled={!!busy}
                      onClick={() => void run(plugin.id, () => setEnabled(plugin.id, !plugin.enabled))}
                    >
                      {plugin.enabled ? t("plugins.disable") : t("plugins.enable")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs text-error"
                      disabled={!!busy}
                      onClick={() => {
                        if (!window.confirm(t("plugins.uninstallConfirm", { name: plugin.name }))) return;
                        void run(plugin.id, () => uninstall(plugin.id));
                      }}
                    >
                      <IconTrash size={13} stroke={1.75} aria-hidden />
                      {t("plugins.uninstall")}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2 border-t border-base-300 pt-4">
        <h3 className="text-sm font-semibold">{t("plugins.market")}</h3>
        <p className="text-xs leading-relaxed text-base-content/50">{t("plugins.marketHint")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input input-sm min-w-64 flex-1 font-mono text-xs"
            value={marketUrl}
            placeholder={t("plugins.marketUrlPlaceholder")}
            onChange={(event) => setMarketUrl(event.target.value)}
          />
          <button
            type="button"
            className="btn btn-sm gap-2"
            disabled={!!busy || !marketUrl.trim()}
            onClick={() => void refreshMarket()}
          >
            <IconRefresh size={14} stroke={1.75} aria-hidden />
            {t("plugins.marketRefresh")}
          </button>
        </div>
        {marketItems.length === 0 ? (
          <p className="text-xs text-base-content/45">{t("plugins.marketEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {marketItems.map((item, index) => (
              <li
                key={(item.id || item.name || item.zip) + index}
                className="flex items-start gap-3 rounded-lg border border-base-300 bg-base-100/60 p-3"
              >
                <span aria-hidden className="mt-0.5 text-sm">
                  {item.icon || "◆"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{item.name || item.id || item.zip}</span>
                    {item.version && <span className="text-xs text-base-content/45">{item.version}</span>}
                  </div>
                  {item.description && (
                    <p className="mt-0.5 text-xs leading-relaxed text-base-content/55">{item.description}</p>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-xs shrink-0"
                  disabled={!!busy}
                  onClick={() => void run(item.zip, () => installUrl(item.zip))}
                >
                  {t("plugins.marketInstall")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
