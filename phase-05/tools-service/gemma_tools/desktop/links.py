"""Pure URL builders for the desktop tools (no I/O, identical on every OS)."""

from __future__ import annotations

import re
from urllib.parse import quote, urlencode, urlsplit

SEARCH_ENGINES = {
    "google": "https://www.google.com/search?q={q}",
    "bing": "https://www.bing.com/search?q={q}",
    "duckduckgo": "https://duckduckgo.com/?q={q}",
}

MAIL_CLIENTS = ("gmail", "outlook", "outlook-personal", "mailto")

TRAVEL_MODES = ("driving", "walking", "transit", "bicycling")

# Spoken site names -> (url, label used in the spoken confirmation).
KNOWN_SITES: dict[str, tuple[str, str]] = {
    "google": ("https://www.google.com/", "Google"),
    "youtube": ("https://www.youtube.com/", "YouTube"),
    "youtubemusic": ("https://music.youtube.com/", "YouTube Music"),
    "gmail": ("https://mail.google.com/", "Gmail"),
    "googlemaps": ("https://www.google.com/maps", "Google Maps"),
    "maps": ("https://www.google.com/maps", "Google Maps"),
    "googledrive": ("https://drive.google.com/", "Google Drive"),
    "drive": ("https://drive.google.com/", "Google Drive"),
    "googlecalendar": ("https://calendar.google.com/", "Google Calendar"),
    "calendar": ("https://calendar.google.com/", "Google Calendar"),
    "googledocs": ("https://docs.google.com/", "Google Docs"),
    "googlenews": ("https://news.google.com/", "Google News"),
    "news": ("https://news.google.com/", "Google News"),
    "googletranslate": ("https://translate.google.com/", "Google Translate"),
    "translate": ("https://translate.google.com/", "Google Translate"),
    "github": ("https://github.com/", "GitHub"),
    "gitlab": ("https://gitlab.com/", "GitLab"),
    "stackoverflow": ("https://stackoverflow.com/", "Stack Overflow"),
    "wikipedia": ("https://www.wikipedia.org/", "Wikipedia"),
    "wiki": ("https://www.wikipedia.org/", "Wikipedia"),
    "reddit": ("https://www.reddit.com/", "Reddit"),
    "linkedin": ("https://www.linkedin.com/", "LinkedIn"),
    "twitter": ("https://x.com/", "X"),
    "x": ("https://x.com/", "X"),
    "facebook": ("https://www.facebook.com/", "Facebook"),
    "fb": ("https://www.facebook.com/", "Facebook"),
    "instagram": ("https://www.instagram.com/", "Instagram"),
    "insta": ("https://www.instagram.com/", "Instagram"),
    "whatsapp": ("https://web.whatsapp.com/", "WhatsApp Web"),
    "whatsappweb": ("https://web.whatsapp.com/", "WhatsApp Web"),
    "amazon": ("https://www.amazon.com/", "Amazon"),
    "netflix": ("https://www.netflix.com/", "Netflix"),
    "spotify": ("https://open.spotify.com/", "Spotify"),
    "outlook": ("https://outlook.office.com/mail/", "Outlook"),
    "chatgpt": ("https://chatgpt.com/", "ChatGPT"),
    "huggingface": ("https://huggingface.co/", "Hugging Face"),
}

