// 插件宿主:清单解析、侧载安装、启停状态与引擎配置合并。
//
// 插件是**壳侧资源**,不进入引擎源码:安装目录固定为
// <app_config_dir>/plugins/<id>/,启停状态独立存 <app_config_dir>/plugins-state.json
// (与技能库同理,不写权威 config.json,坏了只影响插件本身)。
//
// 能力面刻意收敛为可审计的数据,而不是任意 JS:
// - contributes.sidebar:声明式侧栏区块(文本/列表/按钮/链接),UI 直接渲染;
// - contributes.theme:CSS 自定义属性白名单;
// - contributes.models / mcp_servers:仅在物化引擎配置时合并,不落盘到
//   config.json;引擎设置页仍是权威,插件条目在 UI 设置里不可编辑。
// 这样插件可以在不突破 CSP("script-src 'self'")的前提下改造侧边栏。

use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::config::DesktopConfig;

const MANIFEST_FILE: &str = "plugin.json";
const STATE_FILE: &str = "plugins-state.json";
const STAGE_PREFIX: &str = ".staging-";
const ZIP_PREFIX: &str = ".unzip-";
const DOWNLOAD_PREFIX: &str = ".download-";
const MAX_PLUGIN_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 4_000;
const MAX_MARKET_BYTES: usize = 2 * 1024 * 1024;
const MAX_TEXT_FIELD: usize = 4_000;
const MAX_PANELS: usize = 32;
const MAX_BLOCKS: usize = 64;

