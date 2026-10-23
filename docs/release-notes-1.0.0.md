# ToolImport 1.0.0

把 [ToolRegistry](https://github.com/JokeVallen/ToolRegistry) 里的工具装进工程：解析依赖、校验制品、
先出计划、确认后才写盘，并留下可卸载的回执。后端是 Node CLI，前端是各引擎编辑器里的停靠面板。

This is the first release: a Node backend (`utool`), a Unity editor front end, and a Godot addon.

## 包里有什么 / What is in the archives

| 文件 | 内容 |
| --- | --- |
| `toolimport-1.0.0.zip` | 整个仓库：CLI、核心、两个前端源码、文档与测试 |
| `toolimport-unity-1.0.0.zip` | Unity 编辑器脚本，解压到 `Assets/ToolImport/` |
| `toolimport-godot-1.0.0.zip` | Godot 插件，解压到 `res://addons/tool_import/` |
| `SHA256SUMS.txt` | 上面三个文件的摘要 |

## 环境 / Requirements

- **Node 18+**：后端唯一依赖是 `yaml`，装好后 `node apps/cli/bin/utool.js -v` 应打印 `utool 1.0.0`。
- **Unity 2020.3+**（Unity 前端）或 **Godot 4.2+**（Godot 前端）。
- 注册库：数据在 [ToolRegistry](https://github.com/JokeVallen/ToolRegistry)，本包不含 payload。

## 命令行 / CLI

```pwsh
npm install
node apps/cli/bin/utool.js list --registry ../ToolRegistry
node apps/cli/bin/utool.js show core-editor-utils@1.1.0 --registry ../ToolRegistry
node apps/cli/bin/utool.js plan imgui-lib --registry ../ToolRegistry --project "C:\path\to\UnityProject"
node apps/cli/bin/utool.js install imgui-lib --into "Assets/Plugins/IMGUILib" --project "C:\path\to\UnityProject"
node apps/cli/bin/utool.js uninstall imgui-lib --project "C:\path\to\UnityProject"
```

`plan` 会校验每个制品的尺寸与 sha256，并列出每个文件的最终落点；`install` 只在计划通过后进行。
退出码：0 成功、1 失败、2 用法、3 求解、4 平台。

Godot 工程把 `--engine godot --host-godot 4.2` 交给同样的命令；`--project` 指向含 `project.godot`
的目录时，版本可以从工程文件里读出来。

## 前端 / Front ends

两个前端都**只调用 CLI**，不含安装逻辑：

- **Unity**：把 `toolimport-unity-1.0.0.zip` 解到 `Assets/ToolImport/`，打开
  *Window → Tool Import*。
- **Godot**：把 `toolimport-godot-1.0.0.zip` 解到 `res://addons/tool_import/`，在
  *项目 → 项目设置 → 插件* 里启用 **Tool Import**，然后在面板里填注册库与 CLI 路径。

两者都先显示计划、确认后才写盘，并在回执里记录实际落点。

## 已验证 / Verified

| 项目 | 结果 |
| --- | --- |
| 后端测试 | 111 项通过（解析、约束求解、制品校验、安装、卸载、回执、记录契约、版本一致性） |
| Unity 前端 | 类型检查通过 + 记录读取的行为测试通过 |
| 注册库数据 | 与 `formatVersion 3` 的清单校验、索引与生成文档一致 |

**未验证，请在意的部分：两个前端都没有在真实编辑器里跑过。** Unity 面板与 Godot 面板都在本机
没有编辑器的情况下写的，只过了类型检查（Unity）与代码审读（Godot）。布局、快捷键、右键菜单的
实际表现需要你第一次打开时确认；发现问题请开 issue，附上 CLI 的 `--records` 输出即可。

## 已知限制 / Known limitations

- `rollback` 只报告版本指针，不回滚字节。
- 回执里的 `Installs N file(s)` 是**声明**清单；真实落点以 `plan` 的 `PLANFILE` 为准。
- 一个工具一次只能装进一个落点；`--into` 要求恰好点名一个工具（依赖保持自己的布局）。
- 跨引擎工具按引擎分别安装，互不影响。

## 兼容性 / Compatibility

- 读取的元信息格式：`formatVersion 3`（见 ToolRegistry 的 `docs/SPEC`）。
- 记录契约：`recordsVersion 2`（新增字段不升版）。
