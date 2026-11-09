"""Built-in MCP server: browser, web search, YouTube, email drafts, maps and apps.

The tools service mounts it in-process; it also runs standalone over stdio
(`python -m gemma_tools.desktop`) for any other MCP client.
"""

from __future__ import annotations

from typing import Annotated, Literal

import httpx
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations
from pydantic import BaseModel, Field

from .. import __version__
from ..config import get_desktop_settings
from . import launcher, links, youtube

MAX_BODY_CHARS = 6000

server = MCPServer(
    name="gemma-desktop",
    title="Gemma desktop actions",
    instructions=(
        "Opens things on the user's computer: the web browser, websites, web and YouTube "
        "searches, YouTube playback, email drafts (never sent), maps and a few desktop apps."
    ),
    version=__version__,
)

_OPENS = ToolAnnotations(
    read_only_hint=False,
    destructive_hint=False,
    idempotent_hint=False,
    open_world_hint=True,
)


class ActionResult(BaseModel):
    ok: bool = True
    message: str = Field(description="One short sentence describing what happened, fit to be spoken.")
    url: str | None = None
    opened_with: str | None = None
    dry_run: bool = False


def _open(url: str, message: str) -> ActionResult:
    settings = get_desktop_settings()
    try:
        launched = launcher.open_url(url, browser=settings.browser, dry_run=settings.dry_run)
    except launcher.LaunchError as exc:
        raise ToolError(str(exc)) from exc
    return ActionResult(message=message, url=url, opened_with=launched.method, dry_run=launched.dry_run)


def _require(text: str, question: str) -> str:
    cleaned = (text or "").strip()
    if not cleaned:
        raise ToolError(question)
    return cleaned


def _engine(engine: str) -> str:
    chosen = get_desktop_settings().search_engine if engine == "default" else engine
    return chosen if chosen in links.SEARCH_ENGINES else "google"


@server.tool(title="Open web browser", annotations=_OPENS)
def open_browser() -> ActionResult:
    """Open the web browser on its home page."""
    return _open(get_desktop_settings().home_url, "I've opened your web browser.")


@server.tool(title="Open website", annotations=_OPENS)
def open_website(
    site: Annotated[
        str,
        Field(description="Site name or address, e.g. 'github', 'gmail', 'bbc.co.uk' or a full https URL"),
    ],
) -> ActionResult:
    """Open a website in the browser by its name or address."""
    site = _require(site, "Which website should I open?")
    resolved = links.resolve_website(site)
    if resolved is None:
        url = links.web_search_url(site, _engine("default"))
        return _open(url, f"I wasn't sure which site you meant, so I searched for {site}.")
    url, label = resolved
    return _open(url, f"I've opened {label}.")


@server.tool(title="Search the web", annotations=_OPENS)
def web_search(
    query: Annotated[str, Field(description="What to search for")],
    engine: Annotated[
        Literal["default", "google", "bing", "duckduckgo"],
        Field(description="Search engine; 'default' uses the user's configured engine"),
    ] = "default",
) -> ActionResult:
    """Search the web and show the results page in the browser."""
    query = _require(query, "What should I search for?")
    chosen = _engine(engine)
    label = {"google": "Google", "bing": "Bing", "duckduckgo": "DuckDuckGo"}[chosen]
    return _open(links.web_search_url(query, chosen), f"I've searched {label} for {query}.")


@server.tool(title="Open YouTube", annotations=_OPENS)
def open_youtube() -> ActionResult:
    """Open the YouTube home page."""
    return _open(links.youtube_home_url(), "I've opened YouTube.")


@server.tool(title="Search YouTube", annotations=_OPENS)
def search_youtube(query: Annotated[str, Field(description="What to search for on YouTube")]) -> ActionResult:
    """Show YouTube search results for a query (does not start a video)."""
    query = _require(query, "What should I look for on YouTube?")
    return _open(links.youtube_search_url(query), f"I've opened YouTube results for {query}.")


