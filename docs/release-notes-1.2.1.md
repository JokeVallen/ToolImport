# ToolImport 1.2.1

两处界面细节：版本号与行距。除此之外不动。

Two details in the windows: the version, and the line spacing. Nothing else.

## 改了什么 / What changed

1. **显示导入工具自己的版本号** —— Godot 状态行右侧 `Tool Import 1.2.1`，取自插件自带的 `plugin.cfg`；
   Unity 同一行右端，取自 `Editor/ToolImportVersion.cs` 里的常量。
2. **Godot「Installs / Plan」行距收紧** —— 计划内部不再有容器默认间距，行字号小一号，标题紧贴第一行。

## 版本一致性 / Version agreement

两个前端被复制进工程后都看不到仓库里的 `package.json`，所以它们的版本号是各自维护的。
`tools/make-release.mjs` 现在会先比对 `plugin.cfg`、`ToolImportVersion.cs` 与 `package.json`，
不一致就拒绝打包——一个"报着上个版本号"的前端，是测试发现不了的那种错。

## 升级 / Upgrade

覆盖 `res://addons/tool_import/` 即可；Unity 侧覆盖 `Editor/` 目录（新增 `ToolImportVersion.cs`）。
