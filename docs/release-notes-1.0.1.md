# ToolImport 1.0.1

修 1.0.0 里 Godot 插件**编译不过**的问题。CLI、Unity 前端与注册库数据没有变化。

1.0.0 shipped a Godot addon that did not compile. This patch fixes it; the CLI, the Unity front end
and the data format are unchanged.

## 改了什么 / What changed

- **`EditorSettings.get_setting(key, default)` 只接受一个参数。** 设置读取改为经过一个包装函数，
  用 `has_setting()` + 单参 `get_setting()`，默认值只在一个地方处理。
- **若干 `:=` 声明没有可推断的类型。** 无类型数组的元素是 `Variant`，`var id := fields[0]` 因此
  推断失败。`Backend.of()` 现在返回 `Array[PackedStringArray]`，从源头解决，而不是给每个循环加注解。
- `plugin.cfg` 的版本号随发布更新。

## 向前兼容 / Forward compatibility

插件的实现只用 Godot 4.x 的稳定接口，没有按版本分支，也没有用 4.7 才有的新 API：

`EditorPlugin` / `add_control_to_dock`、`EditorInterface.get_editor_settings`、`ItemList`、
`PopupMenu` 子菜单、`FileDialog`、`RichTextLabel.push_meta`、`Thread` + `OS.execute`。

`npm run check:godot` 会拿**你本机装的那个 Godot** 去编译并加载插件，所以升级编辑器之后再跑一次，
就能知道有没有被新版本破坏。

## 已验证 / Verified

| 项目 | 结果 |
| --- | --- |
| `npm run check:godot`（Godot 4.7.2） | 3 个脚本全部通过编译；带插件启动编辑器无报错 |
| 后端测试 | 111 项通过 |
| Unity 前端 | 类型检查通过 + 行为测试通过 |

**仍未验证：界面逐项点击。** 编译与加载通过不等于按钮都好用——面板布局、右键菜单、目录选择、
计划块滚动，需要你在编辑器里过一遍。有问题请贴出 `utool ... --records` 的输出。

## 升级 / Upgrade

用 `toolimport-godot-1.0.1.zip` 覆盖 `res://addons/tool_import/` 即可，设置（注册库/CLI 路径）
保存在编辑器设置里，不会丢。

## 兼容性 / Compatibility

- 元信息格式：`formatVersion 3`。记录契约：`recordsVersion 2`。
- Godot：4.x（在此次发布的验证中为 4.7.2）。Unity：2020.3+。
