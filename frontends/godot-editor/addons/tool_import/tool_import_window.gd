@tool
extends Window

## The Tool Import window: pick a tool, read what it needs, verify a plan, install it.
##
## WHAT THIS WINDOW IS FOR
## -----------------------
## Everything that decides WHAT gets written lives in the Node backend. This window chooses a
## tool and a release, shows the plan the backend produced, and asks for confirmation. It never
## decides an install path, a version or a dependency: it displays the backend's answer, which is
## the same answer the command line gives.
##
## WHY IT RUNS THE CLI INSTEAD OF REIMPLEMENTING IT
## -----------------------------------------------
## The rules - `formatVersion 3`, content roots, `--into`, receipts, the requirement gates - are
## one implementation with tests. A GDScript copy would be a second implementation of the same
## rules, and the two would disagree at the worst moment: when writing files into a project.
##
## WHY IT FLOATS INSTEAD OF DOCKING
## --------------------------------
## Installing a tool is a task with a beginning and an end, not a panel to keep in view while
## editing. A dock competes with the inspectors for width and stays open after the job is done;
## the Unity front end is a window too, and this one is opened from Project > Tools.

const Backend := preload("backend.gd")
const Paths := preload("paths.gd")
const SettingsWindow := preload("settings_window.gd")
const UiStyle := preload("ui_style.gd")

const ENGINE := "godot"

## The size the window opens at. Wide enough for the list plus a full detail pane, and short
## enough to fit a 1080p screen with room left for the editor.
const WINDOW_SIZE := Vector2i(1000, 660)

## What the list is filtered to. The Unity window offers the same eight.
enum Filter { ALL, INSTALLED, NOT_INSTALLED, THIS_ENGINE, TAG, PROVIDES, INJECTS, DEPENDS_ON }

const FILTER_LABELS := [
	"All", "Installed", "Not installed", "This engine",
	"Tag is", "Provides", "Injects", "Depends on",
]

## Width of the strip the collapsed list leaves behind, just wide enough for the expand button.
const COLLAPSED_RAIL_WIDTH := 30

var _backend: Backend = null
var _project_root := ""
var _settings_window: Window = null

var _registry_label: Label
var _search_edit: LineEdit
var _filter_button: MenuButton
var _value_button: MenuButton
var _collapse_button: Button
var _list_controls: HBoxContainer
var _list_column: VBoxContainer
var _split: HSplitContainer
var _detail_panel: PanelContainer
var _list: ItemList
var _meta: RichTextLabel
var _install_edit: LineEdit
var _installs_header: RichTextLabel
var _status: Label
var _plan_box: VBoxContainer
var _plan_scroll: ScrollContainer
var _verify_button: Button
var _install_button: Button
var _uninstall_button: Button

var _filter: Filter = Filter.ALL
var _filter_value := ""
var _filter_options := PackedStringArray()
var _list_collapsed := false
var _list_width := 200

var _tools: Array[PackedStringArray] = []
var _versions := {}
var _installed := {}
var _installed_versions := {}
var _directories := {}

var _selected_id := ""
var _selected_version := ""
# Which tool the pane is CURRENTLY describing. Empty when it holds a message instead, which is how
# a filter change can tell that the selection survived but the pane did not.
var _shown_id := ""
var _detail: Array = []
var _plan: Array = []
var _first_open := true


func _ready() -> void:
	title = "Tool Import"
	min_size = Vector2i(720, 480)
	size = WINDOW_SIZE
	# A Window becomes visible the moment it enters the tree, at the default position (0, 0) and
	# whatever size it managed to compute - which is how it first appeared in the corner with its
	# title bar off-screen. Staying hidden until open() places it is what makes the placement
	# below the first thing the user sees.
	visible = false
	close_requested.connect(hide)

	_project_root = Paths.project_root()
	_backend = Backend.new()
	_backend.finished.connect(_on_backend_finished)

	_build_ui()


## Called by the plugin before the window is shown.
func open() -> void:
	if not visible:
		popup_centered(WINDOW_SIZE)
		_place_on_screen()
	_refresh_registry_row()
	_refresh()

	# A first run with no CLI has nothing useful to show, and "the CLI was not found" in the
	# status line is a dead end unless the user knows about Settings. Open it once, and only
	# once: after that the message stands on its own.
	if _first_open and Paths.resolve_cli() == "":
		_first_open = false
		_on_settings_pressed()
	_first_open = false


# ---------------------------------------------------------------------------
# layout
# ---------------------------------------------------------------------------

