#!/usr/bin/env python3
"""Press keys in an X11 window through the XTEST extension ($DISPLAY).

Usage: xkey.py <window-id> <keysym>...   (e.g. xkey.py 0x400003 Menu)

For keys WebDriver has no code for, such as the Menu (ContextMenu) key.
Focuses the window first (Xvfb has no window manager to do it), then sends a
press and a release per keysym. Only libX11 and libXtst are needed (ctypes).
"""

import ctypes
import ctypes.util
import sys
import time


def lib(name):
    path = ctypes.util.find_library(name)
    if not path:
        sys.exit(f"xkey.py: lib{name} not found")
    return ctypes.CDLL(path)


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    x11 = lib("X11")
    xtst = lib("Xtst")
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XStringToKeysym.restype = ctypes.c_ulong
    x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
    x11.XKeysymToKeycode.restype = ctypes.c_ubyte
    x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x11.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    x11.XFlush.argtypes = [ctypes.c_void_p]
    x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

    dpy = x11.XOpenDisplay(None)
    if not dpy:
        sys.exit("xkey.py: cannot open $DISPLAY")
    window = int(sys.argv[1], 16)
    # RevertToParent = 2, CurrentTime = 0.
    x11.XSetInputFocus(dpy, window, 2, 0)
    x11.XSync(dpy, 0)
    time.sleep(0.1)
    for name in sys.argv[2:]:
        keysym = x11.XStringToKeysym(name.encode())
        code = x11.XKeysymToKeycode(dpy, keysym) if keysym else 0
        if not code:
            sys.exit(f"xkey.py: no keycode for {name}")
        xtst.XTestFakeKeyEvent(dpy, code, 1, 0)
        xtst.XTestFakeKeyEvent(dpy, code, 0, 0)
        x11.XSync(dpy, 0)
    x11.XCloseDisplay(dpy)


if __name__ == "__main__":
    main()
