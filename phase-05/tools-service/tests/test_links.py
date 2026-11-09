from urllib.parse import parse_qs, urlsplit

from gemma_tools.desktop import links


def test_search_urls_encode_everything():
    url = links.web_search_url("tom & jerry: 50% off?", "google")
    assert url == "https://www.google.com/search?q=tom%20%26%20jerry%3A%2050%25%20off%3F"
    assert links.web_search_url("x", "duckduckgo").startswith("https://duckduckgo.com/?q=")
    assert links.web_search_url("x", "unknown").startswith("https://www.google.com/")
    assert links.youtube_search_url("lofi hip hop") == "https://www.youtube.com/results?search_query=lofi%20hip%20hop"


def test_gmail_compose_round_trips_fields():
    body = "Hi Sam,\n\nRunning late & will join at 11.\n\nThanks"
    url = links.compose_url("gmail", to=["sam@example.com"], subject="Late today", body=body)
    parts = urlsplit(url)
    assert parts.netloc == "mail.google.com"
    query = parse_qs(parts.query)
    assert query["view"] == ["cm"]
    assert query["to"] == ["sam@example.com"]
    assert query["su"] == ["Late today"]
    assert query["body"] == [body]
    assert "+" not in parts.query


def test_gmail_account_and_other_clients():
    url = links.compose_url("gmail", to=[], subject="s", body="b", gmail_account="me@example.com")
    assert parse_qs(urlsplit(url).query)["authuser"] == ["me@example.com"]
    assert links.compose_url("outlook", to=["a@b.co"], subject="s", body="b").startswith(
        "https://outlook.office.com/mail/deeplink/compose?"
    )
    assert links.compose_url("outlook-personal", to=[], subject="s", body="b").startswith(
        "https://outlook.live.com/"
    )
    mailto = links.compose_url("mailto", to=["a@b.co", "c@d.co"], subject="Hi there", body="x\ny")
    assert mailto == "mailto:a@b.co,c@d.co?subject=Hi%20there&body=x%0Ay"


def test_split_addresses():
    ok, missing = links.split_addresses("boss@example.com, John; <hr@corp.co.uk>")
    assert ok == ["boss@example.com", "hr@corp.co.uk"]
    assert missing == ["John"]


def test_resolve_website():
    assert links.resolve_website("YouTube") == ("https://www.youtube.com/", "YouTube")
    assert links.resolve_website("you tube")[1] == "YouTube"
    assert links.resolve_website("github dot com") == ("https://github.com/", "GitHub")
    assert links.resolve_website("the Gmail website")[1] == "Gmail"
    assert links.resolve_website("wikipedia.org") == ("https://wikipedia.org", "wikipedia.org")
    assert links.resolve_website("https://example.com/a?b=1") == ("https://example.com/a?b=1", "example.com")
    assert links.resolve_website("the bbc website") is None
    assert links.resolve_website("") is None


def test_maps_urls():
    assert links.maps_search_url("coffee near me") == "https://www.google.com/maps/search/?api=1&query=coffee%20near%20me"
    url = links.maps_directions_url("Airport", origin="", mode="teleport")
    assert "travelmode=driving" in url and "origin" not in url


def test_is_web_url():
    assert links.is_web_url("https://x.org")
    assert not links.is_web_url("javascript:alert(1)")
    assert not links.is_web_url("file:///etc/passwd")