_DOMAIN_RE = re.compile(
    r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?::\d{2,5})?(?:[/?#]\S*)?$",
    re.IGNORECASE,
)
_EMAIL_RE = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$")


def _q(text: str) -> str:
    return quote(text.strip(), safe="")


def _query(params: dict[str, str]) -> str:
    return urlencode({k: v for k, v in params.items() if v}, quote_via=quote)


def is_web_url(url: str) -> bool:
    parts = urlsplit(url)
    return parts.scheme in ("http", "https") and bool(parts.netloc)


def web_search_url(query: str, engine: str = "google") -> str:
    template = SEARCH_ENGINES.get(engine, SEARCH_ENGINES["google"])
    return template.format(q=_q(query))


def youtube_home_url() -> str:
    return "https://www.youtube.com/"


def youtube_search_url(query: str) -> str:
    return f"https://www.youtube.com/results?search_query={_q(query)}"


def youtube_watch_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={quote(video_id, safe='')}"


def maps_search_url(place: str) -> str:
    return "https://www.google.com/maps/search/?" + _query({"api": "1", "query": place.strip()})


def maps_directions_url(destination: str, origin: str = "", mode: str = "driving") -> str:
    params = {
        "api": "1",
        "destination": destination.strip(),
        "origin": origin.strip(),
        "travelmode": mode if mode in TRAVEL_MODES else "driving",
    }
    return "https://www.google.com/maps/dir/?" + _query(params)


def split_addresses(raw: str) -> tuple[list[str], list[str]]:
    """Split a To/Cc field into (valid email addresses, rejected names)."""
    valid: list[str] = []
    rejected: list[str] = []
    for part in re.split(r"[,;]", raw or ""):
        part = part.strip().strip("<>").strip()
        if not part:
            continue
        (valid if _EMAIL_RE.match(part) else rejected).append(part)
    return valid, rejected


def compose_url(
    client: str,
    *,
    to: list[str],
    subject: str,
    body: str,
    cc: list[str] | None = None,
    bcc: list[str] | None = None,
    gmail_account: str = "",
) -> str:
    """URL that opens a pre-filled draft. Nothing is ever sent."""
    to_s = ",".join(to)
    cc_s = ",".join(cc or [])
    bcc_s = ",".join(bcc or [])
    if client == "mailto":
        query = _query({"subject": subject, "body": body, "cc": cc_s, "bcc": bcc_s})
        return f"mailto:{quote(to_s, safe='@,')}" + (f"?{query}" if query else "")
    if client in ("outlook", "outlook-personal"):
        base = (
            "https://outlook.live.com/mail/0/deeplink/compose?"
            if client == "outlook-personal"
            else "https://outlook.office.com/mail/deeplink/compose?"
        )
        return base + _query({"to": to_s, "cc": cc_s, "bcc": bcc_s, "subject": subject, "body": body})
    params = {
        "authuser": gmail_account,
        "view": "cm",
        "fs": "1",
        "to": to_s,
        "cc": cc_s,
        "bcc": bcc_s,
        "su": subject,
        "body": body,
    }
    return "https://mail.google.com/mail/?" + _query(params)


def mail_client_label(client: str) -> str:
    return {
        "gmail": "Gmail",
        "outlook": "Outlook",
        "outlook-personal": "Outlook",
        "mailto": "your mail app",
    }.get(client, "Gmail")


def _site_key(text: str) -> str:
    t = text.lower().strip()
    t = re.sub(r"\b(dot)\b", ".", t)
    t = re.sub(r"^(the|my)\s+", "", t)
    t = re.sub(r"\s+(website|web site|site|homepage|home page|page|app)$", "", t)
    return re.sub(r"[^a-z0-9.]", "", t)


def resolve_website(target: str) -> tuple[str, str] | None:
    """Map a spoken site name, bare domain or URL to (url, label); None if unknown."""
    raw = target.strip().strip("\"'")
    if not raw:
        return None
    if is_web_url(raw):
        return raw, urlsplit(raw).netloc
    key = _site_key(raw)
    if key in KNOWN_SITES:
        return KNOWN_SITES[key]
    compact = key.removesuffix(".com")
    if compact in KNOWN_SITES:
        return KNOWN_SITES[compact]
    candidate = re.sub(r"\s+dot\s+", ".", raw.lower()).replace(" ", "")
    if _DOMAIN_RE.match(candidate):
        url = f"https://{candidate}"
        return url, urlsplit(url).netloc
    return None
