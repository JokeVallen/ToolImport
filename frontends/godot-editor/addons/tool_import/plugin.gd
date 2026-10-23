@tool
extends EditorPlugin

## Registers the Tool Import window under Project > Tools.
##
## WHY A MENU ITEM AND A FLOATING WINDOW
## -------------------------------------
## The Unity front end is reached from a menu and opens a window; this one does the same, through
## the one menu a Godot plugin can add to. Installing a tool is a task with an end, not a panel to
## keep open beside the editor, so the window is not a dock.
##
## The window is built in code rather than from a .tscn: its layout is a handful of rows, and a
## scene file would make the structure something to open in the editor to read.

const WindowScript := preload("tool_import_window.gd")

const MENU_LABEL := "Tool Import"

var _window: Window = null


func _enter_tree() -> void:
	add_tool_menu_item(MENU_LABEL, _open)


func _exit_tree() -> void:
	remove_tool_menu_item(MENU_LABEL)
	if is_instance_valid(_window):
		_window.queue_free()
	_window = null


func _open() -> void:
	if _window == null or not is_instance_valid(_window):
		_window = WindowScript.new()
		# Parented to the editor's base control so the window belongs to the editor rather than
		# being a second OS window that can end up behind it.
		EditorInterface.get_base_control().add_child(_window)
		_window.close_requested.connect(_on_window_closed)
	_window.open()


## Closing hides the window instead of destroying it: it holds the listing, the selected tool and
## the plan, and reopening should not make the user repeat any of it.
func _on_window_closed() -> void:
	if is_instance_valid(_window):
		_window.hide()
