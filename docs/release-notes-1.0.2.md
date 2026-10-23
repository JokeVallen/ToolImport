# ToolImport 1.0.2

修 Godot 面板"填好路径也列不出工具"的问题。CLI 与 Unity 前端不受影响。

The Godot pane listed nothing even with the paths filled in. This patch fixes the three defects
behind that; the CLI and the Unity front end are unchanged.

## 三个缺陷 / Three defects

1. **解析器读不到记录。** Windows 上 `OS.execute` 把整段输出放进**一个**数组元素，而解析器只按
   数组元素分行——于是 `list --records` 变成一条 91 字段的假记录。现在每个元素内部也按行切。
2. **计划通过了却报"未通过"。** `ok` 在 `PLAN` 记录里，不在 `RESULT` 里，而代码只读了 `RESULT`。
3. **面板被编辑器自动翻译成半中半英。** `Node`→节点、`Install`→安装，`Registry` 却不变。这些控件
   已关闭自动翻译（带版本保护，老版本 4.x 不受影响）。

## 还顺手改了 / Also

- 三个路径框撑满宽度并各带一个选择按钮——手打路径是最容易出错的环节。
- 工具列表为空时说明原因（没填路径 / 本注册库暂无 Godot 工具）。

## 这次是怎么验的 / How this was verified

用你本机的 Godot 4.7.2 做的，不是"写完就发"：

| 检查 | 结果 |
| --- | --- |
| `npm run check:godot` | 3 个脚本编译通过；带插件启动编辑器无报错 |
| 真实 CLI 走 `backend.gd` | `list` 16 条记录、`show` 31 条、`plan` 8 条、`status` 1 条，字段与面板下标逐一核对 |
| 端到端安装 | 在临时工程里 `install` → `status` → `uninstall`，落点与回执正确 |

**仍未验证：界面的点击流程。** 按钮、右键版本菜单、目录选择、计划块滚动仍需你在编辑器里过一遍。

## 升级 / Upgrade

用 `toolimport-godot-1.0.2.zip` 覆盖 `res://addons/tool_import/`，或在 Godot 里重新加载项目即可。