func _build_ui() -> void:
	var root := VBoxContainer.new()
	root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	root.offset_left = 8
	root.offset_top = 8
	root.offset_right = -8
	root.offset_bottom = -8
	add_child(root)

	var toolbar := HBoxContainer.new()
	root.add_child(toolbar)

	# The registry in effect, as a leaf name with the full value in the tooltip: a deep checkout
	# in an editable field pushed everything else off the row in the Unity version, and this is
	# the same fix.
	_registry_label = Label.new()
	_registry_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_registry_label.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	toolbar.add_child(_registry_label)

	var refresh_button := Button.new()
	refresh_button.text = "Refresh"
	refresh_button.pressed.connect(_on_refresh_pressed)
	UiStyle.button(refresh_button)
	toolbar.add_child(refresh_button)

	var settings_button := Button.new()
	settings_button.text = "Settings"
	settings_button.pressed.connect(_on_settings_pressed)
	UiStyle.button(settings_button)
	toolbar.add_child(settings_button)

	toolbar.add_child(VSeparator.new())

	_search_edit = LineEdit.new()
	_search_edit.placeholder_text = "filter by name"
	_search_edit.custom_minimum_size = Vector2(200, 0)
	_search_edit.text_changed.connect(func(_text: String) -> void: _rebuild_list())
	toolbar.add_child(_search_edit)

	_split = HSplitContainer.new()
	var split := _split
	split.size_flags_vertical = Control.SIZE_EXPAND_FILL
	# Into `root`, not into the window: everything else is built under root, and a sibling of it
	# is laid out at the origin with no size of its own - which is how the window ended up showing
	# the toolbar and the status line with an empty body between them.
	root.add_child(split)

	# The list column: a filter row, then the list. The filter acts on this list and reads as a
	# heading over it, which is why it lives here and not in the toolbar - the same arrangement the
	# Unity window uses.
	_list_column = VBoxContainer.new()
	_list_column.custom_minimum_size = Vector2(200, 0)
	split.add_child(_list_column)

	_list_controls = HBoxContainer.new()
	_list_column.add_child(_list_controls)

	# A dropdown has to look like one: a flat button on the window background is indistinguishable
	# from a label, which is how the filter read before.
	_filter_button = MenuButton.new()
	_filter_button.text = FILTER_LABELS[0]
	_filter_button.flat = false
	_filter_button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var filter_menu := _filter_button.get_popup()
	for index in FILTER_LABELS.size():
		filter_menu.add_item(FILTER_LABELS[index], index)
	filter_menu.id_pressed.connect(_on_filter_chosen)
	UiStyle.button(_filter_button)
	_list_controls.add_child(_filter_button)

	# The list can be folded away, because the detail pane is the part being read most of the time
	# and three entries do not need a third of the width. Same gesture as the Unity window's rail.
	_collapse_button = Button.new()
	_collapse_button.text = "‹"
	_collapse_button.flat = false
	_collapse_button.tooltip_text = "Hide the tool list"
	_collapse_button.pressed.connect(_on_collapse_pressed)
	UiStyle.button(_collapse_button, 26)
	_list_controls.add_child(_collapse_button)

	# A second row appears only for the modes that take a value, and it is filled from the listing
	# itself - so it can only offer values that exist. A free-text box would let a typo produce an
	# empty list, which looks exactly like an empty registry.
	#
	# It is a dropdown for the same reason the mode is: without a frame and a hover state it read
	# as a line of text, and the second-level filter was effectively invisible.
	_value_button = MenuButton.new()
	_value_button.visible = false
	_value_button.flat = false
	_value_button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_value_button.get_popup().id_pressed.connect(_on_filter_value_chosen)
	UiStyle.button(_value_button)
	_list_column.add_child(_value_button)

	_list = ItemList.new()
	_list.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_list.item_selected.connect(_on_tool_selected)
	_list.gui_input.connect(_on_list_gui_input)
	_list_column.add_child(_list)

	var right := VBoxContainer.new()
	right.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	split.add_child(right)

	# The scrolling part ends above "Install Into": the destination field and the three buttons
	# are what the user acts on, and a long description used to push them out of reach.
	var detail_scroll := ScrollContainer.new()
	detail_scroll.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	detail_scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	right.add_child(detail_scroll)

	# One dark panel around the whole description AND the Installs block, so the plan reads as the
	# next section of the same document rather than as a widget bolted underneath.
	_detail_panel = PanelContainer.new()
	_detail_panel.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	detail_scroll.add_child(_detail_panel)

	var details := VBoxContainer.new()
	details.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_detail_panel.add_child(details)

	_meta = RichTextLabel.new()
	# BBCode on: the header mixes sizes and styles (name, id, an italic facts line) and the links
	# are real links, which is how the Unity window draws them too.
	_meta.bbcode_enabled = true
	_meta.fit_content = true
	_meta.scroll_active = false
	_meta.selection_enabled = true
	_meta.meta_clicked.connect(_on_meta_clicked)
	_meta.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	# The panel paints the background; the label must not paint a second one on top of it.
	var empty_style := StyleBoxEmpty.new()
	_meta.add_theme_stylebox_override("normal", empty_style)
	details.add_child(_meta)

	# The Installs / Plan heading is a label using the SAME bold font the rich text uses for the
	# other section headers, so it matches them in weight and colour while sitting tight above its
	# lines: as rich text it inherited the paragraph spacing and left a wide gap under itself.
	# A one-line rich text label rather than a Label: it uses the same font and bold weight as the
	# headers above it, and its height is exactly one line - a Label with a font override measured
	# 44 pixels tall for one line and left a wide gap under the heading.
	_installs_header = RichTextLabel.new()
	_installs_header.bbcode_enabled = true
	_installs_header.fit_content = true
	_installs_header.scroll_active = false
	_installs_header.text = "[b]Installs[/b]"
	_installs_header.add_theme_stylebox_override("normal", StyleBoxEmpty.new())
	details.add_child(_installs_header)

	# Horizontal scrolling only: a planned path is longer than the window, and the vertical axis
	# belongs to the pane, so this block is as tall as its lines.
	_plan_scroll = ScrollContainer.new()
	_plan_scroll.vertical_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	_plan_scroll.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	details.add_child(_plan_scroll)

	_plan_box = VBoxContainer.new()
	_plan_box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	# No separation between the lines of a plan: they are one list, and the default gap made a
	# five-line plan read as five separate paragraphs.
	_plan_box.add_theme_constant_override("separation", 0)
	_plan_scroll.add_child(_plan_box)

	# Taken from the editor theme, NOT from _meta: the label's own stylebox was just replaced with
	# an empty one, so asking it for its background returns "nothing" and the panel ends up
	# transparent - which is exactly how the black box disappeared.
	var panel_style: StyleBox = null
	var editor_theme: Theme = EditorInterface.get_editor_theme()
	if editor_theme != null:
		panel_style = editor_theme.get_stylebox("normal", "RichTextLabel")
	if panel_style == null:
		var fallback := StyleBoxFlat.new()
		fallback.bg_color = Color(0.1, 0.1, 0.11)
		fallback.set_content_margin_all(8)
		panel_style = fallback
	_detail_panel.add_theme_stylebox_override("panel", panel_style)

	var destination_header := Label.new()
	destination_header.text = "Install Into"
	destination_header.tooltip_text = (
		"Project-relative, for example addons/vendor. Absolute paths and '..' are refused.\n\n"
		+ "This REPLACES the folder the tool installs into - the files inside it keep their "
		+ "layout. Empty installs where the manifest declares; the exact paths are in the plan."
	)
	right.add_child(destination_header)

	var destination_row := HBoxContainer.new()
	_install_edit = LineEdit.new()
	_install_edit.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_install_edit.text_changed.connect(_on_destination_typed)
	var browse_button := Button.new()
	browse_button.text = "Browse..."
	browse_button.pressed.connect(_on_browse_pressed)
	var default_button := Button.new()
	default_button.text = "Default"
	default_button.pressed.connect(_on_default_pressed)
	UiStyle.button(browse_button)
	UiStyle.button(default_button)
	destination_row.add_child(_install_edit)
	destination_row.add_child(browse_button)
	destination_row.add_child(default_button)
	right.add_child(destination_row)

	var actions := HBoxContainer.new()
	_verify_button = Button.new()
	_verify_button.text = "Verify and plan (writes nothing)"
	_verify_button.pressed.connect(_on_verify_pressed)
	_install_button = Button.new()
	_install_button.text = "Install"
	_install_button.pressed.connect(_on_install_pressed)
	_uninstall_button = Button.new()
	_uninstall_button.text = "Uninstall"
	_uninstall_button.pressed.connect(_on_uninstall_pressed)
	UiStyle.button(_verify_button)
	UiStyle.button(_install_button)
	UiStyle.button(_uninstall_button)
	actions.add_child(_verify_button)
	actions.add_child(_install_button)
	actions.add_child(_uninstall_button)
	right.add_child(actions)

	# The status line and the addon's own version share one row. The version is not something a
	# user acts on, but "which release am I running" is the first question when the window
	# misbehaves, and the status row is the one row that is always there.
	var status_row := HBoxContainer.new()
	root.add_child(status_row)

	_status = Label.new()
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_status.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	status_row.add_child(_status)

	var version_label := Label.new()
	version_label.text = "Tool Import " + _version()
	version_label.tooltip_text = "The version of this addon, read from plugin.cfg"
	version_label.add_theme_font_size_override("font_size", 11)
	version_label.modulate = Color(1, 1, 1, 0.55)
	status_row.add_child(version_label)

	_set_busy(true)
	_render_empty("Press Refresh to list the registry.")
	# Godot 4.4+ translates a Control's text through the editor's own catalogue, which turned
	# "Node" into 节点 and "Install" into 安装 while "Registry" stayed English - a half-translated
	# pane reads as a broken one. Older 4.x does not translate these strings at all, so the guard
	# is a no-op there rather than a broken property name.
	_disable_auto_translation(self)