static STAGE_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub homepage: String,
    /// 单字符/短文本图标(emoji 或字母),不读任意图片文件。
    pub icon: String,
    pub contributes: PluginContributes,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PluginContributes {
    pub sidebar: Vec<SidebarPanel>,
    /// CSS 变量 → 值。仅允许 -- 开头的变量名与无 url()/分号的值。
    pub theme: BTreeMap<String, String>,
    /// 壳/引擎模型条目,字段与 config.json models 同构。
    pub models: Vec<Value>,
    /// 名称 → MCP 配置,字段与 config.json mcp_servers 同构。
    pub mcp_servers: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SidebarPanel {
    pub id: String,
    pub title: String,
    pub icon: String,
    /// top | above-list | below-list | bottom,缺省 top。
    pub placement: String,
    /// 同一 placement 内升序;相同则按插件 id 排。
    pub order: i64,
    pub blocks: Vec<SidebarBlock>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidebarBlock {
    Text { text: String },
    List { items: Vec<String> },
    Button { label: String, #[serde(default)] action: Option<PluginAction> },
    Link { label: String, url: String },
    Divider,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PluginAction {
    OpenSettings { #[serde(default)] section: String },
    OpenUrl { url: String },
    Copy { text: String },
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct PluginState {
    enabled: BTreeMap<String, bool>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PluginView {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub homepage: String,
    pub icon: String,
    pub enabled: bool,
    pub plugin_dir: String,
    pub sidebar: Vec<SidebarPanel>,
    pub theme: BTreeMap<String, String>,
    pub models: Vec<Value>,
    pub mcp_servers: BTreeMap<String, Value>,
}

/// 插件根目录。列表/安装/卸载共用同一路径解析,避免三处漂移。
fn plugins_dir(cfg_dir: &Path) -> PathBuf {
    cfg_dir.join("plugins")
}

fn state_path(cfg_dir: &Path) -> PathBuf {
    cfg_dir.join(STATE_FILE)
}

fn load_state(cfg_dir: &Path) -> PluginState {
    fs::read(state_path(cfg_dir))
        .ok()
        .and_then(|d| serde_json::from_slice(&d).ok())
        .unwrap_or_default()
}

fn save_state(cfg_dir: &Path, state: &PluginState) -> Result<(), String> {
    fs::create_dir_all(cfg_dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let path = state_path(cfg_dir);
    let tmp = path.with_file_name(format!(
        ".{}.tmp-{}-{}",
        STATE_FILE,
        std::process::id(),
        STAGE_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let data = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    {
        let mut f = File::create(&tmp).map_err(|e| format!("写入插件状态失败: {e}"))?;
        f.write_all(&data).map_err(|e| format!("写入插件状态失败: {e}"))?;
        f.sync_all().ok();
    }
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("提交插件状态失败: {e}")
    })
}

fn valid_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn read_manifest(root: &Path) -> Result<PluginManifest, String> {
    let raw = fs::read_to_string(root.join(MANIFEST_FILE))
        .map_err(|e| format!("读取 {} 失败: {e}", root.join(MANIFEST_FILE).display()))?;
    let manifest: PluginManifest =
        serde_json::from_str(&raw).map_err(|e| format!("{} 不是有效 JSON: {e}", MANIFEST_FILE))?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn validate_manifest(m: &PluginManifest) -> Result<(), String> {
    if !valid_plugin_id(&m.id) {
        return Err("插件 id 必须为 1-64 位小写字母/数字/-/_/.，且不能以点开头".into());
    }
    if m.name.trim().is_empty() || m.name.len() > 128 {
        return Err("插件 name 不能为空且不超过 128 字符".into());
    }
    if m.version.len() > 64 || m.description.len() > MAX_TEXT_FIELD {
        return Err("插件 version/description 超长".into());
    }
    if m.contributes.sidebar.len() > MAX_PANELS {
        return Err(format!("侧栏区块最多 {MAX_PANELS} 个"));
    }
    for panel in &m.contributes.sidebar {
        if panel.id.trim().is_empty() || panel.id.len() > 64 {
            return Err("侧栏区块 id 必填且不超过 64 字符".into());
        }
        if panel.title.trim().is_empty() || panel.title.len() > 128 {
            return Err("侧栏区块 title 必填且不超过 128 字符".into());
        }
        if panel.icon.chars().count() > 4 {
            return Err("侧栏区块 icon 最多 4 个字符".into());
        }
        if !matches!(panel.placement.as_str(), "" | "top" | "above-list" | "below-list" | "bottom") {
            return Err(format!("侧栏区块 {} placement 非法", panel.id));
        }
        if panel.blocks.len() > MAX_BLOCKS {
            return Err(format!("侧栏区块 {} blocks 最多 {MAX_BLOCKS} 个", panel.id));
        }
        for block in &panel.blocks {
            validate_block(block)?;
        }
    }
    for (key, value) in &m.contributes.theme {
        validate_theme_token(key, value)?;
    }
    if m.contributes.models.len() > 32 {
        return Err("插件最多贡献 32 个模型条目".into());
    }
    for model in &m.contributes.models {
        if !model.is_object() {
            return Err("contributes.models 必须是对象数组".into());
        }
        for key in ["name", "provider", "model"] {
            if model.get(key).and_then(|v| v.as_str()).is_none() {
                return Err(format!("模型条目缺少 {key}"));
            }
        }
    }
    if m.contributes.mcp_servers.len() > 32 {
        return Err("插件最多贡献 32 个 MCP server".into());
    }
    Ok(())
}

fn validate_block(block: &SidebarBlock) -> Result<(), String> {
    match block {
        SidebarBlock::Text { text } => {
            if text.len() > MAX_TEXT_FIELD {
                return Err("侧栏文本超长".into());
            }
        }
        SidebarBlock::List { items } => {
            if items.len() > 32 || items.iter().any(|i| i.len() > 500) {
                return Err("侧栏列表最多 32 项,单项不超过 500 字符".into());
            }
        }
        SidebarBlock::Button { label, action } => {
            if label.trim().is_empty() || label.len() > 128 {
                return Err("侧栏按钮 label 必填且不超过 128 字符".into());
            }
            if let Some(action) = action {
                validate_action(action)?;
            }
        }
        SidebarBlock::Link { label, url } => {
            if label.trim().is_empty() || !valid_web_url(url) {
                return Err("侧栏链接需要 label 与 http(s) URL".into());
            }
        }
        SidebarBlock::Divider => {}
    }
    Ok(())
}

fn validate_action(action: &PluginAction) -> Result<(), String> {
    match action {
        PluginAction::OpenSettings { section } => {
            if section.len() > 64 {
                return Err("open_settings section 超长".into());
            }
        }
        PluginAction::OpenUrl { url } => {
            if !valid_web_url(url) {
                return Err("open_url 只接受 http(s) URL".into());
            }
        }
        PluginAction::Copy { text } => {
            if text.len() > MAX_TEXT_FIELD {
                return Err("copy 文本超长".into());
            }
        }
    }
    Ok(())
}

fn valid_web_url(url: &str) -> bool {
    url.len() <= 2_000
        && (url.starts_with("https://") || url.starts_with("http://"))
        && !url.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn validate_theme_token(key: &str, value: &str) -> Result<(), String> {
    if !key.starts_with("--") || key.len() > 64 {
        return Err(format!("主题变量 {key} 必须以 -- 开头"));
    }
    if key
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || c == '-'))
    {
        return Err(format!("主题变量 {key} 含非法字符"));
    }
    let lower = value.to_ascii_lowercase();
    if value.len() > 200
        || lower.contains("url(")
        || lower.contains(';')
        || lower.contains('}')
        || lower.contains('<')
    {
        return Err(format!("主题变量 {key} 的值不安全"));
    }
    Ok(())
}

fn view_of(manifest: PluginManifest, plugin_dir: &Path, enabled: bool) -> PluginView {
    PluginView {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        homepage: manifest.homepage,
        icon: manifest.icon,
        enabled,
        plugin_dir: plugin_dir.to_string_lossy().into_owned(),
        sidebar: manifest.contributes.sidebar,
        theme: manifest.contributes.theme,
        models: manifest.contributes.models,
        mcp_servers: manifest.contributes.mcp_servers,
    }
}

fn scan_plugins(cfg_dir: &Path) -> Vec<PluginView> {
    let dir = plugins_dir(cfg_dir);
    let state = load_state(cfg_dir);
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return out;
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|name| !name.starts_with('.'))
        })
        .collect();
    dirs.sort();
    let mut seen = HashSet::new();
    for path in dirs {
        let Ok(manifest) = read_manifest(&path) else {
            continue;
        };
        if !seen.insert(manifest.id.clone()) {
            continue;
        }
        let enabled = state.enabled.get(&manifest.id).copied().unwrap_or(true);
        out.push(view_of(manifest, &path, enabled));
    }
    out
}

/// 把启用插件贡献的 models/MCP 合并进一份**副本**,供引擎物化与模型列表
/// 使用。不修改 config.json,卸载插件即自动消失。
pub fn merge_effective(cfg: &mut DesktopConfig, cfg_dir: &Path) {
    let plugins = scan_plugins(cfg_dir);
    if plugins.iter().all(|p| p.models.is_empty() && p.mcp_servers.is_empty()) {
        return;
    }
    let mut existing_models: HashSet<String> = cfg
        .models
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let had_default = cfg.models.as_array().is_some_and(|arr| {
        arr.iter().any(|m| m.get("default").and_then(|d| d.as_bool()).unwrap_or(false))
    });
    if !cfg.models.is_array() {
        cfg.models = serde_json::json!([]);
    }
    for plugin in plugins.iter().filter(|p| p.enabled) {
        for model in &plugin.models {
            let Some(name) = model.get("name").and_then(|n| n.as_str()) else {
                continue;
            };
            if !existing_models.insert(name.to_string()) {
                continue;
            }
            let mut model = model.clone();
            // 插件不能抢走用户显式设置的默认模型:已有默认时剥掉 default。
            if had_default {
                if let Some(obj) = model.as_object_mut() {
                    obj.remove("default");
                }
            }
            if let Some(arr) = cfg.models.as_array_mut() {
                arr.push(model);
            }
        }
    }
    if !cfg.mcp_servers.is_object() {
        cfg.mcp_servers = serde_json::json!({});
    }
    for plugin in plugins.iter().filter(|p| p.enabled) {
        for (name, entry) in &plugin.mcp_servers {
            let Some(map) = cfg.mcp_servers.as_object_mut() else {
                break;
            };
            if map.contains_key(name) {
                continue;
            }
            map.insert(name.clone(), entry.clone());
        }
    }
}

fn stage_dir(cfg_dir: &Path, prefix: &str) -> Result<PathBuf, String> {
    let dir = plugins_dir(cfg_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("创建插件目录失败: {e}"))?;
    Ok(dir.join(format!(
        "{prefix}{}-{}",
        std::process::id(),
        STAGE_SEQ.fetch_add(1, Ordering::Relaxed)
    )))
}

fn copy_tree(src: &Path, dst: &Path, depth: usize, total: &mut u64) -> Result<(), String> {
    if depth > 8 {
        return Err("插件目录层级过深".into());
    }
    let meta = fs::symlink_metadata(src).map_err(|e| format!("读取 {} 失败: {e}", src.display()))?;
    if meta.file_type().is_symlink() {
        return Err(format!("插件不允许包含符号链接: {}", src.display()));
    }
    if meta.is_dir() {
        let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if matches!(name, ".git" | "node_modules" | "__MACOSX") {
            return Ok(());
        }
        fs::create_dir_all(dst).map_err(|e| format!("创建 {} 失败: {e}", dst.display()))?;
        let mut entries: Vec<_> = fs::read_dir(src)
            .map_err(|e| format!("读取 {} 失败: {e}", src.display()))?
            .filter_map(Result::ok)
            .collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            copy_tree(&entry.path(), &dst.join(entry.file_name()), depth + 1, total)?;
        }
        return Ok(());
    }
    if !meta.is_file() {
        return Err(format!("插件包含不支持的文件类型: {}", src.display()));
    }
    *total = total
        .checked_add(meta.len())
        .filter(|n| *n <= MAX_PLUGIN_BYTES)
        .ok_or_else(|| format!("插件体积超过 {} MB", MAX_PLUGIN_BYTES / 1024 / 1024))?;
    let mut input = File::open(src).map_err(|e| format!("读取 {} 失败: {e}", src.display()))?;
    let mut output = File::create(dst).map_err(|e| format!("写入 {} 失败: {e}", dst.display()))?;
    std::io::copy(&mut input, &mut output).map_err(|e| format!("复制 {} 失败: {e}", src.display()))?;
    Ok(())
}

fn install_from_dir(app: &AppHandle, src: &Path) -> Result<PluginView, String> {
    if !src.is_dir() {
        return Err(format!("插件目录不存在: {}", src.display()));
    }
    let manifest = read_manifest(src)?;
    let cfg_dir = crate::config::config_dir(app)?;
    let target = plugins_dir(&cfg_dir).join(&manifest.id);
    if target.exists() {
        return Err(format!("插件 {} 已安装,请先卸载", manifest.id));
    }
    let stage = stage_dir(&cfg_dir, STAGE_PREFIX)?;
    let mut total = 0;
    copy_tree(src, &stage, 0, &mut total)?;
    let staged_manifest = read_manifest(&stage)?;
    if staged_manifest.id != manifest.id {
        let _ = fs::remove_dir_all(&stage);
        return Err("插件复制后清单 id 不一致".into());
    }
    fs::rename(&stage, &target).map_err(|e| {
        let _ = fs::remove_dir_all(&stage);
        format!("安装插件失败: {e}")
    })?;
    let mut state = load_state(&cfg_dir);
    state.enabled.insert(manifest.id.clone(), true);
    save_state(&cfg_dir, &state)?;
    Ok(view_of(manifest, &target, true))
}

fn zip_entry_is_symlink<R: Read>(entry: &zip::read::ZipFile<'_, R>) -> bool {
    entry
        .unix_mode()
        .is_some_and(|mode| mode & 0o170000 == 0o120000)
}

fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| format!("读取 ZIP 失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("ZIP 格式无效: {e}"))?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(format!("ZIP 条目超过 {MAX_ZIP_ENTRIES}"));
    }
    fs::create_dir_all(dest).map_err(|e| format!("创建解压目录失败: {e}"))?;
    let mut total = 0u64;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("读取 ZIP 条目失败: {e}"))?;
        if zip_entry_is_symlink(&entry) {
            return Err("ZIP 不允许包含符号链接".into());
        }
        let Some(rel) = entry.enclosed_name() else {
            return Err("ZIP 含越界路径".into());
        };
        if rel.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_)
            )
        }) {
            return Err("ZIP 含越界路径".into());
        }
        if rel
            .components()
            .any(|c| c.as_os_str() == "__MACOSX" || c.as_os_str() == ".git")
        {
            continue;
        }
        let out = dest.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| format!("解压目录失败: {e}"))?;
            continue;
        }
        total = total
            .checked_add(entry.size())
            .filter(|n| *n <= MAX_PLUGIN_BYTES)
            .ok_or_else(|| format!("ZIP 解压后超过 {} MB", MAX_PLUGIN_BYTES / 1024 / 1024))?;
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("解压目录失败: {e}"))?;
        }
        let mut writer = File::create(&out).map_err(|e| format!("写入 {} 失败: {e}", out.display()))?;
        std::io::copy(&mut entry, &mut writer).map_err(|e| format!("解压 {} 失败: {e}", rel.display()))?;
    }
    Ok(())
}

