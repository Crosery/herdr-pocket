"""Headless dmgbuild configuration for Herdr Pocket macOS DMG installers."""

import os

_APP_PATH = defines.get("app")
if not _APP_PATH:
    raise RuntimeError("Missing -D app=/path/to/Herdr Pocket.app")
_APP_NAME = os.path.basename(_APP_PATH.rstrip("/"))


def _find_repo_root() -> str:
    explicit = defines.get("repo")
    if explicit and os.path.isdir(explicit):
        return os.path.abspath(explicit)
    for start in (os.getcwd(), os.path.dirname(os.path.abspath(_APP_PATH))):
        cur = os.path.abspath(start)
        while True:
            if os.path.isfile(os.path.join(cur, "apps/desktop/src-tauri/icons/icon.icns")):
                return cur
            parent = os.path.dirname(cur)
            if parent == cur:
                break
            cur = parent
    raise RuntimeError("Unable to locate repository root (pass -D repo=/path/to/herdr-pocket)")


_ROOT = _find_repo_root()

format = "UDZO"
size = None

files = [_APP_PATH]
symlinks = {"Applications": "/Applications"}

icon = os.path.join(_ROOT, "apps/desktop/src-tauri/icons/icon.icns")
background = os.path.join(_ROOT, "apps/desktop/src-tauri/dmg/background.tiff")

window_rect = ((200, 200), (660, 448))
default_view = "icon-view"

show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
sidebar_width = 180

arrange_by = None
grid_offset = (0, 0)
grid_spacing = 100
scroll_position = (0, 0)
label_pos = "bottom"
text_size = 13
icon_size = 108

icon_locations = {
    _APP_NAME: (185, 194),
    "Applications": (475, 194),
}
