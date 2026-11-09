"""Find the top YouTube search result without an API key."""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from typing import Any

import httpx

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/128.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}
# Skips the EU cookie-consent interstitial.
_COOKIES = {"CONSENT": "YES+cb", "SOCS": "CAI"}

_INITIAL_DATA = re.compile(
    r"(?:var\s+ytInitialData|window\[\"ytInitialData\"\])\s*=\s*(\{.+?\});\s*</script>", re.S
)
_VIDEO_ID = re.compile(r'"videoId":"([A-Za-z0-9_-]{11})"')


def _text(node: Any) -> str:
    if not isinstance(node, dict):
        return ""
    if isinstance(node.get("simpleText"), str):
        return node["simpleText"]
    runs = node.get("runs")
    if isinstance(runs, list):
        return "".join(r.get("text", "") for r in runs if isinstance(r, dict))
    return ""


def _video_renderers(node: Any) -> Iterator[dict]:
    """Organic video results in page order (ads, shorts and shelves use other keys)."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "videoRenderer" and isinstance(value, dict):
                yield value
            else:
                yield from _video_renderers(value)
    elif isinstance(node, list):
        for item in node:
            yield from _video_renderers(item)


def parse_top_video(html: str) -> dict[str, str] | None:
    match = _INITIAL_DATA.search(html)
    if match:
        try:
            data = json.loads(match.group(1))
        except ValueError:
            data = None
        for video in _video_renderers(data):
            video_id = video.get("videoId")
            if isinstance(video_id, str) and len(video_id) == 11:
                return {
                    "id": video_id,
                    "title": _text(video.get("title")),
                    "channel": _text(video.get("ownerText") or video.get("longBylineText")),
                }
    fallback = _VIDEO_ID.search(html)
    if fallback:
        return {"id": fallback.group(1), "title": "", "channel": ""}
    return None


def find_top_video(query: str, timeout_s: float = 6.0) -> dict[str, str] | None:
    response = httpx.get(
        "https://www.youtube.com/results",
        params={"search_query": query, "hl": "en"},
        headers=_HEADERS,
        cookies=_COOKIES,
        timeout=timeout_s,
        follow_redirects=True,
    )
    response.raise_for_status()
    return parse_top_video(response.text)
