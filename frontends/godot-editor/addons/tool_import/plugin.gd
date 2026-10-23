@tool
extends EditorPlugin

## Registers the Tool Import dock.
##
## The dock is built in code rather than from a .tscn: it has no fixed layout to design,
## and a scene file would make the pane's structure something to open in the editor to read.

const DockScript := preload("tool_import_dock.gd")

var _dock: Control = null


func _enter_tree() -> void:
	_dock = DockScript.new()
	_dock.name = "Tool Import"
	add_control_to_dock(DOCK_SLOT_RIGHT_UL, _dock)


func _exit_tree() -> void:
	if is_instance_valid(_dock):
		remove_control_from_docks(_dock)
		_dock.queue_free()
	_dock = null
