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

const ENGINE := "godot"

## The size the window opens at. Wide enough for the list plus a full detail pane, and short
## enough to fit a 1080p screen with room left for the editor.
const WINDOW_SIZE := Vector2i(1000, 660)

## How tall the plan block may get before it scrolls itself. See _size_plan_block.
const PLAN_MAX_HEIGHT := 220.0

var _backend: Backend = null
var _project_root := ""
var _settings_window: Window = null

var _registry_label: Label
var _search_edit: LineEdit
var _list: ItemList
var _meta: RichTextLabel
var _install_edit: LineEdit
var _defaults_label: Label
var _status: Label
var _plan_box: VBoxContainer
var _plan_scroll: ScrollContainer
var _verify_button: Button
var _install_button: Button
var _uninstall_button: Button

var _tools: Array[PackedStringArray] = []
var _versions := {}
var _installed := {}
var _installed_versions := {}
var _directories := {}

var _selected_id := ""
var _selected_version := ""
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
	toolbar.add_child(refresh_button)

	var settings_button := Button.new()
	settings_button.text = "Settings"
	settings_button.pressed.connect(_on_settings_pressed)
	toolbar.add_child(settings_button)

	toolbar.add_child(VSeparator.new())

	_search_edit = LineEdit.new()
	_search_edit.placeholder_text = "filter by name"
	_search_edit.custom_minimum_size = Vector2(200, 0)
	_search_edit.text_changed.connect(func(_text: String) -> void: _rebuild_list())
	toolbar.add_child(_search_edit)

	var split := HSplitContainer.new()
	split.size_flags_vertical = Control.SIZE_EXPAND_FILL
	# Into `root`, not into the window: everything else is built under root, and a sibling of it
	# is laid out at the origin with no size of its own - which is how the window ended up showing
	# the toolbar and the status line with an empty body between them.
	root.add_child(split)

	_list = ItemList.new()
	_list.custom_minimum_size = Vector2(200, 0)
	_list.item_selected.connect(_on_tool_selected)
	_list.gui_input.connect(_on_list_gui_input)
	split.add_child(_list)

	var detail_scroll := ScrollContainer.new()
	detail_scroll.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	split.add_child(detail_scroll)

	var details := VBoxContainer.new()
	details.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	detail_scroll.add_child(details)

	_meta = RichTextLabel.new()
	_meta.bbcode_enabled = false
	_meta.fit_content = true
	_meta.scroll_active = false
	_meta.selection_enabled = true
	_meta.meta_clicked.connect(_on_meta_clicked)
	details.add_child(_meta)

	_defaults_label = Label.new()
	_defaults_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	details.add_child(_defaults_label)

	var destination_header := Label.new()
	destination_header.text = "Install Into"
	destination_header.tooltip_text = (
		"Project-relative, for example addons/vendor. Absolute paths and '..' are refused.\n\n"
		+ "This REPLACES the folder the tool installs into - the files inside it keep their "
		+ "layout. Empty installs where the manifest declares; the exact paths are in the plan."
	)
	details.add_child(destination_header)

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
	destination_row.add_child(_install_edit)
	destination_row.add_child(browse_button)
	destination_row.add_child(default_button)
	details.add_child(destination_row)

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
	actions.add_child(_verify_button)
	actions.add_child(_install_button)
	actions.add_child(_uninstall_button)
	details.add_child(actions)

	var plan_header := Label.new()
	plan_header.text = "Plan"
	details.add_child(plan_header)

	# Both scrollbars are "when needed": a short plan shows no bars, a long path scrolls
	# sideways, and past PLAN_MAX_HEIGHT the block scrolls itself.
	_plan_scroll = ScrollContainer.new()
	_plan_scroll.vertical_scroll_mode = ScrollContainer.SCROLL_MODE_AUTO
	_plan_scroll.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	details.add_child(_plan_scroll)

	_plan_box = VBoxContainer.new()
	_plan_box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_plan_scroll.add_child(_plan_box)

	_status = Label.new()
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	root.add_child(_status)

	_set_busy(true)
	_render_empty("Press Refresh to list the registry.")
	# Godot 4.4+ translates a Control's text through the editor's own catalogue, which turned
	# "Node" into 节点 and "Install" into 安装 while "Registry" stayed English - a half-translated
	# pane reads as a broken one. Older 4.x does not translate these strings at all, so the guard
	# is a no-op there rather than a broken property name.
	_disable_auto_translation(self)


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
		return

	if noise.size() > 0:
		_status.text = "\n".join(noise)

	if handler.is_valid():
		handler.call(records)


