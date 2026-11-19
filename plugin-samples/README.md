# 插件示例

`sidebar-demo/` 是一个只改侧边栏的最小插件。安装方式：

1. 打开「设置 → 插件」；
2. 点「从目录安装」选 `sidebar-demo/`，或点「从 ZIP 安装」选 `sidebar-demo.zip`；
3. 任务列顶部/列表上方/列表下方/页脚会出现四个区块。

## plugin.json 结构

```json
{
  "id": "sidebar-demo",
  "name": "侧栏演示",
  "version": "1.0.0",
  "icon": "◆",
  "contributes": {
    "sidebar": [
      {
        "id": "today",
        "title": "今日焦点",
        "placement": "top",
        "order": 10,
        "blocks": [
          { "type": "text", "text": "..." },
          { "type": "list", "items": ["..."] },
          { "type": "button", "label": "...", "action": { "type": "open_settings", "section": "plugins" } },
          { "type": "link", "label": "...", "url": "https://example.com" },
          { "type": "divider" }
        ]
      }
    ]
  }
}
```

`placement` 取 `top` / `above-list` / `below-list` / `bottom`，缺省为 `top`。

按钮动作只支持三种：

- `open_settings`：打开设置页，`section` 可选 `general/models/mcp/skills/plugins/browser/env/about`；
- `open_url`：只接受 http(s)，交给系统浏览器；
- `copy`：复制一段文本。

## 可选贡献

```json
{
  "contributes": {
    "theme": { "--color-primary": "oklch(0.62 0.16 255)" },
    "models": [
      { "name": "demo-model", "provider": "openai", "model": "gpt-4o-mini", "base_url": "https://api.example.com/v1", "api_key": "..." }
    ],
    "mcp_servers": {
      "demo": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] }
    }
  }
}
```

- `theme` 只接受 `--` 开头的 CSS 变量，值里不能有 `url(`、分号或花括号；
- `models` 条目字段与 `config.json` 的 `models` 同构，插件条目不写回权威配置，卸载即消失；
- `mcp_servers` 的键是服务器名，值与该应用的 MCP 配置同构；同名服务器以用户配置优先。
