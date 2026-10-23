@tool
extends Window

## Configuration for the Tool Import window.
##
## IT IS A SEPARATE WINDOW, LIKE THE UNITY ONE
## -------------------------------------------
## The main window is for choosing and installing a tool. Where the registry lives is a
## machine-level fact the user sets once, and it does not belong in the middle of a task; in the
## Unity front end it is a Settings window too, and the two front ends are meant to be the same
## thing in two languages rather than two designs.

signal saved

const Paths := preload("paths.gd")

var _registry_edit: LineEdit
var _cli_edit: LineEdit
var _node_edit: LineEdit
var _resolved: RichTextLabel


func _ready() -> void:
	title = "Tool Import Settings"
	min_size = Vector2i(560, 300)
	size = Vector2i(760, 360)
	close_requested.connect(_on_close)
	_build()
	_load()


func _build() -> void:
	var root := VBoxContainer.new()
	root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	root.offset_left = 12
	root.offset_top = 12
	root.offset_right = -12
	root.offset_bottom = -12
	add_child(root)

	var heading := Label.new()
	heading.text = "Import tool settings"
	root.add_child(heading)

	var note := Label.new()
	note.text = (
		"Stored per user and per machine, not in the project. "
		+ "Leave a field empty to use the automatic behaviour described underneath."
	)
	note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	root.add_child(note)

	var grid := GridContainer.new()
	grid.columns = 2
	grid.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	root.add_child(grid)

	_registry_edit = LineEdit.new()
	grid.add_child(_label("Registry"))
	grid.add_child(_path_row(
		_registry_edit,
		FileDialog.FILE_MODE_OPEN_DIR,
		PackedStringArray(),
		"Where the tool registry lives. Empty means: UTOOL_REGISTRY, then a sibling checkout, "
		+ "then the published URL.",
	))

	_cli_edit = LineEdit.new()
	grid.add_child(_label("utool CLI"))
	grid.add_child(_path_row(
		_cli_edit,
		FileDialog.FILE_MODE_OPEN_FILE,
		PackedStringArray(["*.js ; utool.js"]),
		"Path to apps/cli/bin/utool.js. Empty means: UTOOL_CLI, then a sibling checkout.",
	))

	_node_edit = LineEdit.new()
	grid.add_child(_label("Node"))
	grid.add_child(_path_row(
		_node_edit,
		FileDialog.FILE_MODE_OPEN_FILE,
		PackedStringArray(["*.exe ; node.exe"]),
		"Path to the node executable. Empty means: UTOOL_NODE, then whatever 'node' resolves to.",
	))

	var resolved_label := Label.new()
	resolved_label.text = "In effect:"
	root.add_child(resolved_label)

	_resolved = RichTextLabel.new()
	_resolved.bbcode_enabled = false
	_resolved.fit_content = true
	_resolved.scroll_active = false
	_resolved.size_flags_vertical = Control.SIZE_EXPAND_FILL
	root.add_child(_resolved)

	var buttons := HBoxContainer.new()
	root.add_child(buttons)

	var save_button := Button.new()
	save_button.text = "Save"
	save_button.pressed.connect(_on_save)
	var clear_button := Button.new()
	clear_button.text = "Clear all"
	clear_button.pressed.connect(_on_clear)
	var close_button := Button.new()
	close_button.text = "Close"
	close_button.pressed.connect(_on_close)

	buttons.add_child(save_button)
	buttons.add_child(clear_button)
	buttons.add_child(close_button)


func _label(text: String) -> Label:
	var label := Label.new()
	label.text = text
	return label


## A field and its picker, mirroring the one in the main window.
func _path_row(edit: LineEdit, mode: int, filters: PackedStringArray, tooltip: String) -> HBoxContainer:
	var row := HBoxContainer.new()
	row.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	edit.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	edit.placeholder_text = tooltip
	edit.tooltip_text = tooltip

	var browse := Button.new()
	browse.text = "..."
	browse.pressed.connect(func() -> void: _pick(edit, mode, filters))

	row.add_child(edit)
	row.add_child(browse)
	return row


func _pick(edit: LineEdit, mode: int, filters: PackedStringArray) -> void:
	var dialog := FileDialog.new()
	dialog.file_mode = mode
	dialog.access = FileDialog.ACCESS_FILESYSTEM
	dialog.filters = filters

	var current := edit.text.strip_edges()
	if current == "":
		dialog.current_dir = Paths.project_root()
	elif mode == FileDialog.FILE_MODE_OPEN_FILE:
		dialog.current_dir = current.get_base_dir()
	else:
		dialog.current_dir = current

	dialog.file_selected.connect(func(file: String) -> void:
		dialog.queue_free()
		edit.text = file
	)
	dialog.dir_selected.connect(func(directory: String) -> void:
		dialog.queue_free()
		edit.text = directory
	)
	dialog.canceled.connect(func() -> void: dialog.queue_free())
	dialog.confirmed.connect(func() -> void: dialog.queue_free())
	add_child(dialog)
	dialog.popup_centered_ratio(0.5)


func _load() -> void:
	_registry_edit.text = Paths.setting(Paths.SETTING_REGISTRY, "")
	_cli_edit.text = Paths.setting(Paths.SETTING_CLI, "")
	_node_edit.text = Paths.setting(Paths.SETTING_NODE, "")
	_refresh_resolved()


func _on_save() -> void:
	Paths.save_setting(Paths.SETTING_REGISTRY, _registry_edit.text.strip_edges())
	Paths.save_setting(Paths.SETTING_CLI, _cli_edit.text.strip_edges())
	Paths.save_setting(Paths.SETTING_NODE, _node_edit.text.strip_edges())
	_refresh_resolved()
	saved.emit()


func _on_clear() -> void:
	_registry_edit.text = ""
	_cli_edit.text = ""
	_node_edit.text = ""
	Paths.clear_setting(Paths.SETTING_REGISTRY)
	Paths.clear_setting(Paths.SETTING_CLI)
	Paths.clear_setting(Paths.SETTING_NODE)
	_refresh_resolved()
	saved.emit()


func _on_close() -> void:
	hide()


## What the three values actually resolve to right now.
##
## The point of showing this is that an empty field is not "no answer": it is "the automatic
## one", and only the resolved value says which. Without it, a user typing nothing has no way to
## tell whether the backend will be found.
func _refresh_resolved() -> void:
	_resolved.clear()
	var registry := Paths.resolve_registry()
	var cli := Paths.resolve_cli()
	var node := Paths.resolve_node()

	_resolved.add_text("Registry: %s\n" % (registry if registry != "" else "(not found)"))
	_resolved.add_text("CLI:      %s\n" % (cli if cli != "" else "(not found)"))
	_resolved.add_text("Node:     %s" % node)