fn install_from_zip(app: &AppHandle, zip_path: &Path) -> Result<PluginView, String> {
    let cfg_dir = crate::config::config_dir(app)?;
    let raw = stage_dir(&cfg_dir, ZIP_PREFIX)?;
    let extract_result = extract_zip(zip_path, &raw);
    if let Err(error) = extract_result {
        let _ = fs::remove_dir_all(&raw);
        return Err(error);
    }
    // plugin.json 可以在 ZIP 根,也可以在唯一的顶层目录里(常见打包形态)。
    let root = if raw.join(MANIFEST_FILE).is_file() {
        raw.clone()
    } else {
        let children: Vec<PathBuf> = fs::read_dir(&raw)
            .map_err(|e| format!("读取解压目录失败: {e}"))?
            .filter_map(Result::ok)
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .collect();
        match children.as_slice() {
            [only] if only.join(MANIFEST_FILE).is_file() => only.clone(),
            _ => {
                let _ = fs::remove_dir_all(&raw);
                return Err(format!("ZIP 根目录缺少 {MANIFEST_FILE}"));
            }
        }
    };
    let result = install_from_dir(app, &root);
    let _ = fs::remove_dir_all(&raw);
    result
}

fn validate_download_url(url: &str) -> Result<(), String> {
    if !valid_web_url(url) {
        return Err("只接受 http(s) URL".into());
    }
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("http://")
        && !lower.starts_with("http://127.0.0.1")
        && !lower.starts_with("http://localhost")
        && !lower.starts_with("http://[::1]")
    {
        return Err("非本机地址必须使用 https".into());
    }
    Ok(())
}

