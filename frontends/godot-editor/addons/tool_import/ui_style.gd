@tool
extends RefCounted

## Button styling shared by every window this addon opens.
##
## WHY THIS EXISTS
## ---------------
## The editor theme's button styles are built for docked panels, and this addon draws floating
## windows whose background is a different shade. On it, the theme's hover tint was close enough
## to its resting colour that a hovered button looked untouched, and a flat MenuButton looked like
## a label - so a dropdown did not read as a dropdown. Every state is drawn explicitly here, in one
## place, so the two windows cannot drift apart.

const NORMAL := Color(0.24, 0.25, 0.27)
const HOVER := Color(0.33, 0.35, 0.38)
const PRESSED := Color(0.18, 0.19, 0.21)
const BORDER := Color(0.38, 0.40, 0.43)

const MIN_HEIGHT := 26


## Give a button a frame, a minimum height and a hover state that can be seen.
static func button(target: Button, min_width: int = 0) -> void:
	target.flat = false
	target.custom_minimum_size = Vector2(min_width, MIN_HEIGHT)
	target.add_theme_stylebox_override("normal", box(NORMAL))
	target.add_theme_stylebox_override("hover", box(HOVER))
	target.add_theme_stylebox_override("pressed", box(PRESSED))
	target.add_theme_stylebox_override("focus", box(HOVER))


static func box(colour: Color) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = colour
	style.border_color = BORDER
	style.set_border_width_all(1)
	style.set_corner_radius_all(3)
	style.content_margin_left = 8
	style.content_margin_right = 8
	style.content_margin_top = 5
	style.content_margin_bottom = 5
	return style