## The addon's own version, read from the plugin.cfg that ships beside this script.
##
## Read rather than hard-coded: a constant would be one more place to forget while releasing, and
## the file is guaranteed to sit next to this script in any installation layout - including one
## where the addon is not under res://addons/tool_import at all.
func _version() -> String:
	var base := ""
	var script := get_script()
	if script != null:
		base = str(script.resource_path).get_base_dir()

	var config := ConfigFile.new()
	var path := (base + "/plugin.cfg") if base != "" else "res://addons/tool_import/plugin.cfg"
	if config.load(path) != OK:
		return "?"
	return str(config.get_value("plugin", "version", "?"))


func _label(text: String) -> Label:
	var label := Label.new()
	label.text = text
	return label



## Put the window in the middle of the screen, at a size that fits it.
##
## `popup_centered` centres against the PARENT VIEWPORT, and in the editor that placed the window
## at the top-left corner with its title bar above the screen edge - the one place a window cannot
## be dragged from, so it could only be moved after resizing it. A native window can be placed
## directly; an embedded one keeps Godot's own placement, because its coordinates are relative to
## the viewport rather than to the screen.
func _place_on_screen() -> void:
	if get_window() != self:
		return
	var usable := DisplayServer.screen_get_usable_rect(DisplayServer.window_get_current_screen())
	var wanted := _preferred_size(usable)
	size = wanted
	position = usable.position + (usable.size - wanted) / 2


## A size that leaves the editor behind it, in the units this window is measured in.
##
## Fractions of the usable area rather than a fixed pixel size: Godot's window coordinates and the
## screen's physical pixels do not have to agree (a scaled display makes them differ by a third or
## more), so a fixed 1000x660 landed as a 681x477 window on a 2560x1368 desktop - considerably
## smaller than the pane needs. A proportion is right at any scale.
func _preferred_size(usable: Rect2i) -> Vector2i:
	return Vector2i(
		clampi(int(usable.size.x * 0.6), 900, 1500),
		clampi(int(usable.size.y * 0.72), 600, 1000),
	)


func _disable_auto_translation(node: Node) -> void:
	if node.get("auto_translate_mode") != null:
		node.set("auto_translate_mode", 2)  # AUTO_TRANSLATE_MODE_DISABLED
	for child in node.get_children():
		_disable_auto_translation(child)


# ---------------------------------------------------------------------------
# configuration
# ---------------------------------------------------------------------------

## The registry in effect, in the toolbar: a leaf name, with the full value on hover.
func _refresh_registry_row() -> void:
	var registry := Paths.resolve_registry()
	_registry_label.text = "Registry: " + Paths.leaf_name(registry)
	_registry_label.tooltip_text = registry


## Open the settings window, or bring the existing one forward.
##
## One instance: it holds what the user typed, and a second copy would silently discard the
## first one's unsaved edits.
func _on_settings_pressed() -> void:
	if _settings_window == null or not is_instance_valid(_settings_window):
		_settings_window = SettingsWindow.new()
		add_child(_settings_window)
		_settings_window.saved.connect(func() -> void:
			_refresh_registry_row()
			_refresh()
		)
		_disable_auto_translation(_settings_window)
	_settings_window.show_centered()


func _engine_version() -> String:
	var info := Engine.get_version_info()
	return "%d.%d.%d" % [info["major"], info["minor"], info["patch"]]


## Flags every call carries: which registry, which engine, which host.
func _common_arguments() -> PackedStringArray:
	return PackedStringArray([
		"--records",
		"--registry", Paths.resolve_registry(),
		"--engine", ENGINE,
		"--host-godot", _engine_version(),
		"--project", _project_root,
	])


func _reference() -> String:
	if _selected_id == "":
		return ""
	return _selected_id + "@" + _selected_version if _selected_version != "" else _selected_id


# ---------------------------------------------------------------------------
# backend calls
# ---------------------------------------------------------------------------

func _run(arguments: PackedStringArray) -> bool:
	_set_busy(true)

	var cli := Paths.resolve_cli()
	if cli == "":
		_set_busy(false)
		_render_empty(
			"The utool backend CLI was not found.\n"
			+ "Open Settings and point it at apps/cli/bin/utool.js, set UTOOL_CLI, "
			+ "or place a ToolImport checkout beside this project."
		)
		return false
	if not FileAccess.file_exists(cli):
		_set_busy(false)
		_render_empty("No file at that CLI path:\n" + cli)
		return false

	if not _backend.run(Paths.resolve_node(), cli, arguments):
		_set_busy(false)
		_render_empty("Could not start Node. Set the Node executable path in Settings.")
		return false
	return true


func _on_backend_finished(result: Dictionary) -> void:
	_set_busy(false)

	var records: Array = result["records"]
	var noise: PackedStringArray = result["noise"]
	var problems := Backend.problems(records)
	var exit_code: int = result["exitCode"]

	# The handler is taken BEFORE any early return: a failed call must not leave one queued for
	# the next answer.
	var handler := _pending
	_pending = Callable()

	if problems.size() > 0 or exit_code != 0:
		var message := "\n".join(problems)
		if message == "" and noise.size() > 0:
			message = "\n".join(noise)
		if message == "":
			message = "The backend exited with code %d and said nothing." % exit_code
		_status.text = message
		_flush_queued()
		return

	if noise.size() > 0:
		_status.text = "\n".join(noise)

	if handler.is_valid():
		handler.call(records)

	_flush_queued()


