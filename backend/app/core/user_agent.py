"""Plain browser and system names from a stored user agent ("your devices", ``GET /me/sessions``).

Deliberately small and dependency-free: it recognises only the browsers and systems the
contract names, and answers ``None`` for anything else, so the client shows "Unknown device"
rather than a wrong guess. The raw user agent itself is never returned to clients.

Order matters, because user agents borrow each other's tokens: Samsung Internet, Edge and
Opera all say "Chrome", and Chrome says "Safari"; every iPhone says "like Mac OS X", and
Android says "Linux". iPadOS in desktop mode sends a macOS user agent and is reported as
macOS (it cannot be told apart from the string alone).
"""

from __future__ import annotations

from dataclasses import dataclass

# Chromium-based browsers the contract does not name: never reported as Chrome.
_OTHER_CHROMIUM = ("OPR/", "Opera", "YaBrowser/", "UCBrowser/", "MiuiBrowser/", "HuaweiBrowser/")


@dataclass(frozen=True)
class Device:
    browser: str | None
    os: str | None


def parse(user_agent: str | None) -> Device:
    ua = user_agent or ""
    return Device(browser=_browser(ua), os=_os(ua))


def _browser(ua: str) -> str | None:
    if "SamsungBrowser/" in ua:
        return "Samsung Internet"
    if any(token in ua for token in ("Edg/", "EdgA/", "EdgiOS/", "Edge/")):
        return "Edge"
    if "Firefox/" in ua or "FxiOS/" in ua:
        return "Firefox"
    if any(token in ua for token in _OTHER_CHROMIUM):
        return None
    if "CriOS/" in ua or "Chrome/" in ua or "Chromium/" in ua:
        return "Chrome"
    if "Safari/" in ua and "Version/" in ua:
        return "Safari"
    return None


def _os(ua: str) -> str | None:
    if "Android" in ua:
        return "Android"
    if "iPhone" in ua or "iPod" in ua:
        return "iPhone"
    if "iPad" in ua:
        return "iPad"
    if "Windows" in ua:
        return "Windows"
    if "Macintosh" in ua or "Mac OS X" in ua:
        return "macOS"
    if "CrOS" in ua:
        return None  # ChromeOS: not one of the named systems
    if "Linux" in ua:
        return "Linux"
    return None
