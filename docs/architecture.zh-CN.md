# 导入工具架构

状态：**已实现**。本文按代码的实际形状描述组件边界，而不是描述计划。

**语言**：[中文](architecture.zh-CN.md) · [English](architecture.en.md) · [返回目录](../README.md)

---

## 分层

```text
packages/utool-core        引擎中立：格式、容器、求解、校验、安装、回执
providers/engine-<name>    引擎适配器：容器格式 + 需求比较
apps/cli                   CLI：参数解析、适配器加载、三种输出模式
frontends/<engine>-editor  各引擎的可视化前端（当前只有 Unity）
```

核心**没有** `if (engine === 'unity')` 这样的分支。两个证据可以在代码里核对：

- `packages/utool-core/src/` 中 `unitypackage` 只出现在**注释**里（5 处，全在解释「核心刻意不认识
  它」），可执行代码里 **0 处**；
- 用只装核心的容器注册表去校验一个真实 unitypackage，会以 `E-ARTIFACT-FORMAT-UNSUPPORTED`
  失败——这是测试断言的行为，不是文档声明。

---

## 流水线

```text
    RegistrySource        读 index.yaml，按 manifestPath 取回 tool.yaml
          |
          v
    parseUtool + checkHeader    YAML -> 映射；校验 kind 与 formatVersion
          |
          v
    ToolManifest          引擎中立的视图 + 按引擎取 target()
          |
          v
    resolveSelection      必需依赖闭包、约束、成环、能力冲突、
                          （可选）为 injects 选定提供者
          |
          v
    planInstallation      逐个 (工具, 引擎) 取回并校验制品 —— 不写盘
          |
          v
    [ 前端确认 ]           用户看到文件、体积、每个工具为何被纳入
          |
          v
    executeInstall        写入，并经容器处理器解包
          |
          v
    ReceiptStore          每个工具一份回执，含版本指针与所装文件
```

`planInstallation` 与 `executeInstall` 是**刻意分开**的两段。计划阶段校验每一个制品；只要有一个
不合格就抛错，**一个字节都不会写**。因此「下载坏了导致半安装」在结构上不可能发生。

除 `planInstallation` 的取回与 `executeInstall` 的写盘之外，每个阶段都是纯的。求解与规划**不需要**
编辑器、**不需要**网络即可测试。

---

## `packages/utool-core` —— 核心

| 模块 | 职责 |
| --- | --- |
| `loader.js` | 单个 YAML 文档、根必须是映射、`kind` / `formatVersion` 显式校验，**UTF-8 BOM 单独报错**（它会悄悄改写第一个键名，使所有查找落空） |
| `schema.js` | draft-07 JSON Schema 子集，与 Python 校验器实现同一子集，使 CI 门禁与后端对「合法」的判断一致 |
| `manifest.js` | `ToolManifest` 与 `ToolTarget`；引擎中立的取值器在上层，引擎相关的都在 `target(engine)` 之后 |
| `format.js` | 封闭词汇表：`kind`、`formatVersion`、制品类型、核心归档格式、能力名与制品名解析 |
| `containers.js` | `ContainerRegistry` 与核心处理器（`zip` / `tgz` / `tar.gz` / `tar.zst` / 单文件） |
| `artifacts.js` | 大小、`sha256`、容器魔数，以及对**条目名与目标路径**的越界检查 |
| `resolver.js` | 依赖闭包、约束、成环、能力冲突与提供者选择 |
| `install.js` | 计划与执行两段；唯一的写入上下文在此 |
| `receipts.js` | 回执读写、共享文件引用计数、版本指针与回滚规划 |
| `registry.js` | 注册库校验（与 Python 校验器平行的同一套规则） |
| `source.js` | 本地目录与 HTTP 两种来源 |

### 容器处理器契约

适配器实现两个钩子，二者共用同一套条目读取逻辑，所以**校验期的文件清单与写入期的文件清单不可能
不一致**：

```js
{
  id: 'unity:unitypackage',
  formats: ['unitypackage'],
  inspect(bytes, artifact, ctx) { /* 报告目标，不写盘 */ },
  async extract(bytes, artifact, ctx) { /* 经 ctx 写盘，返回项目相对路径 */ },
}
```

路径解析由核心的**写入上下文**持有，而不是交给处理器：`ctx.resolve()` 套用 `contentRoot`、
拒绝任何越出工程根的路径，`ctx.relative()` 给出上报回执用的项目相对路径。

> 这条规则是被一个真实缺陷逼出来的：归档处理器一度上报**归档内**的路径而非落盘位置。没有
> `contentRoot` 时二者相同，所以没人发现；有 `contentRoot` 时（Godot 的 `addons/core_utils`）
> 回执写的是 `plugin.cfg`，而文件在 `addons/core_utils/plugin.cfg`——**卸载会查错位置并留下残留**。
> 现在有一条测试断言：回执里的每个路径都必须在磁盘上存在。

---

## `providers/` —— 引擎适配器

适配器对核心只贡献两样东西，而且可以只贡献其中一样：

| 适配器 | 容器处理器 | 需求比较 | 说明 |
| --- | --- | --- | --- |
| `engine-unity` | `unitypackage` | `minEngineVersion`、`minRuntimeVersion` | Unity 制品是专有格式，所以需要处理器 |
| `engine-godot` | **无** | `minEngineVersion` | Godot 插件就是普通归档，核心本来就能打开 |

`meetsRequirement(engine, key, value, host)` 返回三态，**这个区分是刻意的**：

