@tool
extends RefCounted

## Where the registry, the CLI and Node are found.
##
## THE ORDER IS UNITY'S ORDER, ON PURPOSE
## --------------------------------------
## A user who moves between the two editors should not have to learn a second set of rules, and
## the documentation describes one behaviour rather than two. So, exactly as in the Unity front
## end:
##
##   registry:  the settings window, then UTOOL_REGISTRY, then a sibling ToolRegistry checkout,
##              then the published URL
##   CLI:       the settings window, then UTOOL_CLI, then a sibling ToolImport checkout
##   node:      the settings window, then UTOOL_NODE, then whatever "node" resolves to on PATH
##
## The settings window comes FIRST because it is the one value a user sets deliberately; letting
## an inherited environment variable silently win would make their explicit choice look broken.

const SETTING_REGISTRY := "tool_import/registry_path"
const SETTING_CLI := "tool_import/cli_path"
const SETTING_NODE := "tool_import/node_path"

const REGISTRY_VARIABLE := "UTOOL_REGISTRY"
const CLI_VARIABLE := "UTOOL_CLI"
const NODE_VARIABLE := "UTOOL_NODE"

## Mirrors DEFAULT_REMOTE_REGISTRY in the Unity front end and the backend CLI.
const DEFAULT_REMOTE_REGISTRY := "https://raw.githubusercontent.com/JokeVallen/ToolRegistry/main"

## Directory names a registry checkout may have. Mirrors the Unity front end and the CLI: a
## renamed checkout keeps resolving, because renaming a directory must not break projects.
const REGISTRY_DIRECTORY_NAMES := ["ToolRegistry", "DevCatToolRegistry"]

const WALK_UP_DEPTH := 6


## The project root, without a trailing separator.
static func project_root() -> String:
	return ProjectSettings.globalize_path("res://").trim_suffix("/").replace("\\", "/")


static func setting(key: String, fallback: String) -> String:
	var settings: EditorSettings = EditorInterface.get_editor_settings()
	if not settings.has_setting(key):
		return fallback
	var value: Variant = settings.get_setting(key)
	return fallback if value == null else str(value)


static func save_setting(key: String, value: String) -> void:
	EditorInterface.get_editor_settings().set_setting(key, value)


static func clear_setting(key: String) -> void:
	var settings: EditorSettings = EditorInterface.get_editor_settings()
	if settings.has_setting(key):
		settings.set_setting(key, "")


## The settings-window value, when it is a path that exists.
static func from_settings(key: String, is_directory: bool) -> String:
	var configured := setting(key, "")
	if configured == "":
		return ""
	if is_directory:
		return configured if DirAccess.dir_exists_absolute(configured) else ""
	return configured if FileAccess.file_exists(configured) else ""


static func from_environment(variable: String) -> String:
	var value := OS.get_environment(variable).strip_edges()
	return value


## Absolute path to apps/cli/bin/utool.js, or "" when no answer exists.
static func resolve_cli() -> String:
	var configured := from_settings(SETTING_CLI, false)
	if configured != "":
		return configured

	var from_env := from_environment(CLI_VARIABLE)
	if from_env != "" and FileAccess.file_exists(from_env):
		return from_env

	# A sibling checkout, which is how this is used during development. config_version=5
	# projects sit beside the registry in the same workspace, so one walk finds both.
	return walk_for_file("ToolImport/apps/cli/bin/utool.js")


## The registry location: a directory, or the published URL as a last resort.
static func resolve_registry() -> String:
	var configured := from_settings(SETTING_REGISTRY, true)
	if configured != "":
		return configured

	var from_env := from_environment(REGISTRY_VARIABLE)
	if from_env != "":
		return from_env

	# Current name first, then the former one: a checkout that has not been renamed keeps
	# resolving.
	for name in REGISTRY_DIRECTORY_NAMES:
		var candidate := walk_for_directory(name + "/payloads")
		if candidate != "":
			return candidate.get_base_dir()
	return DEFAULT_REMOTE_REGISTRY


static func resolve_node() -> String:
	var configured := from_settings(SETTING_NODE, false)
	if configured != "":
		return configured

	var from_env := from_environment(NODE_VARIABLE)
	if from_env != "" and FileAccess.file_exists(from_env):
		return from_env

	# "node" relies on PATH; that is the common case and Godot inherits the environment.
	return "node"


## A leaf name for the toolbar, with the full value available as its tooltip.
static func leaf_name(locator: String) -> String:
	if locator.begins_with("http://") or locator.begins_with("https://"):
		return locator.get_file() if locator.get_file() != "" else locator
	return locator.trim_suffix("/").get_file()


static func walk_for_file(relative: String) -> String:
	var directory := project_root()
	for _depth in range(WALK_UP_DEPTH):
		if directory == "":
			break
		var candidate := directory.path_join(relative)
		if FileAccess.file_exists(candidate):
			return candidate
		directory = directory.get_base_dir()
	return ""


static func walk_for_directory(relative: String) -> String:
	var directory := project_root()
	for _depth in range(WALK_UP_DEPTH):
		if directory == "":
			break
		var candidate := directory.path_join(relative)
		if DirAccess.dir_exists_absolute(candidate):
			return candidate
		directory = directory.get_base_dir()
	return ""