async fn download_capped(url: &str, limit: usize) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt as _;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("创建下载客户端失败: {e}"))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("下载失败: HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|len| len > limit as u64)
    {
        return Err(format!("下载内容超过 {} MB", limit / 1024 / 1024));
    }
    let mut stream = response.bytes_stream();
    let mut data = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断: {e}"))?;
        if data.len() + chunk.len() > limit {
            return Err(format!("下载内容超过 {} MB", limit / 1024 / 1024));
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}

// ==================== IPC ====================

#[tauri::command]
pub async fn plugins_list(app: AppHandle) -> Result<Vec<PluginView>, String> {
    let cfg_dir = crate::config::config_dir(&app)?;
    Ok(scan_plugins(&cfg_dir))
}

#[tauri::command]
pub async fn plugins_install(app: AppHandle, path: String) -> Result<PluginView, String> {
    let src = PathBuf::from(path);
    install_from_dir(&app, &src)
}

#[tauri::command]
pub async fn plugins_install_zip(app: AppHandle, path: String) -> Result<PluginView, String> {
    install_from_zip(&app, &PathBuf::from(path))
}

#[tauri::command]
pub async fn plugins_install_url(app: AppHandle, url: String) -> Result<PluginView, String> {
    validate_download_url(&url)?;
    let data = download_capped(&url, MAX_PLUGIN_BYTES as usize).await?;
    let cfg_dir = crate::config::config_dir(&app)?;
    let tmp = stage_dir(&cfg_dir, DOWNLOAD_PREFIX)?.with_extension("zip");
    fs::write(&tmp, &data).map_err(|e| format!("写入临时文件失败: {e}"))?;
    let result = install_from_zip(&app, &tmp);
    let _ = fs::remove_file(&tmp);
    result
}

#[tauri::command]
pub async fn plugins_uninstall(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_plugin_id(&id) {
        return Err("插件 id 非法".into());
    }
    let cfg_dir = crate::config::config_dir(&app)?;
    let target = plugins_dir(&cfg_dir).join(&id);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|e| format!("卸载插件失败: {e}"))?;
    }
    let mut state = load_state(&cfg_dir);
    state.enabled.remove(&id);
    save_state(&cfg_dir, &state)?;
    Ok(())
}

