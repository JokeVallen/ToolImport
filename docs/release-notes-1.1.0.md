# ToolImport 1.1.0

Godot 前端按 Unity 的形状重做：**菜单打开浮动窗口**、**配置在设置窗口里**、**自动找到后端**。
另外注册库新增两个 Godot 工具，其中一个有两个版本、另一个带依赖，用来真正测版本菜单与依赖面板。

The Godot front end is now the same shape as the Unity one: a menu entry, a floating window, and a
Settings window. Three more things became testable because the registry gained Godot payloads.

## 界面 / The window

- **入口**：`项目 → 工具 → Tool Import`（Unity 是 `Window → ToolRegistry → Import Tool`）。
- **浮动窗口**，不再是停靠面板。
- **工具栏与 Unity 一致**：注册库末级名称（悬停看完整路径）、Refresh、Settings、搜索。
- **配置在 Settings 里**：注册库、CLI、Node 三项，并显示它们**当前解析成什么**。
- 首次运行找不到 CLI 时，设置窗口会自己打开。

## 不需要配置 / No configuration needed

解析顺序与 Unity 完全一致：

| 项 | 顺序 |
| --- | --- |
| 注册库 | 设置窗口 → `UTOOL_REGISTRY` → 从工程向上找 `ToolRegistry`/`DevCatToolRegistry` → 已发布 URL |
| CLI | 设置窗口 → `UTOOL_CLI` → 从工程向上找 `ToolImport/apps/cli/bin/utool.js` |
| Node | 设置窗口 → `UTOOL_NODE` → PATH 上的 `node` |

几个仓库并排放的工作区，第一次打开就能用。

## 计划块 / The plan block

按行数取高，超过 220px 后自己滚动。之前它会一路顶到窗口底部，把"已验证/未验证"那行挤出去。

## 新增可测的 Godot 工具 / New Godot payloads

| 工具 | 说明 |
| --- | --- |
| `godot-node-utils` 1.0.0 / 1.1.0 | 两个版本，用来测右键版本菜单 |
| `godot-scene-router` 1.0.0 | 依赖 `godot-node-utils`，用来测依赖面板与多工具计划 |

安装 `godot-scene-router` 的计划会列出两个制品（`addons/node_utils` 与 `addons/scene_router`）。

## 已验证 / Verified

| 项目 | 结果 |
| --- | --- |
| `npm run check:godot`（4.7.2） | 5 个脚本编译通过；带插件启动编辑器无报错 |
| 注册库 | 27 项校验通过；两个新载荷的 GDScript 也用 4.7.2 编译通过 |
| 后端测试 | 111 项通过 |

**未验证：逐项点击。** 菜单项、窗口布局、设置窗口、右键版本菜单、安装确认框仍需你实际点一遍。

## 升级 / Upgrade

覆盖 `res://addons/tool_import/`。**注意**：`tool_import_dock.gd` 已改名为 `tool_import_window.gd`，
旧文件请删掉，否则会残留一个不再使用的脚本。
