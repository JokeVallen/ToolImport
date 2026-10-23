@tool
extends RefCounted

## Runs the `utool` backend and parses its `--records` stream.
##
## WHY A SUBPROCESS AND A THREAD
## -----------------------------
## The backend is the Node CLI, not a Godot library: every rule about versions, artifacts and
## receipts lives there, and the editor must not grow a second copy of them. `OS.execute` blocks
## the caller, so it runs on a thread; the editor stays responsive while the CLI verifies an
## artifact.
##
## The records contract is one record per line, TAB separated, the type in field 0, with TAB, CR,
## LF and backslash escaped inside values. Parsing is a split and an unescape - the same reason
## the Unity front end uses this mode instead of JSON.
##
## The contract is versioned in a leading META record. A reader that keys on the types it knows
## is unaffected by an added type, so no version check is enforced here; an unknown line is
## collected as "noise" so a backend that fails before printing records still says something.

signal finished(result: Dictionary)

## Every record type the backend emits. Kept for validation only.
const RECORD_TYPES := [
	"META", "TOOL", "TARGET", "DETAIL", "DEPENDENCY", "WILLINSTALL", "VERSIONS", "PROVIDER",
	"PROBLEM", "PLANTOOL", "PLANFILE", "PLAN", "INSTALLED", "INSTALLEDFILE", "SKIPPED",
	"RESULT", "RECEIPT", "WARNING", "ERROR", "REMOVED", "REMOVEDDIR", "RECEIPTREMOVED",
	"REMOVE", "KEEP", "ALREADYGONE", "MODIFIED", "MOVEDROOT",
]

var _thread: Thread = null


## Run one command. Returns false when a command is already in flight.
##
## One at a time on purpose: the pane can only show one answer, and running two would let the
## older one arrive last and paint over the newer (the defect the Unity front end had).
func run(node_path: String, cli_path: String, arguments: PackedStringArray) -> bool:
	if _thread != null:
		return false

	var cli_arguments := PackedStringArray([cli_path])
	cli_arguments.append_array(arguments)

	_thread = Thread.new()
	var started := _thread.start(_execute.bind(node_path, cli_arguments))
	if started != OK:
		_thread = null
		return false
	return true


func is_busy() -> bool:
	return _thread != null


func _execute(node_path: String, cli_arguments: PackedStringArray) -> void:
	var output: Array = []
	var code := OS.execute(node_path, cli_arguments, output, true)
	# Deferred because a signal emitted from a thread is not safe to deliver there.
	call_deferred("_deliver", code, output)


func _deliver(code: int, output: Array) -> void:
	if _thread != null:
		_thread.wait_to_finish()
		_thread = null

	var parsed := parse(output)
	parsed["exitCode"] = code
	finished.emit(parsed)


static func parse(lines: Array) -> Dictionary:
	var records: Array = []
	var noise: PackedStringArray = PackedStringArray()

	for raw in lines:
		# Split INSIDE each element as well. `OS.execute` hands back one element per line on
		# some platforms and the entire stream as a single element on others - on Windows it
		# was the latter, which turned a whole `list --records` run into one "record" with 91
		# fields. Splitting here rather than trusting the chunking is what makes both shapes
		# parse the same, and it costs nothing when the chunks are already single lines.
		for piece in str(raw).split("\n"):
			var line := piece
			while line.ends_with("\r"):
				line = line.substr(0, line.length() - 1)
			if line.strip_edges().is_empty():
				continue

			var parts := line.split("\t", true)
			if parts.is_empty() or not RECORD_TYPES.has(parts[0]):
				noise.append(line)
				continue

			var fields := PackedStringArray()
			for index in range(1, parts.size()):
				fields.append(unescape(parts[index]))
			records.append({"type": parts[0], "fields": fields})

	return {"records": records, "noise": noise}


## Undo the backend's escaping: `\\`, `\t`, `\r`, `\n`.
static func unescape(value: String) -> String:
	if value.find("\\") == -1:
		return value

	var out := ""
	var index := 0
	while index < value.length():
		var character := value[index]
		if character == "\\" and index + 1 < value.length():
			var escaped := value[index + 1]
			match escaped:
				"t": out += "\t"
				"n": out += "\n"
				"r": out += "\r"
				"\\": out += "\\"
				_: out += "\\" + escaped
			index += 2
		else:
			out += character
			index += 1
	return out


## Every record of one type, each as its field list.
##
## The return is a TYPED array on purpose. Without it the caller gets a Variant per element, so
## `var id := fields[0]` has nothing to infer from and refuses to compile - which is what the
## first draft of the dock did, on every loop.
static func of(records: Array, type: String) -> Array[PackedStringArray]:
	var found: Array[PackedStringArray] = []
	for record in records:
		if record["type"] == type:
			var fields: PackedStringArray = record["fields"]
			found.append(fields)
	return found


## Value of a `DETAIL <key> <value>` record, or an empty string.
static func detail(records: Array, key: String) -> String:
	for record in records:
		if record["type"] != "DETAIL":
			continue
		var fields: PackedStringArray = record["fields"]
		if fields.size() >= 2 and fields[0] == key:
			return fields[1]
	return ""


## Value of one key from a key/value record, or an empty string.
##
## `RESULT` and `PLAN` share the layout (`PLAN tools 1 bytes 1047 ok true dryRun false`), so
## both are read here. Reading only RESULT made the plan block report "NOT verified" for a plan
## that verified fine - the flag was in PLAN all along.
static func result(records: Array, key: String) -> String:
	for record in records:
		var type: String = record["type"]
		if type != "RESULT" and type != "PLAN":
			continue
		var fields: PackedStringArray = record["fields"]
		for index in range(0, fields.size() - 1, 2):
			if fields[index] == key:
				return fields[index + 1]
	return ""


## Every problem, as "CODE: message", from ERROR and PROBLEM records.
static func problems(records: Array) -> PackedStringArray:
	var found := PackedStringArray()
	for record in records:
		var type: String = record["type"]
		if type != "ERROR" and type != "PROBLEM":
			continue
		var fields: PackedStringArray = record["fields"]
		if fields.size() == 0:
			continue
		var code := fields[0]
		var message := fields[1] if fields.size() > 1 else ""
		if message == "":
			found.append(code)
		else:
			found.append(code + ": " + message)
	return found