var _pending := Callable()


## Send one command and name the handler that reads its answer.
##
## One call at a time, and a call made while busy is REFUSED rather than queued: the pane shows
## one answer, and a queued request that runs later would paint a stale release over the one the
## user is looking at. Refusing keeps the state obvious - the status line says so.
func _call(arguments: PackedStringArray, handler: Callable) -> void:
	if _backend.is_busy():
		_status.text = "Still working; try again when the current call finishes."
		return
	_pending = handler
	if not _run(arguments):
		_pending = Callable()


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

	_list.clear()
	for fields in _tools:
		if not _supports_engine(fields):
			continue
		var id: String = fields[0]
		var display: String = fields[6] if fields.size() > 6 else id
		var version: String = fields[1] if fields.size() > 1 else ""
		var marker := "* " if _installed.has(id) else "  "
		var label := "%s%s  (%s)" % [marker, display, version]
		if needle != "" and not label.to_lower().contains(needle) and not id.to_lower().contains(needle):
			continue

		var index := _list.add_item(label)
		_list.set_item_metadata(index, id)
		if id == keep:
			_list.select(index)

	# Nothing selected yet: open the first tool, the way the list itself would.
	if _selected_id == "" and _list.item_count > 0:
		_list.select(0)
		_on_tool_selected(0)

	# An empty list needs a reason. "Nothing happened" is indistinguishable from a defect, and
	# the two causes here are completely different: no paths yet, or no tool for this engine.
	if _list.item_count == 0:
		if _tools.is_empty():
			_render_empty("No tools loaded. Set the paths above, then press Refresh.")
		else:
			_render_empty("No tool in this registry supports Godot yet.")


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
		if version == installed:
			label += "  - installed"
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
	_detail = records
	_plan = []
	_render_detail()
	_render_plan()
	_set_busy(false)


func _render_empty(message: String) -> void:
	if _meta != null:
		_meta.clear()
		_meta.add_text(message)


func _render_detail() -> void:
	_meta.clear()
	if _detail.is_empty():
		_render_empty("Select a tool to review it before installing.")
		return

	var version := Backend.detail(_detail, "version")
	var display := Backend.detail(_detail, "displayName")
	var type := Backend.detail(_detail, "type")
	var released := Backend.detail(_detail, "releasedAt")
	var deprecated := Backend.detail(_detail, "deprecated") == "true"
	var yanked := Backend.detail(_detail, "yanked") == "true"

	_meta.push_font_size(16)
	_meta.add_text(display if display != "" else _selected_id)
	_meta.pop()

	var facts := PackedStringArray()
	if version != "":
		facts.append(version)
	if type != "":
		facts.append(type)
	if released != "":
		facts.append("released " + released)
	if deprecated:
		facts.append("DEPRECATED")
	if yanked:
		facts.append("YANKED")
	if facts.size() > 0:
		_meta.add_text("\n" + " - ".join(facts))

	var description := Backend.detail(_detail, "description")
	if description != "":
		_meta.add_text("\n\n" + description)

	_list_section("Engines", Backend.detail(_detail, "engines"))
	_list_section("Provides", Backend.detail(_detail, "provides"))
	_list_section("Injects", Backend.detail(_detail, "injects"))
	_list_section("Tags", Backend.detail(_detail, "tags"))

	_render_targets()
	_render_dependencies()
	_render_links()

	_defaults_label.text = _defaults_text()

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

	_meta.add_text("\n\n")
	_meta.push_bold()
	_meta.add_text(header)
	_meta.pop()
	if values.is_empty():
		_meta.add_text("\n- (none)")
		return
	for value in values:
		_meta.add_text("\n- " + value)


func _render_targets() -> void:
	var mine: PackedStringArray = PackedStringArray()
	for fields in Backend.of(_detail, "TARGET"):
		if fields.size() > 0 and fields[0] == ENGINE:
			mine = fields

	if mine.is_empty():
		return

	# TARGET: engine minEngineVersion otherRequirements type format artifactPath contentRoot
	#         targetPath editorOnly externalUrl externalRef
	_meta.add_text("\n\n")
	_meta.push_bold()
	_meta.add_text("Target (%s)" % ENGINE)
	_meta.pop()

	var kind := mine[3] if mine.size() > 3 else "?"
	var format := mine[4] if mine.size() > 4 else ""
	_meta.add_text("\n%s%s  (needs engine %s)" % [
		kind,
		("/" + format) if format != "" else "",
		mine[1] if mine.size() > 1 else "?",
	])
	if mine.size() > 5 and mine[5] != "":
		_meta.add_text("\nartifact: " + mine[5])
	if mine.size() > 6 and mine[6] != "":
		_meta.add_text("\nroot: " + mine[6])
	if mine.size() > 7 and mine[7] != "":
		_meta.add_text("\nfile: " + mine[7])
	if mine.size() > 8 and mine[8] == "true":
		_meta.add_text("\n(editor only)")


