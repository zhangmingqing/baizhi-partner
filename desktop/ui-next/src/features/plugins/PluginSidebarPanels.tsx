// 侧栏插件区块:插件清单声明的面板按 placement 渲染进任务列。
// 支持拖拽调整同一 placement 内的顺序(顺序存 localStorage,不改插件文件)。
import { IconChevronDown, IconChevronRight, IconGripVertical } from "@tabler/icons-react";
import { useMemo, useState, type DragEvent } from "react";

import { useSettingsNavigation } from "@/features/settings/SettingsNavigationContext";
import type { SettingsSection } from "@/features/settings/SettingsView";
import { openExternal } from "@/lib/ipc/host";
import type { PluginAction, PluginSidebarPanel, PluginView } from "@/lib/ipc/plugins";
import { useI18n } from "@/lib/i18n";

import { PluginPanelFrame } from "./PluginPanelFrame";
import { usePlugins } from "./PluginProvider";

type Placement = "top" | "above-list" | "below-list" | "bottom";

const orderKey = (placement: Placement) => "mc.pluginSidebarOrder." + placement;

function readOrder(placement: Placement): string[] {
  try {
    const raw = localStorage.getItem(orderKey(placement));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeOrder(placement: Placement, keys: string[]) {
  try {
    localStorage.setItem(orderKey(placement), JSON.stringify(keys));
  } catch {
    // 顺序只是偏好,存储不可写时退回默认顺序
  }
}

const panelKey = (plugin: PluginView, panel: PluginSidebarPanel) => plugin.id + "/" + panel.id;

function sortedPanels(plugins: PluginView[], placement: Placement) {
  const rows = (plugins ?? [])
    .filter((plugin) => plugin?.enabled)
    .flatMap((plugin) =>
      (plugin.sidebar ?? [])
        .filter((panel) => (panel?.placement || "top") === placement)
        .map((panel) => ({ plugin, panel, key: panelKey(plugin, panel) })),
    );
  rows.sort((a, b) => {
    if (a.panel.order !== b.panel.order) return a.panel.order - b.panel.order;
    return a.key.localeCompare(b.key);
  });
  const order = readOrder(placement);
  if (order.length === 0) return rows;
  const rank = new Map(order.map((key, index) => [key, index]));
  return rows.sort((a, b) => (rank.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.key) ?? Number.MAX_SAFE_INTEGER));
}

export function PluginSidebarPanels({ placement }: { placement: Placement }) {
  const { plugins } = usePlugins();
  const { openSettings } = useSettingsNavigation();
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [revision, setRevision] = useState(0);
  const rows = useMemo(() => {
    void revision;
    return sortedPanels(plugins, placement);
  }, [plugins, placement, revision]);

  if (rows.length === 0) return null;

  const runAction = (action: PluginAction | null) => {
    if (!action) return;
    if (action.type === "open_settings") {
      openSettings((action.section || undefined) as SettingsSection | undefined);
    } else if (action.type === "open_url") {
      openExternal(action.url);
    } else if (action.type === "copy") {
      void navigator.clipboard?.writeText(action.text).catch(() => {});
    }
  };

  const onDrop = (targetKey: string) => (event: DragEvent) => {
    event.preventDefault();
    const dragged = event.dataTransfer.getData("text/plugin-panel");
    if (!dragged || dragged === targetKey) return;
    const keys = rows.map((row) => row.key);
    const from = keys.indexOf(dragged);
    const to = keys.indexOf(targetKey);
    if (from < 0 || to < 0) return;
    keys.splice(to, 0, ...keys.splice(from, 1));
    writeOrder(placement, keys);
    setRevision((n) => n + 1);
  };

  return (
    <div data-plugin-sidebar={placement} className="flex shrink-0 flex-col gap-1 px-2 pb-1">
      {rows.map(({ plugin, panel, key }) => {
        const isCollapsed = collapsed[key] ?? false;
        return (
          <section
            key={key}
            data-plugin-panel={key}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData("text/plugin-panel", key);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop(key)}
            className="rounded-lg border border-base-300/70 bg-base-100/50"
          >
            <div className="flex min-w-0 items-center gap-1 pe-1">
              <button
                type="button"
                aria-expanded={!isCollapsed}
                onClick={() => setCollapsed((prev) => ({ ...prev, [key]: !isCollapsed }))}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1.5 text-start text-xs font-semibold text-base-content/80 hover:bg-base-200/60"
              >
                <span aria-hidden className="inline-flex w-4 shrink-0 justify-center text-sm">
                  {panel.icon || "◆"}
                </span>
                <span className="min-w-0 flex-1 truncate">{panel.title}</span>
                {isCollapsed ? (
                  <IconChevronRight size={12} stroke={1.75} aria-hidden />
                ) : (
                  <IconChevronDown size={12} stroke={1.75} aria-hidden />
                )}
              </button>
              <span
                title={t("plugins.sidebarDrag")}
                aria-hidden
                className="cursor-grab text-base-content/25 active:cursor-grabbing"
              >
                <IconGripVertical size={13} stroke={1.75} />
              </span>
            </div>
            {!isCollapsed && (
              panel.entry ? (
                <div className="px-2 pb-2">
                  <PluginPanelFrame plugin={plugin} panel={panel} />
                </div>
              ) : (
              <div className="flex flex-col gap-1 px-2 pb-2">
                {(panel.blocks ?? []).map((block, index) => {
                  if (block.type === "text") {
                    return (
                      <p key={index} className="m-0 text-xs leading-relaxed break-words whitespace-pre-wrap text-base-content/60">
                        {block.text}
                      </p>
                    );
                  }
                  if (block.type === "list") {
                    return (
                      <ul key={index} className="m-0 list-disc ps-4 text-xs leading-relaxed text-base-content/60">
                        {block.items.map((item, i) => (
                          <li key={i} className="break-words">
                            {item}
                          </li>
                        ))}
                      </ul>
                    );
                  }
                  if (block.type === "divider") {
                    return <div key={index} className="my-0.5 border-t border-base-300/60" />;
                  }
                  if (block.type === "link") {
                    return (
                      <button
                        key={index}
                        type="button"
                        className="btn btn-ghost btn-xs h-auto min-h-7 justify-start px-1.5 py-1 text-xs font-normal"
                        onClick={() => openExternal(block.url)}
                      >
                        <span className="truncate">{block.label}</span>
                      </button>
                    );
                  }
                  return (
                    <button
                      key={index}
                      type="button"
                      className="btn btn-ghost btn-xs h-auto min-h-7 justify-start px-1.5 py-1 text-xs font-normal"
                      onClick={() => runAction(block.action)}
                    >
                      <span className="truncate">{block.label}</span>
                    </button>
                  );
                })}
              </div>
              )
            )}
          </section>
        );
      })}
    </div>
  );
}
