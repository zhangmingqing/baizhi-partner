# 插件示例

`sidebar-demo/` 是一个只改侧边栏的最小插件。安装方式：

1. 打开「设置 → 插件」；
2. 点「从目录安装」选 `sidebar-demo/`，或点「从 ZIP 安装」选 `sidebar-demo.zip`；
3. 任务列顶部/列表上方/列表下方/页脚会出现四个区块。

`sidebar-js/` 演示两种新增能力：

- `sidebar[].entry`：侧栏面板用独立自定义协议加载 HTML，在
  `<iframe sandbox="allow-scripts">` 里运行任意 JS；没有 `allow-same-origin`，
  拿不到主页面 DOM 或 Tauri IPC。
- `contributes.process`：插件可以声明本地进程，宿主按一次调用拉起、写入一行
  JSON、读回最后一行 JSON 后退出。默认关闭，必须在「设置 → 插件」打开
  「允许插件运行本地进程」。

`sidebar-js.zip` 是同一目录的打包版，可直接用「从 ZIP 安装」。

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

## 沙箱面板（`entry`）

```json
{
  "contributes": {
    "sidebar": [
      {
        "id": "sandbox",
        "title": "沙箱面板",
        "placement": "top",
        "entry": "panel.html",
        "height": 300,
        "blocks": [{ "type": "text", "text": "加载失败时的降级内容" }]
      }
    ]
  }
}
```

- `entry` 必须是插件目录内的相对 `.html`/`.htm` 路径；同目录的 CSS/JS/图片可用相对路径引用。
- iframe 的 CSP 允许内联脚本、`eval`、`blob:` worker 与 http(s)/ws(s) 网络请求；
  但表单、`object` 与顶层导航被禁止。
- 面板加载后会收到宿主 `postMessage` 的 `init`，其中 `__mcPlugin` 是本次面板的随机令牌；
  后续每条消息都要带回该字段。
- 可用动作：
  ```js
  parent.postMessage({ __mcPlugin: token, type: "resize", height: 360 }, "*");
  parent.postMessage({ __mcPlugin: token, type: "action", action: { type: "open_settings", section: "plugins" } }, "*");
  parent.postMessage({ __mcPlugin: token, type: "action", action: { type: "open_url", url: "https://example.com" } }, "*");
  parent.postMessage({ __mcPlugin: token, type: "action", action: { type: "copy", text: "..." } }, "*");
  ```
- 进程插件还可以发 `{ type: "process", id, method, params }`，宿主回
  `{ type: "process_result", id, result | error }`。

## 本地进程（`contributes.process`）

```json
{
  "contributes": {
    "process": {
      "command": "node",
      "args": ["server.js"],
      "timeout_ms": 10000,
      "env": { "DEMO": "1" }
    }
  }
}
```

- `command` 可以是 PATH 中的命令名（`node`、`python3`），或 `./` 开头的插件目录内相对路径；
  绝对路径被拒绝。`args` 最多 32 个，`timeout_ms` 范围 1000–60000。
- 宿主每次调用启动一个进程，cwd 是插件目录，注入 `MC_PLUGIN_ID` / `MC_PLUGIN_DIR`，
  向 stdin 写一行 `{"id":1,"method":"...","params":...}`，从 stdout 读最后一行
  `{"result":...}` 或 `{"error":"..."}`。进程应随后退出。
- `server.js` 不依赖第三方包，可直接参考。
- 这是明确的高权限能力：开启全局开关后，插件可以执行本机命令。只安装可信插件。