| 返回值 | 含义 |
| --- | --- |
| `true` | 宿主满足该下限 |
| `false` | 宿主不满足 |
| `undefined` | **本适配器无法判断该键**，于是核心**报告**该下限而不强制它 |

若对不认识的键返回 `false`，一旦有人新增一个需求键，安装就会被静默阻断——那正是适配器分离要避免
的耦合。

---

## `apps/cli` —— CLI

| 模块 | 职责 |
| --- | --- |
| `bin/utool.js` | 命令分发与呈现 |
| `lib/adapters.js` | **唯一**声明存在哪些引擎的地方；动态 import，所以只处理通用归档的调用方不依赖任何引擎包 |
| `lib/args.js` | 参数解析，含可重复取值的标志与 camelCase 键映射 |
| `lib/records.js` | 面向嵌入方的行记录输出 |
| `lib/output.js` | 表格、JSON、警告 |
| `lib/host.js` | 从 `ProjectSettings/ProjectVersion.txt` 读编辑器版本 |
| `lib/write-index.js` | 重新生成 `index.yaml` |

命令：`list`、`show`、`plan`、`verify`、`install`、`uninstall`、`rollback`、`status`、`validate`。

**主引擎的适配器是必需的**：用户要求装进一个本构建服务不了的引擎时，拿另一个引擎的字节顶上就是
错的。**额外引擎（`--also-engine`）是尽力而为**，缺适配器时报警告并跳过，好让请求的安装照常完成。

---

## `frontends/unity-editor` —— Unity 前端

C# 侧**不含任何格式逻辑**：不解析 `.yaml`、不做依赖求解、不算哈希。它只调 CLI 并渲染结果。

| 类型 | 职责 |
| --- | --- |
| `CliRunner` | 定位并运行 CLI；`UTOOL_CLI` 或从工程向上找 `ToolImport/apps/cli/bin/utool.js`；用 `ArgumentList` 避免路径空格问题 |
| `BackendRecords` | 解析行记录流；字段顺序必须与 `records.js` 一致 |
| `ImportToolWindow` | 工具栏（注册库地址、引擎选择器）、工具列表、按 target 分块的详情面板、计划确认、安装 |

**为什么用行记录而不是 JSON**：`UnityEngine.JsonUtility` 无法反序列化顶层数组，而在编辑器里手写
JSON 解析会重复属于后端的逻辑。把记录流按 TAB 切开小到可以一眼看出正确性，且未知记录类型可以被
忽略，所以后端新增记录类型不会打挂旧窗口。

详情面板**刻意不写死需求键名**，而是把后端报出的键原样打印。哪些键存在是适配器的事，所以适配器
新增一个键时，窗口不需要改。

### 文件构成

```text
frontends/unity-editor/Editor/
├─ CliRunner.cs         定位并运行后端 CLI，捕获其输出
├─ BackendRecords.cs    解析行记录（--records）流
├─ ImportToolWindow.cs  窗口：列表、详情、校验、安装
└─ DevCat.ToolImport.Editor.asmdef
```

### 放进一个工程

**为什么值得做薄**：如果工程有**编译错误**，Unity 不加载任何编辑器程序集，`Editor/` 下的东西全都
不会运行——窗口打不开，也帮不上忙。但后端可以：

```pwsh
node apps/cli/bin/utool.js validate ../ToolRegistry
node apps/cli/bin/utool.js plan core-editor-utils --registry ../ToolRegistry
node apps/cli/bin/utool.js install core-editor-utils --project "C:\path\to\UnityProject"
```

**这就是整个拆分的理由**：窗口只是「一个不依赖 Unity 也能工作的工具」之上的便利层。

窗口按以下顺序定位后端与注册库：

| 找什么 | 查找方式 |
| --- | --- |
| CLI 脚本 | `UTOOL_CLI` 环境变量；否则从工程向上走，找 `ToolImport` 检出 |
| Node | `UTOOL_NODE` 环境变量；否则用 `PATH` 上的 `node` |
| 注册库 | `UTOOL_REGISTRY` 环境变量；否则找兄弟目录 `ToolRegistry`；再否则用已发布的 GitHub raw URL |

等到前端成为 UPM 包之后，把 `Editor/` 放进工程（或按 Git URL 添加该包），并在后端检出里跑一次
`npm install`，让 `yaml` 依赖就位。

### 这里尚未实现

- **卸载。** 后端能算出精确的卸载计划（`utool uninstall --dry-run`）并做共享文件引用计数，但**执行**
  是刻意仍然关闭的：删文件是最后才该打开的能力。
- **外部 git 求解。** 后端把这类工具报告为「由调用方求解」；前端显示上游 URL 与 ref，而不是假装
  安装它。

---

## 已定下的边界

| 决定 | 理由 |
| --- | --- |
| 注册库是只读数据；只有前端负责写入 | 「无污染」只在一处可强制 |
| 写入之前校验整个计划 | 避免难以向用户描述的半安装状态 |
| 回执放在 `Library/` 下 | Unity 从不提交 `Library/`，本地状态在构造上无法泄漏进使用者的版本控制 |
| 错误是值，不是异常 | 前端需要一次展示**全部**求解问题，而不是第一个 |
| 核心不认识引擎；适配器注册格式 | 这是「跨引擎」不靠承诺而靠结构成立的原因 |
| 回执记录**文件实际所在**的路径 | 否则卸载会查错位置并留下残留 |

规范性数据契约见
[`../../ToolRegistry/docs/FRONTEND-INTEGRATION.zh-CN.md`](../../ToolRegistry/docs/FRONTEND-INTEGRATION.zh-CN.md)，
放置理由见 [`decisions.zh-CN.md`](decisions.zh-CN.md)。