var _pending := Callable()
var _queued_arguments := PackedStringArray()
var _queued_handler := Callable()


## Send one command and name the handler that reads its answer.
##
## One call at a time. A call made while busy REPLACES the one waiting, and the survivor runs as
## soon as the current answer arrives.
##
## This used to refuse instead, which was wrong in the case that matters most: switching a filter
## fires a "show" for the newly selected tool while the "status" call from the refresh is still
## running, so the request was dropped, nothing repainted the pane, and the user was left looking
## at the previous tool - or at "No tool matches the current filter" - beside a list that had
## already changed. Keeping only the LATEST queued request means no intermediary state is ever
## painted over a newer one.
func _call(arguments: PackedStringArray, handler: Callable) -> void:
	if _backend.is_busy():
		_queued_arguments = arguments
		_queued_handler = handler
		return
	_pending = handler
	if not _run(arguments):
		_pending = Callable()


func _flush_queued() -> void:
	if not _queued_handler.is_valid():
		return
	var arguments := _queued_arguments
	var handler := _queued_handler
	_queued_arguments = PackedStringArray()
	_queued_handler = Callable()
	_call(arguments, handler)


# ---------------------------------------------------------------------------
# list
# ---------------------------------------------------------------------------

func _on_refresh_pressed() -> void:
	_refresh()


func _refresh() -> void:
	var arguments := _common_arguments()
	arguments.insert(0, "list")
	_call(arguments, _on_list_ready)


func _on_list_ready(records: Array) -> void:
	# `clear()` rather than `[]`: the array is typed, and an untyped literal is not the same
	# thing to assign.
	_tools.clear()
	_versions = {}

	# `Backend.of` returns a typed array, so an element is a PackedStringArray and the fields
	# below have types to infer from.
	for fields in Backend.of(records, "TOOL"):
		_tools.append(fields)

	for fields in Backend.of(records, "VERSIONS"):
		if fields.size() < 2:
			continue
		var id: String = fields[0]
		if not _versions.has(id):
			_versions[id] = []
		_versions[id].append({
			"version": fields[1],
			"latest": fields.size() > 2 and fields[2] == "latest",
		})

	_status.text = "%d tool(s) in the registry." % _tools.size()
	_refresh_filter_values()
	_rebuild_list()
	_refresh_installed()


func _supports_engine(fields: PackedStringArray) -> bool:
	# TOOL: id version type engines,csv provides,injects,displayName,tags,dependencies,manifestPath
	if fields.size() < 4:
		return false
	for engine in fields[3].split(","):
		if engine.strip_edges() == ENGINE:
			return true
	return false


func _rebuild_list() -> void:
	var needle := _search_edit.text.strip_edges().to_lower()
	var keep := _selected_id
	var kept := false

	_list.clear()
	for fields in _tools:
		if not _supports_engine(fields):
			continue
		var id: String = fields[0]
		var display: String = fields[6] if fields.size() > 6 else id
		var version: String = fields[1] if fields.size() > 1 else ""

		if not _passes_filter(fields):
			continue

		# Prefix match, not substring: typing "core" is meant to find "Core Editor Utils", and
		# typing "utils" is not meant to find everything with that word in the middle. The Unity
		# front end matches the same way.
		if needle != "" and not display.to_lower().begins_with(needle) and not id.to_lower().begins_with(needle):
			continue

		var marker := "* " if _installed.has(id) else "  "
		var label := "%s%s  (%s)" % [marker, display, version]
		var index := _list.add_item(label)
		_list.set_item_metadata(index, id)
		if id == keep:
			_list.select(index)
			kept = true

	# A filter that hides the current selection would leave the pane describing a tool the list no
	# longer shows. Falling back to the first row keeps the two in step, and means changing a
	# filter never needs a second click before anything is displayed.
	#
	# The second branch covers the case that made this look broken: the selection SURVIVES a filter
	# change, but the pane was overwritten by the empty-state message while the list happened to be
	# empty. The row is highlighted and the description says "No tool matches" - so the pane is
	# re-rendered whenever it is not showing the tool the list has selected.
	if _list.item_count > 0 and not kept:
		_list.select(0)
		_on_tool_selected(0)
	elif _list.item_count > 0 and kept and _shown_id != keep:
		for index in range(_list.item_count):
			if str(_list.get_item_metadata(index)) == keep:
				_list.select(index)
				_on_tool_selected(index)
				break

	# An empty list needs a reason. "Nothing happened" is indistinguishable from a defect, and
	# the causes here are different: nothing loaded, a filter that matches nothing, or no tool
	# for this engine.
	if _list.item_count == 0:
		if _tools.is_empty():
			_render_empty("No tools loaded. Check Settings, then press Refresh.")
		elif needle != "" or _filter != Filter.ALL:
			_render_empty("No tool matches the current filter.")
		else:
			_render_empty("No tool in this registry supports Godot yet.")


## Does this tool pass the filter chosen in the dropdown?
func _passes_filter(fields: PackedStringArray) -> bool:
	var id: String = fields[0] if fields.size() > 0 else ""
	match _filter:
		Filter.INSTALLED:
			return _installed.has(id)
		Filter.NOT_INSTALLED:
			return not _installed.has(id)
		Filter.THIS_ENGINE:
			return _supports_engine(fields)
		Filter.TAG, Filter.PROVIDES, Filter.INJECTS, Filter.DEPENDS_ON:
			# No value chosen yet: show everything, so choosing a mode never empties the list
			# before the user has said what to match.
			if _filter_value == "":
				return true
			for raw in _filter_source(fields).split(","):
				if raw.strip_edges() == _filter_value:
					return true
			return false
		_:
			return true


## The field a value-taking filter matches on.
##
## Depends-on is the reverse of the others: it answers "what would break if this went away", so
## the value is the id of a tool and the match is on what this one DECLARES it needs.
func _filter_source(fields: PackedStringArray) -> String:
	match _filter:
		Filter.TAG:
			return fields[7] if fields.size() > 7 else ""
		Filter.PROVIDES:
			return fields[4] if fields.size() > 4 else ""
		Filter.INJECTS:
			return fields[5] if fields.size() > 5 else ""
		Filter.DEPENDS_ON:
			var ids := PackedStringArray()
			for raw in (fields[8] if fields.size() > 8 else "").split(","):
				var entry := raw.strip_edges()
				if entry == "":
					continue
				ids.append(entry.split("@")[0])
			return ",".join(ids)
		_:
			return ""


