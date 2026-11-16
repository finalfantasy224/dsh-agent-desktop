# dsh-agent-desktop

DeepSeek Harness 插件：把 [`agent-desktop`](https://github.com/vercel-labs/agent-desktop) CLI 的桌面自动化能力暴露成模型可调用的 `desktop_*` 工具。

agent-desktop 读取操作系统的无障碍树（Linux 上是 AT-SPI），返回带引用（`@snapshot:eN`）的 JSON，操作只走语义动作，不移动鼠标、不抢焦点。

## 依赖

- `agent-desktop` 可执行文件在 PATH 上：`npm install -g agent-desktop`
- 一个真实的桌面会话（X11 或 Wayland，需有 AT-SPI 总线）

```bash
agent-desktop status    # accessibility: granted，supported_surfaces 非空
```

## 工具

| 工具 | 作用 |
|---|---|
| `desktop_list_windows` | 列出可见窗口（应用名、标题、窗口 id、bounds） |
| `desktop_snapshot` | 读一个窗口的无障碍树，返回带 ref 的 JSON；`surface` 参数可读弹层 |
| `desktop_find` | 按 role/name/text/value/description 定位元素，不必拉整棵树 |
| `desktop_click` | 按 ref 语义点击 |
| `desktop_type` | 按 ref 输入文本（走 stdin，不进进程参数） |
| `desktop_get` | 读元素属性，用于验证动作结果 |
| `desktop_press` | 发送按键组合 |
| `desktop_wait` | 等窗口标题或文本出现 |
| `desktop_launch` | 启动应用 |
| `desktop_focus` | 把窗口提到前面并确认拿到焦点 |
| `desktop_mouse` | 按屏幕坐标点击/移动，给无障碍树读不到的元素兜底 |
| `desktop_clipboard_set` | 写剪贴板（走 stdin，不进进程参数，上限 128 KiB） |
| `desktop_clipboard_get` | 读剪贴板（text / auto / image / file-urls） |

`surface` 在 Linux（AT-SPI）后端支持 `window / sheet / alert / menu / system-tray` 五种，其余值会返回 `INVALID_ARGS`。对话框、菜单、搜索弹层都不在窗口树里，必须用 surface 读。

`desktop_snapshot` 的 `timeout_ms`（默认 10000）是观察截止时间。给太短会读到"未经证明唯一"的 ref，后续 `desktop_click` / `desktop_type` 直接回 `AMBIGUOUS_TARGET`——飞书的搜索框就是这个坑，3000 ms 必踩。

`desktop_find` 的渲染会滤掉匿名祖先节点，只留具名节点和控件角色，并标出可点数量。

contenteditable 编辑器（飞书、微信、Slack 等 Electron 应用）`desktop_type` 打不进去，标准解法是 `desktop_clipboard_set` + `desktop_press ctrl+v`：剪贴板粘贴不受 role 检查限制，也不受输入法组字状态影响。

所有工具返回 CLI 原始 JSON 信封：

```json
{ "ok": true,  "data": { "disposition": { "delivery": "delivered_verified", "retry": "unsafe" } } }
{ "ok": false, "error": { "code": "STALE_REF", "suggestion": "...", "disposition": { "retry": "safe" } } }
```

失败不抛异常，而是渲染成 `FAILED [CODE] ... suggestion: ...` 的文本，模型能看到错误码和重试建议。

## 配置

```yaml
- insert:
    - id: agent-desktop
      name: 'dsh-agent-desktop'
      config:
        command: agent-desktop   # 可执行文件名或绝对路径
        timeoutMs: 30000         # 单次调用上限
```

## 使用纪律

1. **ref 只属于产生它的快照**。界面变了要重新 `desktop_snapshot`，否则 `STALE_REF`。
2. **只信 `disposition.delivery == delivered_verified`**。`delivered_unverified` 必须再用 `desktop_get` 或新快照确认。
3. **`retry` 为 `unsafe` 时不要重试**，会重复提交。
4. **先 `desktop_list_windows` 再 `desktop_snapshot`**；多窗口应用传 `window_id`。
5. **动作后验证**：语义点击不保证应用真的响应。
6. **物理输入前先 `desktop_focus`**：`press`、`mouse`、指针动作都落在焦点窗口上。
7. **坐标点击是最后手段**：优先 `desktop_click`；`desktop_mouse` 的坐标来自元素 bounds、截图或用户，工具本身不识别任何东西。

## 已知限制

- **Wayland 会话**：窗口移动/缩放、指针手势、截图、剪贴板都不可用；只剩读树、语义点击、键盘。需要完整能力请用 Xorg 会话。
- **菜单项点击有竞态**：菜单能打开也能读，但点击时 popover 可能已关闭（`ELEMENT_NOT_FOUND`）。优先用应用内快捷键。
- **Electron/Chromium 应用**：树很深，`find` 默认 5 s 预算常超时，插件已把 `timeout_ms` 默认调到 15 s；Chrome 需要 `--force-renderer-accessibility` 启动。
- **Electron 应用可能整棵树不可用**：飞书（Feishu）没有 `textbox` 角色、会话行零个具名节点；搜索弹层要 `surface: sheet` 才读得到，消息气泡只以 `statictext` 形式露出（够做验证，不够做导航）。
- **contenteditable 输入框打不进去**：`desktop_type` 对飞书的搜索框和消息框都返回 `ACTION_NOT_SUPPORTED: role group is not editable`，加 `--headed` 也一样。用 `desktop_clipboard_set` + `desktop_press ctrl+v` 绕过。
- **剪贴板会覆盖用户内容**：`desktop_clipboard_set` 是全局副作用，写完最好把原内容读回来还原。
- **全屏截图**在 GNOME 合成窗口管理器下不可用，只能按窗口截（本插件未暴露截图工具）。
- 快照会落盘在 `~/.agent-desktop/snapshots`，包含界面文案，注意隐私。

## 自检

不启动 DSH 也能验证插件本身：

```bash
node --input-type=module -e "
const m = await import('dsh-agent-desktop')
const tools = new Map()
m.apply({ tools: { register: d => { tools.set(d.name, d); return () => {} } } }, { command: 'agent-desktop', timeoutMs: 30000 })
console.log([...tools.keys()].join(', '))
const r = await tools.get('desktop_list_windows').execute({}, { signal: new AbortController().signal })
console.log('ok:', r.ok, 'windows:', r.data?.length)
"
```

在 profile 目录（`~/.dsh/profiles/desktop`）下运行，模块名才能解析。