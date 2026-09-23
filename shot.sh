#!/usr/bin/env bash
# Dev helper: headless screenshot of the local server. Usage: ./shot.sh out.png "query" WxH
CH="/c/Program Files/Google/Chrome/Application/chrome.exe"
SP="${SP:-.shots}"
"$CH" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$SP/prof-$RANDOM" --window-size="${3:-1440,900}" --virtual-time-budget=4000 --screenshot="$1" "http://localhost:5191/${2}" >/dev/null 2>&1