func _filter_takes_value() -> bool:
	return (
		_filter == Filter.TAG
		or _filter == Filter.PROVIDES
		or _filter == Filter.INJECTS
		or _filter == Filter.DEPENDS_ON
	)


## Every value the current mode can match on, taken from the listing itself.
##
## Collected rather than hard-coded: a dropdown that offers a value nothing has would filter to an
## empty list and look like a defect. Depends-on offers the tool ids, because the question it asks
## is "which tools need THIS one".
func _filter_value_options() -> PackedStringArray:
	var values := {}
	for fields in _tools:
		# Only tools this engine can use: a value belonging to a tool that is never listed would
		# filter to an empty list and read as a broken control.
		if not _supports_engine(fields):
			continue
		if _filter == Filter.DEPENDS_ON:
			values[fields[0]] = true
			continue
		for raw in _filter_source(fields).split(","):
			var value := raw.strip_edges()
			if value != "":
				values[value] = true
	var options := PackedStringArray(values.keys())
	options.sort()
	return options


func _on_filter_chosen(index: int) -> void:
	_filter = index as Filter
	_filter_button.text = FILTER_LABELS[index]
	_filter_value = ""
	_refresh_filter_values()
	_rebuild_list()


## Rebuild the value dropdown for the current mode, or hide it when the mode takes no value.
func _refresh_filter_values() -> void:
	_filter_options = _filter_value_options() if _filter_takes_value() else PackedStringArray()
	if _filter_options.is_empty():
		_value_button.visible = false
		return

	if _filter_value == "" or not _filter_options.has(_filter_value):
		_filter_value = _first_useful_value()
	_value_button.text = _filter_value
	_value_button.visible = true

	var menu := _value_button.get_popup()
	menu.clear()
	for index in _filter_options.size():
		menu.add_item(_filter_options[index], index)


## The first value that actually leaves something in the list.
##
## The options are sorted, so the first alphabetically is often a value no tool in this registry
## has - picking "Tag is" then landed on an empty list and a message, which reads as the filter
## being broken rather than as that tag being unused. Depends-on is the worst case: most tools
## have no dependants at all.
func _first_useful_value() -> String:
	var saved := _filter_value
	for option in _filter_options:
		_filter_value = option
		for fields in _tools:
			if _supports_engine(fields) and _passes_filter(fields):
				_filter_value = saved
				return option
	_filter_value = saved
	return _filter_options[0]


func _on_filter_value_chosen(index: int) -> void:
	if index < 0 or index >= _filter_options.size():
		return
	_filter_value = _filter_options[index]
	_value_button.text = _filter_value
	_rebuild_list()


func _on_collapse_pressed() -> void:
	_list_collapsed = not _list_collapsed
	# Collapsing means the column gives its width back to the detail pane - otherwise folding it
	# would only hide the rows and leave the empty space behind, which is not what a collapse is
	# for. All that stays is the button that brings the list back, in the same corner.
	_list.visible = not _list_collapsed
	_filter_button.visible = not _list_collapsed
	_value_button.visible = (not _list_collapsed) and _filter_takes_value()

	# The width the user dragged to is remembered, not assumed: restoring the default width after
	# an expand threw away a deliberate resize, which made the collapse button feel like it reset
	# the window.
	if _list_collapsed:
		_list_width = _current_list_width()
		_set_list_width(COLLAPSED_RAIL_WIDTH)
	else:
		_set_list_width(_list_width)

	_collapse_button.text = "›" if _list_collapsed else "‹"
	_collapse_button.tooltip_text = "Show the tool list" if _list_collapsed else "Hide the tool list"


## How wide the list column currently is, dragged or not.
func _current_list_width() -> int:
	return maxi(COLLAPSED_RAIL_WIDTH, int(_split.size.x / 2) + _split.split_offset)


## Set the list column's width, by moving the splitter rather than only its minimum size.
##
## HSplitContainer keeps its own divider position, so shrinking the column's minimum width alone
## hides the rows and leaves the gap behind.
func _set_list_width(width: int) -> void:
	width = maxi(width, COLLAPSED_RAIL_WIDTH)
	_list_column.custom_minimum_size.x = COLLAPSED_RAIL_WIDTH if width <= COLLAPSED_RAIL_WIDTH else 120
	_split.split_offset = width - int(_split.size.x / 2)


func _on_tool_selected(index: int) -> void:
	var id := str(_list.get_item_metadata(index))
	if id == "":
		return
	if id != _selected_id:
		_selected_version = ""
	_selected_id = id
	_install_edit.text = str(_directories.get(id, ""))

	var arguments := _common_arguments()
	arguments.insert(0, "show")
	arguments.append(_reference())
	_call(arguments, _on_detail_ready)


func _on_list_gui_input(event: InputEvent) -> void:
	if not (event is InputEventMouseButton):
		return
	var mouse := event as InputEventMouseButton
	if not mouse.pressed or mouse.button_index != MOUSE_BUTTON_RIGHT:
		return

	var index := _list.get_item_at_position(mouse.position, true)
	if index < 0:
		return
	_list.select(index)
	_on_tool_selected(index)
	_show_version_menu(index)
	# Swallow the right-click so the list does not also act on it. `accept_event` belongs to
	# Control, and this class is a Window, so it is the list that marks the event handled.
	_list.accept_event()


# ---------------------------------------------------------------------------
# versions
# ---------------------------------------------------------------------------

func _show_version_menu(index: int) -> void:
	var id := str(_list.get_item_metadata(index))
	var published: Array = _versions.get(id, [])
	if published.is_empty():
		return

	var menu := PopupMenu.new()
	add_child(menu)
	var versions := PopupMenu.new()
	versions.name = "Versions"
	menu.add_child(versions)
	menu.add_submenu_item("Versions", "Versions")

	var installed: String = str(_installed_versions.get(id, ""))
	for position in range(published.size()):
		var entry: Dictionary = published[position]
		var version: String = entry["version"]
		var label := version
		if entry["latest"]:
			label += "  (latest)"
		# The installed release is marked at the START of its label, not with a trailing note:
		# scanning a list of versions for the one already in the project is the reason the menu
		# is opened, and a suffix at the end of a row is the last place the eye reaches.
		if version == installed:
			label = "[installed]  " + label
		versions.add_item(label, position)
		versions.set_item_checked(position, version == _chosen_version(id))

	versions.id_pressed.connect(func(position: int) -> void:
		_pin_version(id, str(published[position]["version"]))
		menu.queue_free()
	)
	menu.popup_hide.connect(func() -> void: menu.queue_free())

	# At the pointer, like any other context menu.
	menu.position = DisplayServer.mouse_get_position()
	menu.popup()


