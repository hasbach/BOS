"""The user-agent parser behind "your devices" (``app.core.user_agent``), on real strings."""

from __future__ import annotations

import pytest

from app.core.user_agent import Device, parse

CASES = [
    (  # Chrome on Android
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/130.0.0.0 Mobile Safari/537.36",
        "Chrome",
        "Android",
    ),
    (  # Samsung Internet (contains Chrome and Safari)
        "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) "
        "SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
        "Samsung Internet",
        "Android",
    ),
    (  # Edge on Windows (contains Chrome and Safari)
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68",
        "Edge",
        "Windows",
    ),
    (  # Edge on Android
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.2849.80",
        "Edge",
        "Android",
    ),
    (  # Chrome on Windows
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/130.0.0.0 Safari/537.36",
        "Chrome",
        "Windows",
    ),
    (  # Safari on iPhone (says "like Mac OS X")
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
        "Safari",
        "iPhone",
    ),
    (  # Chrome on iPhone
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_7 like Mac OS X) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1",
        "Chrome",
        "iPhone",
    ),
    (  # Firefox on iPhone
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_7 like Mac OS X) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15",
        "Firefox",
        "iPhone",
    ),
    (  # Edge on iPhone
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_7 like Mac OS X) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) Version/17.0 EdgiOS/130.2849.80 Mobile/15E148 Safari/605.1.15",
        "Edge",
        "iPhone",
    ),
    (  # Safari on iPad (mobile mode)
        "Mozilla/5.0 (iPad; CPU OS 17_7 like Mac OS X) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        "Safari",
        "iPad",
    ),
    (  # iPadOS desktop mode: indistinguishable from macOS, reported as macOS
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) Version/18.1 Safari/605.1.15",
        "Safari",
        "macOS",
    ),
    (  # Chrome on macOS
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Chrome",
        "macOS",
    ),
    (  # Firefox on macOS
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:132.0) Gecko/20100101 Firefox/132.0",
        "Firefox",
        "macOS",
    ),
    (  # Firefox on Windows
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
        "Firefox",
        "Windows",
    ),
    (  # Firefox on Linux
        "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
        "Firefox",
        "Linux",
    ),
    (  # Firefox on Android
        "Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0",
        "Firefox",
        "Android",
    ),
    (  # Chrome on Linux
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/130.0.0.0 Safari/537.36",
        "Chrome",
        "Linux",
    ),
    (  # Opera: Chromium-based but not a named browser
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/129.0.0.0 Safari/537.36 OPR/115.0.0.0",
        None,
        "Windows",
    ),
    (  # ChromeOS: Chrome, but not a named system
        "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/130.0.0.0 Safari/537.36",
        "Chrome",
        None,
    ),
    (  # an in-app iPhone web view: no browser token
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_7 like Mac OS X) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) Mobile/15E148",
        None,
        "iPhone",
    ),
    ("curl/8.4.0", None, None),
    ("python-requests/2.32.3", None, None),
    ("Werkzeug/3.1.3", None, None),
]


@pytest.mark.parametrize(("ua", "browser", "os"), CASES)
def test_real_user_agents(ua: str, browser: str | None, os: str | None) -> None:
    assert parse(ua) == Device(browser=browser, os=os)


@pytest.mark.parametrize("ua", ["", None])
def test_missing_user_agent_is_unknown(ua: str | None) -> None:
    assert parse(ua) == Device(browser=None, os=None)
