#!/bin/bash
# <swiftbar.title>Codex Multi-Auth Quota</swiftbar.title>
# <swiftbar.version>v1.0</swiftbar.version>
# <swiftbar.author>codex-multi-auth contributors</swiftbar.author>
# <swiftbar.about>macOS menu bar cards for codex-multi-auth account quota (5h/7d windows, active-account marker, reset countdowns)</swiftbar.about>
# <swiftbar.dependencies>codex-multi-auth,python3</swiftbar.dependencies>
# <swiftbar.refreshOnOpen>true</swiftbar.refreshOnOpen>
# <swiftbar.runInBash>true</swiftbar.runInBash>
#
# Reads the local codex-multi-auth quota cache (zero quota cost). The cache is
# written by quota-bearing commands (`check`, `forecast --live`, the interactive
# dashboard); the "Live refresh" menu item runs one such check, sending a
# minimal probe per account.

if [ "$(uname -s)" != "Darwin" ]; then
	echo "⚡"
	echo "---"
	echo "Codex quota plugin requires macOS (SwiftBar) | color=gray"
	exit 0
fi

if [ "$1" = "livecheck" ]; then
	export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.npm-global/bin:$PATH"
	codex-multi-auth check
	exit $?
fi

SELF="$0"

/usr/bin/python3 - "$SELF" <<'PYEOF'
import json, os, sys, time

SELF = sys.argv[1]
HOME = os.path.expanduser("~")
DATA_DIR = os.environ.get("CODEX_MULTI_AUTH_DIR") or os.path.join(HOME, ".codex", "multi-auth")
CACHE = os.path.join(DATA_DIR, "quota-cache.json")
STORE = os.path.join(DATA_DIR, "openai-codex-accounts.json")
OBSERV = os.path.join(DATA_DIR, "runtime-observability.json")

GREEN = "#34C759"
GRAY = "#9A9A9E"
RED = "#FF3B30"
ORANGE = "#FF9F0A"
# Card interior must stay within Menlo-native glyphs (ASCII, box drawing,
# block elements, arrows, geometric circles). CJK or emoji fall back to other
# fonts with non-integer widths and break the right border alignment.
W = 32

def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None

def pad(s, width):
    return s + " " * max(0, width - len(s))

def fmt_reset(ms):
    left = int(ms / 1000 - time.time())
    if left <= 0:
        return "now"
    d, r = divmod(left, 86400)
    h, r = divmod(r, 3600)
    m = r // 60
    if d > 0:
        return f"{d}d {h}h"
    if h > 0:
        return f"{h}h {m}m"
    return f"{m}m"

def clamp_pct(value):
    try:
        return max(0, min(100, int(value)))
    except (TypeError, ValueError):
        return 0

def bar(remaining, slots=10):
    filled = round(remaining / 100 * slots)
    return "█" * filled + "░" * (slots - filled)

def quota_color(rem):
    if rem < 10: return RED
    if rem < 30: return ORANGE
    return None

cache = load(CACHE)
store = load(STORE)
if not cache or not store:
    print("⚡?")
    print("---")
    print("Cannot read quota cache or account store | color=red")
    print(f"Expected under: {DATA_DIR} | size=11 color=gray")
    sys.exit(0)

emails, order = {}, []
for acc in store.get("accounts", []):
    aid = acc.get("accountId", "")
    emails[aid] = acc.get("email", aid[-6:] if aid else "?")
    order.append(aid)

by_id = cache.get("byAccountId", {})

observ = load(OBSERV) or {}
active_id = observ.get("lastAccountId")
if active_id not in order:
    idx = store.get("activeIndex")
    active_id = order[idx] if isinstance(idx, int) and 0 <= idx < len(order) else None

titles, blocks = [], []
newest = 0
for aid in order:
    email = emails.get(aid, "?")
    short = email.split("@")[0]
    is_active = (aid == active_id)
    frame = GREEN if is_active else GRAY
    dot = "●" if is_active else "○"
    tag = "ACTIVE" if is_active else "IDLE"
    rows = [(pad(f"{dot} {short}", W - len(tag)) + tag, None)]
    q = by_id.get(aid)
    if not q:
        titles.append("?")
        rows.append((pad("no quota data", W), None))
    else:
        newest = max(newest, q.get("updatedAt", 0))
        for key, label in (("primary", "5h"), ("secondary", "7d")):
            win = q.get(key, {})
            rem = clamp_pct(100 - clamp_pct(win.get("usedPercent", 0)))
            reset = fmt_reset(win["resetAtMs"]) if win.get("resetAtMs") else "-"
            rows.append((pad(f"{label} {bar(rem)}  {rem:>3}%  → {reset}", W), quota_color(rem)))
            if key == "primary":
                titles.append(f"[{rem}]" if is_active else str(rem))
    blocks.append((frame, rows))

print("⚡" + "·".join(titles))
print("---")
style = "font=Menlo size=12 trim=false emojize=false"
for frame, rows in blocks:
    print(f"╭{'─' * (W + 2)}╮ | color={frame} {style}")
    for text, override in rows:
        print(f"│ {text} │ | color={override or frame} {style}")
    print(f"╰{'─' * (W + 2)}╯ | color={frame} {style}")
if newest:
    age_min = int((time.time() - newest / 1000) / 60)
    age = "just now" if age_min < 1 else (f"{age_min}m ago" if age_min < 60 else f"{age_min//60}h ago")
    print(f"Cache updated {age} | size=11 color=gray")
print(f"Live refresh (one probe per account) | bash={SELF} param1=livecheck terminal=false refresh=true")
print("Reload from cache | refresh=true")
PYEOF
