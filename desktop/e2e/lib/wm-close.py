#!/usr/bin/env python3
"""Ask X11 windows to close the way a window manager's close button does:
send each a WM_PROTOCOLS / WM_DELETE_WINDOW client message ($DISPLAY).

Usage: wm-close.py <window-id>...

Used by lib/window.mjs `closeLikeUser`: WebDriver's Close Window on the last
window ends the session and kills the app at once, so the app's own exit
path (RunEvent::Exit, window Destroyed) never runs. Xvfb has no window
manager, so nothing else sends this message. Only libX11 is needed (ctypes).
"""

import ctypes
import ctypes.util
import sys


class ClientMessage(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("window", ctypes.c_ulong),
        ("message_type", ctypes.c_ulong),
        ("format", ctypes.c_int),
        ("l", ctypes.c_long * 5),
    ]


class XEvent(ctypes.Union):
    _fields_ = [("xclient", ClientMessage), ("pad", ctypes.c_long * 24)]


CLIENT_MESSAGE = 33
NO_EVENT_MASK = 0


def main(ids):
    x11 = ctypes.cdll.LoadLibrary(ctypes.util.find_library("X11") or "libX11.so.6")
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XInternAtom.restype = ctypes.c_ulong
    x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x11.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.POINTER(XEvent)]
    x11.XFlush.argtypes = [ctypes.c_void_p]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]

    display = x11.XOpenDisplay(None)
    if not display:
        sys.exit("cannot open display")
    protocols = x11.XInternAtom(display, b"WM_PROTOCOLS", 0)
    delete = x11.XInternAtom(display, b"WM_DELETE_WINDOW", 0)
    for wid in ids:
        ev = XEvent()
        ev.xclient.type = CLIENT_MESSAGE
        ev.xclient.window = wid
        ev.xclient.message_type = protocols
        ev.xclient.format = 32
        ev.xclient.l[0] = delete
        ev.xclient.l[1] = 0  # CurrentTime
        x11.XSendEvent(display, wid, 0, NO_EVENT_MASK, ctypes.byref(ev))
    x11.XFlush(display)
    x11.XCloseDisplay(display)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main([int(a, 0) for a in sys.argv[1:]])