func _render_dependencies() -> void:
	var dependencies := Backend.of(_detail, "DEPENDENCY")
	if dependencies.is_empty():
		return

	_meta.add_text("\n\n")
	_meta.push_bold()
	_meta.add_text("Dependencies")
	_meta.pop()

	for fields in dependencies:
		if fields.size() < 3:
			continue
		var id := fields[0]
		var constraint := fields[1] if fields[1] != "" else "any version"
		var optional := fields[2] == "optional"
		# A dependency that is not in this registry cannot be opened; it is still named, because
		# "missing" is information the plan will report anyway.
		if _is_in_registry(id):
			_meta.add_text("\n- ")
			_meta.push_meta("select:" + id)
			_meta.add_text(id)
			_meta.pop()
			_meta.add_text("  " + constraint + (" (optional)" if optional else ""))
		else:
			_meta.add_text("\n- %s  %s%s  - not in this registry" % [
				id, constraint, " (optional)" if optional else ""
			])


func _render_links() -> void:
	var links := [
		["Homepage", Backend.detail(_detail, "homepage")],
		["Documentation", Backend.detail(_detail, "documentation")],
		["Release notes", Backend.detail(_detail, "releaseNotes")],
	]

	var any := false
	for entry in links:
		if entry[1] != "":
			any = true
	if not any:
		return

	_meta.add_text("\n\n")
	_meta.push_bold()
	_meta.add_text("Links")
	_meta.pop()
	for entry in links:
		if entry[1] == "":
			continue
		_meta.add_text("\n- ")
		_meta.push_meta(entry[1])
		_meta.add_text(entry[0])
		_meta.pop()
		_meta.add_text("  " + entry[1])


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
	_render_plan()


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
	_render_plan()

	if Backend.problems(records).size() > 0:
		_status.text = "Plan rejected. See the plan block."
		return

	var ok := Backend.result(records, "ok") == "true"
	_status.text = (
		"Verified: every artifact matches its declared size and sha256. Nothing has been written yet."
		if ok
		else "The plan was NOT verified. Do not install until this is understood."
	)


func _render_plan() -> void:
	# Removed now rather than queued: a queue_free'd node is still drawn for the rest of the
	# frame, which would show the previous plan's lines under the new one.
	for child in _plan_box.get_children():
		_plan_box.remove_child(child)
		child.queue_free()

	if _plan.is_empty():
		_size_plan_block()
		_update_buttons()
		return

	var problems := Backend.problems(_plan)
	if problems.size() > 0:
		var failure := Label.new()
		failure.text = "\n".join(problems)
		_plan_box.add_child(failure)
		_size_plan_block()
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

	_size_plan_block()
	_update_buttons()


## Give the plan block a height that matches its content, up to a cap.
##
## WHY NOT LET IT GROW FREELY
## --------------------------
## A plan is a log: a tool with forty files would push the difference between "verified" and
## "not verified" off the bottom of the window, which is the one line the user has to read
## before pressing Install. Below the cap the block is as tall as its lines and the window's own
## scrollbar takes over; above it, the block scrolls itself. Horizontal scrolling is separate and
## stays on, because a planned path is longer than the window.
func _size_plan_block() -> void:
	var lines := _plan_box.get_child_count()
	var line_height := _plan_box.get_theme_default_font_size() + 6
	var wanted := float(lines) * float(line_height) + 8.0
	_plan_scroll.custom_minimum_size.y = minf(wanted, PLAN_MAX_HEIGHT)


func _plan_line(text: String) -> Label:
	var label := Label.new()
	label.text = text
	label.autowrap_mode = TextServer.AUTOWRAP_OFF
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
	_status.text = "Installed %s tool(s)." % (installed if installed != "" else "?")
	_plan = []
	_render_plan()
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

	if moved != "":
		_status.text = "Receipt cleared, but %s is no longer there - it was moved or deleted outside this window." % moved
	else:
		_status.text = "Removed %s file(s)." % (removed if removed != "" else "?")

	_detail = []
	_plan = []
	_render_plan()
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