@server.tool(title="Play on YouTube", annotations=_OPENS)
def play_youtube(
    query: Annotated[str, Field(description="Song, video or topic to play, e.g. 'lofi hip hop radio'")],
) -> ActionResult:
    """Find the best-matching YouTube video and start playing it."""
    query = _require(query, "What should I play?")
    try:
        video = youtube.find_top_video(query)
    except httpx.HTTPError:
        video = None
    if not video:
        return _open(
            links.youtube_search_url(query),
            f"I couldn't pick a video, so I've opened YouTube results for {query}.",
        )
    title = video.get("title") or query
    return _open(links.youtube_watch_url(video["id"]), f"Playing {title} on YouTube.")


@server.tool(title="Draft email", annotations=_OPENS)
def draft_email(
    subject: Annotated[str, Field(description="Complete subject line")],
    body: Annotated[str, Field(description="Complete email body including greeting and sign-off")],
    to: Annotated[str, Field(description="Recipient email addresses, comma-separated; empty if unknown")] = "",
    cc: Annotated[str, Field(description="Cc email addresses, comma-separated")] = "",
    bcc: Annotated[str, Field(description="Bcc email addresses, comma-separated")] = "",
) -> ActionResult:
    """Open a pre-filled email draft for the user to review and send. It never sends anything."""
    settings = get_desktop_settings()
    client = settings.mail_client if settings.mail_client in links.MAIL_CLIENTS else "gmail"
    to_ok, to_missing = links.split_addresses(to)
    cc_ok, _ = links.split_addresses(cc)
    bcc_ok, _ = links.split_addresses(bcc)
    body = (body or "").strip()
    truncated = len(body) > MAX_BODY_CHARS
    if truncated:
        body = body[:MAX_BODY_CHARS].rstrip() + "\n…"
    url = links.compose_url(
        client,
        to=to_ok,
        subject=(subject or "").strip(),
        body=body,
        cc=cc_ok,
        bcc=bcc_ok,
        gmail_account=settings.gmail_account,
    )
    where = links.mail_client_label(client)
    message = f"I've opened a draft in {where}" + (f" to {', '.join(to_ok)}" if to_ok else "") + "."
    if to_missing:
        message += f" I didn't have an address for {', '.join(to_missing)}, so add it before sending."
    else:
        message += " Check it over and hit send when you're ready."
    if truncated:
        message += " The body was long, so I shortened it."
    return _open(url, message)


@server.tool(title="Show on map", annotations=_OPENS)
def show_on_map(place: Annotated[str, Field(description="Place, address or 'coffee near me' style query")]) -> ActionResult:
    """Show a place or nearby search on Google Maps."""
    place = _require(place, "Which place should I show on the map?")
    return _open(links.maps_search_url(place), f"I've opened {place} on Google Maps.")


@server.tool(title="Get directions", annotations=_OPENS)
def get_directions(
    destination: Annotated[str, Field(description="Where the user wants to go")],
    origin: Annotated[str, Field(description="Starting point; empty means the user's current location")] = "",
    mode: Annotated[
        Literal["driving", "walking", "transit", "bicycling"], Field(description="How the user travels")
    ] = "driving",
) -> ActionResult:
    """Open Google Maps directions to a destination."""
    destination = _require(destination, "Where do you want directions to?")
    message = f"I've opened {mode} directions to {destination}" + (f" from {origin}" if origin.strip() else "") + "."
    return _open(links.maps_directions_url(destination, origin, mode), message)


@server.tool(title="Open app", annotations=_OPENS)
def open_app(
    app: Annotated[
        Literal["calculator", "text_editor", "file_manager", "terminal", "settings"],
        Field(description="Which desktop app to open"),
    ],
) -> ActionResult:
    """Open a desktop app: calculator, text editor, file manager, terminal or system settings."""
    settings = get_desktop_settings()
    try:
        launched = launcher.open_app(app, dry_run=settings.dry_run)
    except launcher.LaunchError as exc:
        raise ToolError(str(exc)) from exc
    message = f"I've opened {launcher.APPS[app].label}."
    return ActionResult(message=message, opened_with=launched.method, dry_run=launched.dry_run)
