# ToolRegistry 导入工具

[ToolRegistry](../ToolRegistry) 的配套工具：浏览注册库、校验制品、安装，并写下回执，
以便日后能干净地卸载。

**语言**：[中文](README.md) · [English](README.en.md)

---

它**不是**一个带 Unity 后端的 Unity 包。它是一个**引擎中立**的 Node/npm 后端，加上**每个引擎一个**
适配器与一个轻量编辑器前端：

```text
packages/
└─ utool-core/            后端核心：.yaml 解析、注册库校验、依赖与能力求解、
                          制品校验、安装、回执。**零引擎依赖**。

providers/
├─ engine-unity/          Unity：unitypackage 容器、Unity 版本与 .NET API 级别比较。
└─ engine-godot/          Godot：Godot 版本比较。它**不提供**容器处理器，因为
                          Godot 插件就是核心本来就能打开的普通归档。

apps/
└─ cli/                   utool —— CLI。没有 Unity 也能跑。

frontends/
└─ unity-editor/          Editor/ —— 驱动 CLI 的 Unity 窗口。
```

**两个 provider 的形状不同，这正是接缝的意义所在**：制品是普通归档的引擎，只需贡献引擎知识；
制品是专有格式的引擎，只需贡献一个容器处理器。两种情况下核心都不动。而
`apps/cli/lib/adapters.js` 里的 `knownEngines()` 是**唯一**决定「这个构建能服务哪些引擎」的地方。

## 为什么后端放在 Unity 之外

| 理由 | 后果 |
| --- | --- |
| **编译错误拦住的是 Unity，不是 Node** | 工程编译不过时不会加载任何编辑器程序集，窗口根本打不开——但 `utool install` 在 shell 里照样能跑。这是最实际的收益。 |
| **跨引擎** | 后端只认 `.yaml` 文档与归档。换引擎需要的是新前端，不是新后端。 |
| **可测试** | 求解、校验、回执都有 `node --test` 单测，不需要编辑器。 |
| **可复用于 CI** | 同一条 CLI 就能在流水线里校验注册库。 |

代价是多了一层进程边界：前端通过**输出记录**与后端通信，而不是内存中的对象。

## 前端

| 引擎 | 位置 | 状态 |
| --- | --- | --- |
| Unity 2020.3+ | `frontends/unity-editor/Editor` | 已写完并过类型检查；**从未在真实编辑器里跑过** |
| Godot 4.2+ | `frontends/godot-editor/addons/tool_import` | 已写完；**从未在真实编辑器里加载过** |

两者都是调用本 CLI（`--records`）的停靠面板，先显示计划、确认后才写盘。它们都不含安装逻辑：
版本、落点与回执由后端决定，前端只呈现。

Godot 插件就是一个普通 addons 目录——把 `frontends/godot-editor/addons/tool_import` 复制到工程的
`res://addons/`，在 **项目 → 项目设置 → 插件** 里启用，然后在面板里填注册库与 CLI 路径。引擎版本以
`--host-godot` 传入，CLI 也可以自己从 `project.godot` 读出来。

## 快速开始

```pwsh
npm install                                          # 唯一依赖是 `yaml`

node apps/cli/bin/utool.js list --registry ../ToolRegistry
node apps/cli/bin/utool.js show core-editor-utils  --registry ../ToolRegistry
node apps/cli/bin/utool.js plan editor-tool-selection-history --registry ../ToolRegistry
node apps/cli/bin/utool.js validate ../ToolRegistry
npm test
```

装进一个 Unity 工程（会写文件与回执）：

```pwsh
node apps/cli/bin/utool.js install core-editor-utils --project "C:\path\to\UnityProject"
node apps/cli/bin/utool.js status  --project "C:\path\to\UnityProject"
```

加 `--dry-run` 可以只规划与校验，不写任何东西。

清单声明的落点是**默认值**，可以用 `--into` 换成工程里的别的目录（一次只能点名一个工具；
依赖保持它自己的布局）：

