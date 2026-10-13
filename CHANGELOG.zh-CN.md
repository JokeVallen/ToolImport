# 变更记录

导入工具的所有重要变更都记录在此。

格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。工具自身有独立版本号；它读取的
元信息格式由 `formatVersion` 单独编号，见
[`../DevCatToolRegistry/docs/SPEC.zh-CN.md`](../DevCatToolRegistry/docs/SPEC.zh-CN.md)。

**语言**：[中文](CHANGELOG.zh-CN.md) · [English](CHANGELOG.en.md)

## [未发布]

### 关于这份文件

以下工作是**一次连续推进**中完成的：既把工具建起来，也同时把元信息格式升到 `formatVersion 2`。
因此条目按**领域**分组，而不是按发布日期。这里的东西**都尚未发布**。

## 工具建成，格式升到 v2

### 新增

- `packages/utool-core`——引擎中立的核心：`.utool` 文档加载、draft-07 JSON Schema 子集、注册库
  校验、依赖与能力求解、制品校验、安装的计划与执行、回执。
- **容器注册表**，使核心永远不必知道任何引擎名。核心注册 `zip`、`tgz`、`tar.gz`、`tar.zst` 与
  单文件载荷的处理器；引擎适配器注册它自己拥有的格式。**同一格式被注册两次是错误，而不是后注册者
  静默胜出。**
- 容器处理器契约——`inspect(bytes, artifact, ctx)` 只报告目标不写盘，`extract(bytes, artifact,
  ctx)` 负责写入。两者共用同一套条目读取逻辑，因此**校验期的文件清单与写入期的清单不可能不一致**。
- **写入上下文**持有路径解析：套用 `contentRoot`、拒绝任何越出工程根的路径，所以处理器无法自行决定
  路径。
- `providers/engine-unity`——`unitypackage` 容器，以及 Unity 版本与 .NET API 级别的比较。
- `providers/engine-godot`——Godot 版本比较，并**刻意不提供**容器处理器，因为 Godot 插件就是核心
  本来就能打开的普通归档。
- **三态**的需求比较：适配器返回 `true`、`false`，或 `undefined` 表示「本适配器无法判断该键」。
  对 `undefined`，核心**报告**该下限而不强制它。
- `apps/cli`——`utool`，含 `list`、`show`、`plan`、`verify`、`install`、`uninstall`、`rollback`、
  `status`、`validate`；退出码 0/1/2/3/4 由 CI 与前端共用；三种输出模式：叙述、`--json`、
  `--records`。
- `frontends/unity-editor`——一个**不含任何格式逻辑**的 Unity 窗口：它调 CLI 并渲染记录。工具栏有
  引擎选择器；详情面板**原样打印**需求键，而不是写死 Unity 的那两个。
- `tools/csharp-check.mjs`——用最小 Unity 桩类型对**真实** C# 前端做类型检查，所以在一台没装 Unity
  的机器上大约一秒就能暴露 C# 错误。
- 带**版本指针**的回执：`previousSha256` 记录本次安装替换掉了什么，`planRollback` 报出该恢复的
  摘要，`clearRollback` 在用掉指针后将其退役，而 `utool rollback` 把它呈现出来。
- 能力提供者选择：`--auto-provider` 让解析器通过**确定性**地选定提供者（id 最小者胜出）来满足
  `injects`，并报出备选项。**默认关闭**，因为静默塞进用户没要的工具比说明缺口更糟。
- 核心与 CLI 的测试：文档解析、semver-lite 约束、注册库校验、依赖与能力求解、制品校验、带回执的
  安装、回滚指针、共享文件引用计数、参数解析。核心套件会校验 `../DevCatToolRegistry` 里的
  **真实**注册库。

### 变更

- `--records` 新增 `TARGET` 与 `PROVIDER` 两种记录，`TOOL` / `PLANTOOL` 的形状也变了——因为对跨
  引擎工具来说，引擎特定数据**无法拍平**而不丢失「它属于哪个引擎」。
- Unity 前端从 `apps/unity-editor` 移到 `frontends/unity-editor`，使接缝两侧的布局都读作
  「一个引擎一个目录」。
- 仓库改名后，根 workspace 名从 `unitydevcommonlib-import-tool` 更正为
  `devcattoolregistry-import-tool`。

### 修复

- **`--also-engine godot` 曾被解析成 `--also-engine g`。** 该标志不接受取值，于是下一个词元变成
  位置参数，引擎名丢掉首字母；失败以 `no adapter for engine 'g'` 的形式出现在离原因很远的地方。
  可重复取值的标志现在是独立类别，并会累积。
- **回执记录的是归档内相对路径，而不是文件的落盘位置。** 没有 `contentRoot` 时二者相同，所以没人
  察觉；有 `contentRoot` 时（Godot），文件被记成 `plugin.cfg` 而实际在
  `addons/core_utils/plugin.cfg`，**卸载会查错位置并留下残留**。这个缺陷存在期间**所有单元测试都是
  绿的**——因为它们测的是归档读取器，不是回执。
- **`--also-engine` 缺适配器会杀掉整个运行。** 主引擎的适配器**仍然必需**，因为拿另一个引擎的字节
  顶上就是错的；额外引擎现在只报警告并跳过，好让请求的安装照常完成。
- `printPlan` 仍在遍历 v1 的 `tool.files` 字段，导致每次 `utool install` 都先打印一个看起来正确的
  计划，然后在写入任何内容之前抛出 `TypeError: tool.files is not iterable`。
- records 模式下曾把一行 `host:` 提示信息写进 stdout，污染了 Unity 前端要解析的那条流。
- C# 前端有**三处过期字段引用**，而且**从未被编译过**；上面那个类型检查工具就是为此而加，让这类
  过期不再可能悄悄发布出去。

### 已知限制

- **C# 前端从未在真实 Unity 编辑器里运行过。** 它编译 0 错误 0 警告，API 调用也逐个核对过 Unity
  的签名，但它的运行时行为**未经验证**。
- **卸载执行未启用。** 精确的卸载计划与引用计数已实现并测试；真正删文件是**刻意**留到最后才开的
  能力。
- **回滚只做规划。** 注册库每个工具只发布一个版本，所以被替换掉的字节通常已经不在库里；**说明
  「需要重新发布哪个摘要」才是诚实的行为**。
- **外部来源未被求解。** 后端把 `external` target 报告为「由调用方求解」，而不是自己去 shell out
  到 git。
