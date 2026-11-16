#!/usr/bin/env python3
"""Click a mouse button in an X11 window through the XTEST extension ($DISPLAY).

Usage: xclick.py <window-id> <x> <y> [button]   (button 3 = right; default 1)

x and y are relative to the window. For a real click where WebDriver's
synthesized one may behave differently (a right click, #205). Only libX11
and libXtst are needed (ctypes).
"""

import ctypes
import ctypes.util
import sys
import time


def lib(name):
    path = ctypes.util.find_library(name)
    if not path:
        sys.exit(f"xclick.py: lib{name} not found")
    return ctypes.CDLL(path)


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    x11 = lib("X11")
    xtst = lib("Xtst")
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XWarpPointer.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong,
        ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_int, ctypes.c_int,
    ]
    x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

    dpy = x11.XOpenDisplay(None)
    if not dpy:
        sys.exit("xclick.py: cannot open $DISPLAY")
    window = int(sys.argv[1], 16)
    x, y = int(sys.argv[2]), int(sys.argv[3])
    button = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    x11.XWarpPointer(dpy, 0, window, 0, 0, 0, 0, x, y)
    x11.XSync(dpy, 0)
    time.sleep(0.1)
    xtst.XTestFakeButtonEvent(dpy, button, 1, 0)
    x11.XSync(dpy, 0)
    time.sleep(0.05)
    xtst.XTestFakeButtonEvent(dpy, button, 0, 0)
    x11.XSync(dpy, 0)
    x11.XCloseDisplay(dpy)


if __name__ == "__main__":
    main()