```pwsh
node apps/cli/bin/utool.js install imgui-lib --into "Assets/Plugins/IMGUILib" --project "C:\path\to\UnityProject"
```

`--into` 是**工程相对路径**，绝对路径和 `..` 都会被拒绝。它替换的是**工具自己占用的那个目录**，
不是往里再套一层：例如工具默认落在 `Assets/IMGUILib`（其下有 `Core/…`），给 `Assets/Vendor`
之后，`Assets/IMGUILib/Core/x.cs` 会落到 `Assets/Vendor/Core/x.cs`，内部布局不变。默认目录由制品
里的实际路径反推得出，所以确切值在计划里（`PLANTOOL` 的 `installRoot`）。

实际落点记在回执里，所以卸载不需要再被告知一次。

## 输出模式

| 模式 | 给谁用 | 说明 |
| --- | --- | --- |
| 默认 | 终端前的人 | 对齐的表格与叙述 |
| `--json` | 脚本 | stdout 上输出一份 JSON 文档 |
| `--records` | 嵌入方（Unity 窗口） | 一行一条记录，TAB 分隔 |

`--records` 存在的原因很具体：`UnityEngine.JsonUtility` 无法反序列化顶层数组，而在编辑器里手写
JSON 解析会让「格式逻辑只存在于后端」这条原则破掉。记录类型见 `utool --help`。

**records 模式下绝不要往 stdout 写叙述**：Unity 前端会解析那条流，一句多余的信息行就会变成解析
失败。这不是假设——开发过程中一行 `host:` 提示信息确实造成了这个后果。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 一般失败（校验不过、摘要不符） |
| 2 | 用法错误 |
| 3 | 求解失败（未知工具、约束不满足、成环、能力无人提供） |
| 4 | 引擎下限不满足（引擎或运行时） |

## 测试

```pwsh
npm test                # 跑**两个**套件：packages/utool-core/test 与 apps/cli/test
npm run check:csharp    # 在没有 Unity 的机器上对 Unity C# 做类型检查
```

核心套件覆盖：文档解析、semver-lite 约束、注册库校验、依赖与能力求解（含成环、可选依赖、平台
门禁、提供者选择、无法满足的注入）、制品校验、带回执的安装、回滚版本指针、共享文件引用计数。
它还会校验 `../ToolRegistry` 里的**真实**注册库，所以一旦格式改动破坏了已发布 payload，
这里立刻失败。

CLI 套件覆盖参数解析，其中包括那个可重复标志的缺陷：`--also-engine godot` 曾被解析成
`--also-engine g`。

Unity C# 由 `tools/csharp-check.mjs` 用最小 Unity 桩类型做类型检查，所以在一台没装 Unity 的机器上
大约一秒就能暴露 C# 错误。那是**检查工具，不是随附组件**。

## 与注册库仓库的关系

```text
../ToolRegistry          数据：.yaml 文档与封存制品
本目录                          代码：解析、校验、安装
```

两者之间唯一的接口是
[`../ToolRegistry/docs/FRONTEND-INTEGRATION.zh-CN.md`](../ToolRegistry/docs/FRONTEND-INTEGRATION.zh-CN.md)
里的数据契约，加上 `schema/tool.schema.json`。只要契约不变，任一侧都可以被替换。

## 尚未实现

- **卸载执行。** 精确的卸载计划与共享文件引用计数已实现并测试；真正删文件是**刻意**留到最后才开
  的能力。
- **外部来源求解。** 后端把 `external` target 报告为「由调用方求解」，而不是自己去 shell out 到 git。
- **执行回滚。** `utool rollback` 会报出记录在案的目标摘要，但被替换掉的旧字节**不保证还在库里**
  ——维护者可以在无人钉住旧版后删掉它。**说明「需要重新发布哪些字节」才是诚实的行为**，
  假装回滚比拒绝更糟。