func _chosen_version(id: String) -> String:
	if id != _selected_id:
		return ""
	return _selected_version


func _pin_version(id: String, version: String) -> void:
	_selected_id = id
	_selected_version = version
	# Re-read the details: they are per release. Showing latest's metadata beside a plan for an
	# older release is worse than showing nothing.
	var arguments := _common_arguments()
	arguments.insert(0, "show")
	arguments.append(_reference())
	_call(arguments, _on_detail_ready)


# ---------------------------------------------------------------------------
# detail
# ---------------------------------------------------------------------------

func _on_detail_ready(records: Array) -> void:
	# A late answer for a tool the filter has since hidden must not repaint the pane. The list is
	# the truth about what can be picked, and painting a tool that is no longer in it is exactly
	# how the pane and the list ended up disagreeing.
	if _selected_id == "" or not _list_contains(_selected_id):
		return
	_detail = records
	_plan = []
	# _render_detail draws the Installs block too, from the target when there is no plan.
	_render_detail()
	_set_busy(false)


## Is this tool currently one of the rows in the list?
func _list_contains(id: String) -> bool:
	for index in range(_list.item_count):
		if str(_list.get_item_metadata(index)) == id:
			return true
	return false


func _render_empty(message: String) -> void:
	_shown_id = ""
	if _meta != null:
		_meta.clear()
		_meta.append_text(message)
	# No heading and no lines: this is the state before a tool is picked, and "Installs" over an
	# empty block reads as a tool that installs nothing.
	if _installs_header != null:
		_installs_header.visible = false
	if _plan_box != null:
		for child in _plan_box.get_children():
			_plan_box.remove_child(child)
			child.queue_free()


func _render_detail() -> void:
	_meta.clear()
	if _detail.is_empty():
		_render_empty("Select a tool to review it before installing.")
		return
	_shown_id = _selected_id

	var version := Backend.detail(_detail, "version")
	var display := Backend.detail(_detail, "displayName")
	var type := Backend.detail(_detail, "type")
	var released := Backend.detail(_detail, "releasedAt")
	var deprecated := Backend.detail(_detail, "deprecated") == "true"
	var yanked := Backend.detail(_detail, "yanked") == "true"

	var display_name := display if display != "" else _selected_id
	var facts := PackedStringArray()
	if version != "":
		facts.append(version)
	if type != "":
		facts.append(type)
	var author := Backend.detail(_detail, "author")
	if author != "":
		facts.append("by " + author)
	if released != "":
		facts.append("released " + released)
	if deprecated:
		facts.append("DEPRECATED")
	if yanked:
		facts.append("YANKED")

	# The header is three lines, each a different size: the name, the id it is installed under,
	# and the facts. The id is what a user needs when the display name and the package name
	# differ, and it is quieter than the name because it is read second.
	_meta.append_text("[font_size=20][b]%s[/b][/font_size]" % _escape(display_name))
	_meta.append_text("\n[font_size=14]%s[/font_size]" % _escape(_selected_id))
	if facts.size() > 0:
		_meta.append_text(
			"\n[font_size=14][i]%s[/i][/font_size]" % _escape("  •  ".join(facts))
		)

	_render_links()

	var description := Backend.detail(_detail, "description")
	if description != "":
		_meta.append_text("\n\n[b]Description[/b]")
		_meta.append_text("\n    " + _escape(description))

	_list_section("Engines", Backend.detail(_detail, "engines"))
	_list_section("Provides", Backend.detail(_detail, "provides"))
	_list_section("Injects", Backend.detail(_detail, "injects"))
	_list_section("Tags", Backend.detail(_detail, "tags"))
	_render_dependencies()

	# The default destination is a HINT inside the field, not a sentence above it: it describes
	# what an empty field will do, and the field is exactly where that question is asked.
	_install_edit.placeholder_text = _defaults_text()
	# The heading names which of the two answers is below, and the block decides both its text and
	# its lines so they cannot disagree.
	_fill_installs()

	var installed: String = str(_installed_versions.get(_selected_id, ""))
	var latest := _latest_of(_selected_id)
	if installed != "" and latest != "" and installed != latest:
		_status.text = "Installed %s, latest is %s. Right-click the tool to choose %s." % [
			installed, latest, latest
		]
	elif _plan.is_empty():
		_status.text = "Ready."


func _list_section(header: String, comma_separated: String) -> void:
	var values := PackedStringArray()
	for raw in comma_separated.split(","):
		var value := raw.strip_edges()
		if value != "":
			values.append(value)

	_meta.append_text("\n\n[b]%s[/b]" % _escape(header))
	if values.is_empty():
		_meta.append_text("\n    - (none)")
		return
	for value in values:
		# Four spaces of indent, like the Unity window: a section's items are its content, and
		# without the indent a header and an item read as two headers.
		_meta.append_text("\n    - " + _escape(value))


## What the tool declares it will install, when there is no plan to say it precisely.
##
## The plan is the authority once it exists; before that, the target's own declaration is the
## only answer available, and it is the one the user reads while deciding whether to plan at all.
func _render_targets() -> void:
	var mine: PackedStringArray = PackedStringArray()
	for fields in Backend.of(_detail, "TARGET"):
		if fields.size() > 0 and fields[0] == ENGINE:
			mine = fields

	if mine.is_empty():
		_plan_box.add_child(_plan_line("No Godot target is declared for this release."))
		return

	# TARGET: engine minEngineVersion otherRequirements type format artifactPath contentRoot
	#         targetPath editorOnly externalUrl externalRef
	var kind := mine[3] if mine.size() > 3 else "?"
	var format := mine[4] if mine.size() > 4 else ""
	_plan_box.add_child(_plan_line("%s%s  - needs engine %s" % [
		kind,
		("/" + format) if format != "" else "",
		mine[1] if mine.size() > 1 else "?",
	]))
	if mine.size() > 5 and mine[5] != "":
		_plan_box.add_child(_plan_line("artifact: " + mine[5]))
	if mine.size() > 6 and mine[6] != "":
		_plan_box.add_child(_plan_line("into:     " + mine[6]))
	if mine.size() > 7 and mine[7] != "":
		_plan_box.add_child(_plan_line("lands at: " + mine[7]))
	if mine.size() > 8 and mine[8] == "true":
		_plan_box.add_child(_plan_line("editor only: excluded from player builds"))


