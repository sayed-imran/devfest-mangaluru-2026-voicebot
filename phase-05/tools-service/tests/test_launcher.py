import sys

import pytest

from gemma_tools.desktop import launcher


def test_windows_command_templates():
    url = "https://www.youtube.com/results?search_query=a%20b&x=1"
    chrome = launcher.split_windows_command(
        r'"C:\Program Files\Google\Chrome\Application\chrome.exe" --single-argument %1'
    )
    assert launcher.fill_command_template(chrome, url) == [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        "--single-argument",
        url,
    ]
    firefox = launcher.split_windows_command(r'"C:\Program Files\Mozilla Firefox\firefox.exe" -osint -url "%1"')
    assert launcher.fill_command_template(firefox, url)[-3:] == ["-osint", "-url", url]
    bare = launcher.split_windows_command(r'"C:\Apps\browser.exe"')
    assert launcher.fill_command_template(bare, url) == [r"C:\Apps\browser.exe", url]


@pytest.mark.parametrize("url", ["javascript:alert(1)", "file:///etc/passwd", "ms-settings:", "C:\\Windows\\cmd.exe"])
def test_only_web_and_mailto_links_open(url):
    with pytest.raises(launcher.LaunchError):
        launcher.open_url(url, dry_run=True)


def test_dry_run_opens_nothing():
    result = launcher.open_url("https://example.com", dry_run=True)
    assert result.dry_run and result.method == "dry-run"
    assert launcher.open_app("calculator", dry_run=True).dry_run


def test_unknown_app_is_rejected():
    with pytest.raises(launcher.LaunchError):
        launcher.open_app("powershell", dry_run=True)


def test_every_app_has_a_command_for_each_os():
    for key, spec in launcher.APPS.items():
        assert spec.windows or spec.windows_uri, key
        assert spec.mac, key
        assert spec.linux, key


def test_platform_label_is_human_readable():
    label = launcher.platform_label()
    assert label and isinstance(label, str)


@pytest.mark.skipif(sys.platform in ("win32", "darwin"), reason="Linux desktop discovery")
def test_linux_without_desktop_explains_itself(monkeypatch, tmp_path):
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    monkeypatch.setattr(launcher, "_logind_graphical_session", lambda uid: None)
    monkeypatch.setattr(launcher, "_user_x_display", lambda uid: "")
    with pytest.raises(launcher.LaunchError) as err:
        launcher.linux_gui_env()
    assert "no logged-in desktop" in str(err.value)


@pytest.mark.skipif(sys.platform in ("win32", "darwin"), reason="Linux desktop discovery")
def test_linux_ssh_session_finds_the_desktop(monkeypatch, tmp_path):
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    monkeypatch.setattr(launcher, "_logind_graphical_session", lambda uid: {"Type": "x11", "Display": ":1"})
    env = launcher.linux_gui_env()
    assert env["DISPLAY"] == ":1"
    assert env["XDG_RUNTIME_DIR"] == str(tmp_path)