#[tauri::command]
pub async fn plugins_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    if !valid_plugin_id(&id) {
        return Err("插件 id 非法".into());
    }
    let cfg_dir = crate::config::config_dir(&app)?;
    if !plugins_dir(&cfg_dir).join(&id).join(MANIFEST_FILE).is_file() {
        return Err(format!("插件 {id} 未安装"));
    }
    let mut state = load_state(&cfg_dir);
    state.enabled.insert(id, enabled);
    save_state(&cfg_dir, &state)
}

#[tauri::command]
pub async fn plugins_market_refresh(_app: AppHandle, url: String) -> Result<Value, String> {
    validate_download_url(&url)?;
    let data = download_capped(&url, MAX_MARKET_BYTES).await?;
    let mut value: Value =
        serde_json::from_slice(&data).map_err(|e| format!("市场索引不是有效 JSON: {e}"))?;
    // 两种常见形态都接受:数组,或 {items:[...]}/{plugins:[...]}。
    if value.is_array() {
        value = serde_json::json!({ "items": value });
    }
    let items = value
        .get("items")
        .or_else(|| value.get("plugins"))
        .and_then(|v| v.as_array())
        .ok_or_else(|| "市场索引缺少 items 数组".to_string())?;
    if items.len() > 500 {
        return Err("市场索引条目过多".into());
    }
    Ok(value)
}