func _render_dependencies() -> void:
	var dependencies := Backend.of(_detail, "DEPENDENCY")
	if dependencies.is_empty():
		return

	_meta.append_text("\n\n[b]Dependencies[/b]")

	for fields in dependencies:
		if fields.size() < 3:
			continue
		var id := fields[0]
		var constraint := fields[1] if fields[1] != "" else "any version"
		var optional := fields[2] == "optional"
		# A dependency that is not in this registry cannot be opened; it is still named, because
		# "missing" is information the plan will report anyway.
		if _is_in_registry(id):
			_meta.append_text("\n    - [url=select:%s]%s[/url]  %s%s" % [
				_escape(id), _escape(id), _escape(constraint), " (optional)" if optional else "",
			])
		else:
			_meta.append_text("\n    - %s  %s%s  - not in this registry" % [
				_escape(id), _escape(constraint), " (optional)" if optional else "",
			])


## The outbound links, as links.
##
## They sit directly under the facts line, the way the Unity window's LinkButtons do: a link is
## part of the tool's identity, not a section of prose, and putting it above the description keeps
## it from being buried under a long one.
func _render_links() -> void:
	var links := [
		["Homepage", Backend.detail(_detail, "homepage")],
		["Documentation", Backend.detail(_detail, "documentation")],
		["Release notes", Backend.detail(_detail, "releaseNotes")],
	]
	var license_url := Backend.detail(_detail, "licenseUrl")
	if license_url != "":
		links.append(["License", license_url])

	var parts := PackedStringArray()
	for entry in links:
		if entry[1] == "":
			continue
		# Blue, bold and italic: a link has to look like one at a glance, and the rest of the
		# pane is neither coloured nor bold, so the difference is unambiguous. The hint is the URL
		# itself, so hovering says where the click goes before it is taken.
		parts.append(
			"[hint=%s][color=#4b9bff][b][i][url=%s]%s[/url][/i][/b][/color][/hint]"
			% [entry[1], entry[1], _escape(entry[0])]
		)
	if parts.is_empty():
		return
	_meta.append_text("\n" + "   •   ".join(parts))


## Text that is safe to put inside a BBCode label.
##
## A description containing a '[' would otherwise be read as a tag and silently disappear, and
## descriptions are arbitrary strings written by a payload author.
func _escape(text: String) -> String:
	return text.replace("[", "[lb]")


func _is_in_registry(id: String) -> bool:
	for fields in _tools:
		if fields.size() > 0 and fields[0] == id:
			return true
	return false


func _latest_of(id: String) -> String:
	for entry in _versions.get(id, []):
		if entry["latest"]:
			return entry["version"]
	return ""


func _on_meta_clicked(meta: Variant) -> void:
	var target := str(meta)
	if target.begins_with("select:"):
		var id := target.substr("select:".length())
		for index in range(_list.item_count):
			if str(_list.get_item_metadata(index)) == id:
				_list.select(index)
				_on_tool_selected(index)
				return
		return
	OS.shell_open(target)


# ---------------------------------------------------------------------------
# destination
# ---------------------------------------------------------------------------

func _defaults_text() -> String:
	var root := ""
	for fields in Backend.of(_detail, "TARGET"):
		if fields.size() > 6 and fields[0] == ENGINE:
			root = fields[6]
	if root == "":
		return "Empty installs where the manifest declares; the plan names the exact paths."
	return "Empty installs under %s, as the manifest declares." % root


func _on_destination_typed(text: String) -> void:
	if _selected_id == "":
		return
	var trimmed := text.strip_edges()
	if trimmed == "":
		_directories.erase(_selected_id)
	else:
		_directories[_selected_id] = trimmed
	# A plan describes one destination; keeping it beside a new one is a disagreement.
	_plan = []
	_render_detail()


func _on_default_pressed() -> void:
	_install_edit.text = ""
	_on_destination_typed("")


func _on_browse_pressed() -> void:
	var dialog := FileDialog.new()
	dialog.file_mode = FileDialog.FILE_MODE_OPEN_DIR
	dialog.access = FileDialog.ACCESS_FILESYSTEM
	dialog.current_dir = _project_root
	dialog.title = "Install into (a folder inside this project)"

	dialog.dir_selected.connect(func(directory: String) -> void:
		# Typed as Variant: "not in this project" is null, which a String cannot express.
		var relative: Variant = _project_relative(directory)
		if relative == null:
			_status.text = "That folder is outside this project. The destination is project-relative."
			return
		var chosen := str(relative)
		_install_edit.text = chosen
		_on_destination_typed(chosen)
		if chosen == "":
			_status.text = "Installing where the manifest declares."
		elif not chosen.begins_with("addons/") and chosen != "addons":
			_status.text = "Note: Godot only loads addons under res://addons."
		else:
			_status.text = "Install directory set to " + chosen + "."
	)
	dialog.canceled.connect(func() -> void: dialog.queue_free())
	dialog.confirmed.connect(func() -> void: dialog.queue_free())
	add_child(dialog)
	dialog.popup_centered_ratio(0.5)


## Absolute folder -> project-relative, or null when it is outside the project.
##
## The separator in the prefix test is what keeps a sibling project whose name merely STARTS
## with this one's from being accepted as inside it.
func _project_relative(directory: String) -> Variant:
	var root := _project_root.replace("\\", "/").trim_suffix("/")
	var folder := directory.replace("\\", "/").trim_suffix("/")
	if root == "" or folder == "":
		return null
	if folder.to_lower() == root.to_lower():
		return ""
	if not folder.to_lower().begins_with(root.to_lower() + "/"):
		return null
	return folder.substr(root.length() + 1)


func _into_arguments() -> PackedStringArray:
	var directory := ""
	if _selected_id != "":
		directory = str(_directories.get(_selected_id, ""))
	if directory == "":
		return PackedStringArray()
	return PackedStringArray(["--into", directory])


# ---------------------------------------------------------------------------
# actions
# ---------------------------------------------------------------------------

func _on_verify_pressed() -> void:
	if _selected_id == "":
		return
	var arguments := _common_arguments()
	arguments.insert(0, "plan")
	arguments.append(_reference())
	arguments.append_array(_into_arguments())
	_call(arguments, _on_plan_ready)


