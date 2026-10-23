# ToolImport 1.2.0

两个前端的界面统一到同一套排版，并把筛选、搜索和折叠补成可用的样子。

Both front ends now lay out a tool the same way, and the filter, the search and the collapse
behave.

## 改了什么 / What changed

1. **详情页顺序统一** —— 显示名、包 id、小号斜体的事实行（版本 · 类型 · **作者** · 发布日期）、外链、
   描述、各分节。Godot 侧此前没有描述一节，外链也不是链接。
2. **滚动区止于「Install Into」上方** —— 目标目录与三个按钮固定在下部，长描述顶不掉它们。
3. **「Installs」与「Plan」是一块** —— 有则显示计划，无则显示清单声明的安装目标，两者不同屏；验证后
   标题变为「Plan」。两者都画在描述所在的深色面板内。
4. **筛选八种模式** —— All / Installed / Not installed / This engine / Tag is / Provides / Injects /
   Depends on。取值模式多出第二级下拉，选项取自列表本身，默认选第一个有结果的值。
5. **搜索是前缀匹配** —— 同时匹配显示名与包 id。
6. **Unity 不再列出本引擎用不了的工具** —— 只装 Godot 的包列在 Unity 里既装不了也用不上。
7. **已安装版本标在右键菜单行首** —— `[installed] 1.1.0`。

## 修了什么 / Fixes

- Godot 的下拉、折叠、以及所有按钮：此前扁平样式与窗口底色融为一体，看着像文字；现在都有常态 / 悬停 /
  按下三态边框。
- 折叠列表真的把宽度让给详情页，展开时恢复你拖到的宽度。
- 切换筛选后右侧不再停在旧工具或「No tool matches」：忙碌时的请求改为排队（只保留最新的一个），
  筛选隐藏某工具后到达的详情回包会被丢弃。
- 安装 / 卸载完成后状态栏不再被重绘覆盖成「Ready.」。

## 升级 / Upgrade

覆盖 `res://addons/tool_import/` 即可；Unity 侧覆盖 `Editor/` 目录。
