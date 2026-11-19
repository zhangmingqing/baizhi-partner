// 沙箱插件面板:HTML/JS 由独立的 monkeycode-plugin 协议返回,iframe 只给
// allow-scripts(不给 allow-same-origin),因此拿不到主页面 DOM、Tauri IPC 或
// 本地存储。插件与宿主只通过 postMessage 交换白名单动作。
import { useEffect, useRef, useState } from "react";

import { useSettingsNavigation } from "@/features/settings/SettingsNavigationContext";
import type { SettingsSection } from "@/features/settings/SettingsView";
import { openExternal } from "@/lib/ipc/host";
import type { PluginSidebarPanel, PluginView } from "@/lib/ipc/plugins";
import { useI18n } from "@/lib/i18n";

import { usePlugins } from "./PluginProvider";

const SCHEME = "monkeycode-plugin";
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 1200;

function frameUrl(pluginId: string, entry: string): string {
  const path = entry
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  // Tauri 自定义协议在 Windows/Android 只能经 http://<scheme>.localhost 访问。
  const host = /Windows/i.test(navigator.userAgent)
    ? `http://${SCHEME}.localhost`
    : `${SCHEME}://localhost`;
  return `${host}/${encodeURIComponent(pluginId)}/${path}`;
}

function appTheme(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const styles = getComputedStyle(document.documentElement);
  const names = [
    "--color-base-100",
    "--color-base-200",
    "--color-base-300",
    "--color-base-content",
    "--color-primary",
    "--color-primary-content",
    "--color-secondary",
    "--color-secondary-content",
    "--color-accent",
    "--color-accent-content",
    "--radius-box",
    "--radius-field",
  ];
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = styles.getPropertyValue(name).trim();
    if (value) out[name] = value;
  }
  return out;
}

function isWebUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 2000 &&
    (value.startsWith("https://") || value.startsWith("http://")) &&
    !/[\s\u0000-\u001f]/.test(value)
  );
}

function clampHeight(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return MIN_HEIGHT;
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(n)));
}

export function PluginPanelFrame({ plugin, panel }: { plugin: PluginView; panel: PluginSidebarPanel }) {
  const { openSettings } = useSettingsNavigation();
  const { t } = useI18n();
  const { processAllowed, callProcess } = usePlugins();
  const frame = useRef<HTMLIFrameElement>(null);
  const token = useRef(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const [height, setHeight] = useState(clampHeight(panel.height ?? 260));
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setHeight(clampHeight(panel.height ?? 260));
    setError(null);
    setLoaded(false);
  }, [panel.entry, panel.height]);

  useEffect(() => {
    const post = (payload: unknown) => {
      frame.current?.contentWindow?.postMessage(payload, "*");
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || data.__mcPlugin !== token.current) return;
      if (data.type === "resize") {
        setHeight(clampHeight(data.height));
        return;
      }
      if (data.type === "action") {
        const action = data.action as Record<string, unknown> | null;
        if (!action || typeof action.type !== "string") return;
        if (action.type === "open_settings") {
          openSettings((typeof action.section === "string" ? action.section : undefined) as SettingsSection | undefined);
        } else if (action.type === "open_url" && isWebUrl(action.url)) {
          openExternal(action.url);
        } else if (action.type === "copy" && typeof action.text === "string") {
          void navigator.clipboard?.writeText(action.text.slice(0, 20_000)).catch(() => {});
        }
        return;
      }
      if (data.type === "process") {
        const requestId = data.id;
        const method = typeof data.method === "string" ? data.method : "";
        if (!plugin.has_process || !processAllowed) {
          post({
            __mcPlugin: token.current,
            type: "process_result",
            id: requestId,
            error: t("plugins.processWarning"),
          });
          return;
        }
        let paramsSize = 0;
        try {
          paramsSize = JSON.stringify(data.params ?? null).length;
        } catch {
          paramsSize = Number.POSITIVE_INFINITY;
        }
        if (paramsSize > 256 * 1024) {
          post({
            __mcPlugin: token.current,
            type: "process_result",
            id: requestId,
            error: t("plugins.processParamsTooLarge"),
          });
          return;
        }
        void callProcess(plugin.id, method, data.params)
          .then((result) => post({ __mcPlugin: token.current, type: "process_result", id: requestId, result }))
          .catch((e: unknown) =>
            post({
              __mcPlugin: token.current,
              type: "process_result",
              id: requestId,
              error: e instanceof Error ? e.message : String(e),
            }),
          );
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [callProcess, openSettings, plugin.has_process, plugin.id, processAllowed, t]);

  const onLoad = () => {
    setLoaded(true);
    setError(null);
    const theme = { ...appTheme(), ...(plugin.theme ?? {}) };
    frame.current?.contentWindow?.postMessage(
      {
        __mcPlugin: token.current,
        type: "init",
        api: 1,
        plugin: { id: plugin.id, name: plugin.name, version: plugin.version },
        theme,
        height,
        capabilities: { process: Boolean(plugin.has_process && processAllowed) },
      },
      "*",
    );
  };

  return (
    <div
      data-plugin-iframe={`${plugin.id}/${panel.id}`}
      className="relative overflow-hidden rounded-md border border-base-300/70 bg-base-100"
      style={{ height }}
    >
      {!loaded && !error && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-base-content/45">
          {t("plugins.panelLoading")}
        </div>
      )}
      {error && (
        <div role="alert" className="absolute inset-0 flex items-center justify-center p-3 text-center text-xs text-error">
          {t("plugins.panelError", { message: error })}
        </div>
      )}
      <iframe
        ref={frame}
        title={`${plugin.name} · ${panel.title}`}
        src={frameUrl(plugin.id, panel.entry ?? "")}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="h-full w-full border-0 bg-transparent"
        onLoad={onLoad}
        onError={() => setError("iframe load error")}
      />
    </div>
  );
}