func _on_plan_ready(records: Array) -> void:
	_plan = records
	_render_detail()

	if Backend.problems(records).size() > 0:
		_status.text = "Plan rejected. See the plan block."
		return

	var ok := Backend.result(records, "ok") == "true"
	_status.text = (
		"Verified: every artifact matches its declared size and sha256. Nothing has been written yet."
		if ok
		else "The plan was NOT verified. Do not install until this is understood."
	)


## Fill the block under the Installs / Plan heading.
##
## The heading itself is written by the rich text above, so the two always agree, and this only
## decides which answer goes underneath: the verified plan when there is one, the declaration from
## the manifest otherwise.
func _fill_installs() -> void:
	# Removed now rather than queued: a queue_free'd node is still drawn for the rest of the
	# frame, which would show the previous plan's lines under the new one.
	for child in _plan_box.get_children():
		_plan_box.remove_child(child)
		child.queue_free()

	# The heading names what is actually below it: after verifying, the block IS the plan, and a
	# heading that still said "Installs" left the user looking for the plan they had just made.
	_installs_header.text = "[b]Installs[/b]" if _plan.is_empty() else "[b]Plan[/b]"
	_installs_header.visible = true

	# No plan yet, so the block answers the same question from the declaration instead. The two
	# are mutually exclusive on purpose: a plan and a target both say what will land where, and
	# showing both invites the reading that they might disagree.
	if _plan.is_empty():
		_render_targets()
		_update_buttons()
		return

	var problems := Backend.problems(_plan)
	if problems.size() > 0:
		var failure := Label.new()
		failure.text = "\n".join(problems)
		_plan_box.add_child(failure)
		return

	for fields in Backend.of(_plan, "PLANTOOL"):
		if fields.size() < 6:
			continue
		var skipped := fields[10] if fields.size() > 10 else ""
		if skipped != "":
			_plan_box.add_child(_plan_line("%s/%s: %s" % [fields[0], fields[2], skipped]))
			continue
		var artifact := fields[3]
		if fields.size() > 4 and fields[4] != "":
			artifact += "/" + fields[4]
		var because := fields[9] if fields.size() > 9 and fields[9] != "" else "user"
		_plan_box.add_child(_plan_line("%s %s [%s] %s - %s bytes - needed by %s" % [
			fields[0], fields[1], fields[2], artifact, fields[5], because
		]))

	for fields in Backend.of(_plan, "PLANFILE"):
		if fields.size() >= 2:
			_plan_box.add_child(_plan_line("    %s -> %s" % [fields[0], fields[1]]))

	_update_buttons()


func _plan_line(text: String) -> Label:
	var label := Label.new()
	label.text = text
	label.autowrap_mode = TextServer.AUTOWRAP_OFF
	# One size down from the body: a plan is a list of paths, and the paths are long - the smaller
	# size buys horizontal room as well as vertical.
	label.add_theme_font_size_override("font_size", 14)
	return label


func _on_install_pressed() -> void:
	if _selected_id == "" or _plan.is_empty():
		return

	var target := _selected_id
	if _selected_version != "":
		target += " " + _selected_version

	var directory := str(_directories.get(_selected_id, ""))
	var question := "Install %s?\n\nThe plan above was verified. Files will be written%s and a receipt recorded so this can be uninstalled cleanly." % [
		target, (" into " + directory) if directory != "" else ""
	]

	var dialog := ConfirmationDialog.new()
	dialog.dialog_text = question
	dialog.title = "Install " + target
	dialog.ok_button_text = "Install"
	dialog.confirmed.connect(func() -> void:
		dialog.queue_free()
		_install_now()
	)
	dialog.canceled.connect(func() -> void: dialog.queue_free())
	add_child(dialog)
	dialog.popup_centered()


func _install_now() -> void:
	var arguments := _common_arguments()
	arguments.insert(0, "install")
	arguments.append(_reference())
	arguments.append_array(_into_arguments())
	_call(arguments, _on_install_ready)


func _on_install_ready(records: Array) -> void:
	var installed := Backend.result(records, "installed")
	_plan = []
	_render_detail()
	_status.text = "Installed %s tool(s)." % (installed if installed != "" else "?")
	_refresh_installed()


func _on_uninstall_pressed() -> void:
	if _selected_id == "":
		return

	var dialog := ConfirmationDialog.new()
	dialog.dialog_text = "Remove the files recorded for %s in this project?" % _selected_id
	dialog.title = "Uninstall " + _selected_id
	dialog.ok_button_text = "Uninstall"
	dialog.confirmed.connect(func() -> void:
		dialog.queue_free()
		_uninstall_now()
	)
	dialog.canceled.connect(func() -> void: dialog.queue_free())
	add_child(dialog)
	dialog.popup_centered()


func _uninstall_now() -> void:
	var arguments := _common_arguments()
	arguments.insert(0, "uninstall")
	arguments.append(_selected_id)
	_call(arguments, _on_uninstall_ready)


func _on_uninstall_ready(records: Array) -> void:
	var removed := Backend.result(records, "removed")
	var moved := ""
	for fields in Backend.of(records, "MOVEDROOT"):
		if fields.size() > 1 and fields[1] != "":
			moved = fields[1]

	_detail = []
	_plan = []
	# Re-rendered BEFORE the message is set: the render resets the status line to "Ready.", and
	# setting it first meant every uninstall finished with a status that said nothing happened.
	_render_detail()

	if moved != "":
		_status.text = "Receipt cleared, but %s is no longer there - it was moved or deleted outside this window." % moved
	else:
		_status.text = "Removed %s file(s)." % (removed if removed != "" else "?")
	_refresh_installed()


func _refresh_installed() -> void:
	var arguments := _common_arguments()
	arguments.insert(0, "status")
	_call(arguments, _on_status_ready)


func _on_status_ready(records: Array) -> void:
	_installed = {}
	_installed_versions = {}
	for fields in Backend.of(records, "RECEIPT"):
		if fields.size() == 0:
			continue
		_installed[fields[0]] = true
		if fields.size() > 1:
			_installed_versions[fields[0]] = fields[1]

	_rebuild_list()
	_update_buttons()


func _set_busy(busy: bool) -> void:
	if _verify_button == null:
		return
	_verify_button.disabled = busy
	_install_button.disabled = busy or _plan.is_empty()
	_uninstall_button.disabled = busy or not _installed.has(_selected_id)


func _update_buttons() -> void:
	_set_busy(_backend != null and _backend.is_busy())
