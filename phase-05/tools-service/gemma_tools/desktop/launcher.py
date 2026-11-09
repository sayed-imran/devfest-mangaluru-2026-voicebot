"""Open web links and allow-listed apps on the computer running this service.

Each OS uses its native mechanism (Windows shell/registry, macOS `open`,
Linux `xdg-open`). GUI processes are started detached so they outlive the
service, and console browsers are never used.
"""

from __future__ import annotations

import os
import platform
import shutil
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

IS_WINDOWS = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"

_BREAKAWAY_FROM_JOB = getattr(subprocess, "CREATE_BREAKAWAY_FROM_JOB", 0x01000000)

NO_DESKTOP = (
    "There's no logged-in desktop on the computer running the tools service, so I can't "
    "open anything there. Run the tools service on the computer you're using, or log in "
    "to this machine's desktop."
)


class LaunchError(RuntimeError):
    """Something couldn't be opened; the message is safe to show and speak."""


@dataclass(frozen=True)
class Launched:
    target: str
    method: str
    dry_run: bool = False


@dataclass(frozen=True)
class BrowserSpec:
    label: str
    windows_exe: str = ""
    windows_paths: tuple[str, ...] = ()
    mac_app: str = ""
    linux: tuple[str, ...] = ()


BROWSERS: dict[str, BrowserSpec] = {
    "chrome": BrowserSpec(
        "Google Chrome",
        "chrome.exe",
        (
            r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
            r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
            r"%LocalAppData%\Google\Chrome\Application\chrome.exe",
        ),
        "Google Chrome",
        ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"),
    ),
    "edge": BrowserSpec(
        "Microsoft Edge",
        "msedge.exe",
        (
            r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
            r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe",
        ),
        "Microsoft Edge",
        ("microsoft-edge", "microsoft-edge-stable"),
    ),
    "firefox": BrowserSpec(
        "Firefox",
        "firefox.exe",
        (
            r"%ProgramFiles%\Mozilla Firefox\firefox.exe",
            r"%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe",
        ),
        "Firefox",
        ("firefox",),
    ),
    "brave": BrowserSpec(
        "Brave",
        "brave.exe",
        (
            r"%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe",
            r"%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe",
        ),
        "Brave Browser",
        ("brave-browser", "brave"),
    ),
    "safari": BrowserSpec("Safari", mac_app="Safari"),
}

_LINUX_FALLBACK_BROWSERS = (
    "x-www-browser",
    "firefox",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "brave-browser",
    "microsoft-edge",
)


@dataclass(frozen=True)
class AppSpec:
    label: str
    windows: tuple[tuple[str, ...], ...] = ()
    windows_uri: str = ""
    windows_console: bool = False
    mac: tuple[str, ...] = ()
    linux: tuple[tuple[str, ...], ...] = ()


APPS: dict[str, AppSpec] = {
    "calculator": AppSpec(
        "the calculator",
        windows=(("calc.exe",),),
        mac=("Calculator",),
        linux=(
            ("gnome-calculator",),
            ("kcalc",),
            ("mate-calc",),
            ("galculator",),
            ("qalculate-gtk",),
            ("xcalc",),
        ),
    ),
    "text_editor": AppSpec(
        "the text editor",
        windows=(("notepad.exe",),),
        mac=("TextEdit",),
        linux=(
            ("gnome-text-editor",),
            ("gedit",),
            ("kate",),
            ("kwrite",),
            ("mousepad",),
            ("xed",),
            ("pluma",),
        ),
    ),
    "file_manager": AppSpec(
        "the file manager",
        windows=(("explorer.exe",),),
        mac=("Finder",),
        linux=(("nautilus",), ("dolphin",), ("thunar",), ("nemo",), ("caja",), ("pcmanfm",)),
    ),
    "terminal": AppSpec(
        "a terminal",
        windows=(("wt.exe",), ("cmd.exe",)),
        windows_console=True,
        mac=("Terminal",),
        linux=(
            ("x-terminal-emulator",),
            ("gnome-terminal",),
            ("kgx",),
            ("konsole",),
            ("xfce4-terminal",),
            ("mate-terminal",),
            ("xterm",),
        ),
    ),
    "settings": AppSpec(
        "system settings",
        windows_uri="ms-settings:",
        mac=("System Settings", "System Preferences"),
        linux=(
            ("gnome-control-center",),
            ("systemsettings",),
            ("xfce4-settings-manager",),
            ("cinnamon-settings",),
            ("mate-control-center",),
        ),
    ),
}


def platform_label() -> str:
    if IS_WINDOWS:
        build = sys.getwindowsversion().build
        return "Windows 11" if build >= 22000 else f"Windows {platform.release()}"
    if IS_MAC:
        version = platform.mac_ver()[0]
        return f"macOS {version}".strip()
    try:
        return platform.freedesktop_os_release().get("PRETTY_NAME") or "Linux"
    except OSError:
        return "Linux"


def _spawn(
    argv: list[str],
    env: dict[str, str] | None = None,
    *,
    wait_s: float = 0.0,
    console: bool = False,
) -> int | None:
    """Start a process detached from this service; returns its exit code if it ends within wait_s."""
    kwargs: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
        "env": env,
    }
    if IS_WINDOWS:
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | (
            subprocess.CREATE_NEW_CONSOLE if console else subprocess.DETACHED_PROCESS
        )
        try:
            # Leave any job object we run in, so the app survives a service restart.
            proc = subprocess.Popen(argv, creationflags=flags | _BREAKAWAY_FROM_JOB, **kwargs)
        except PermissionError:
            proc = subprocess.Popen(argv, creationflags=flags, **kwargs)
    else:
        proc = subprocess.Popen(argv, start_new_session=True, **kwargs)
    if wait_s <= 0:
        return None
    try:
        return proc.wait(timeout=wait_s)
    except subprocess.TimeoutExpired:
        return None


# ── Linux desktop session discovery ─────────────────────────────────────────


def _socket_exists(path: str) -> bool:
    try:
        return stat.S_ISSOCK(os.stat(path).st_mode)
    except OSError:
        return False


def _logind_graphical_session(uid: int) -> dict[str, str] | None:
    loginctl = shutil.which("loginctl")
    if not loginctl:
        return None
    try:
        listing = subprocess.run(
            [loginctl, "list-sessions", "--no-legend"],
            capture_output=True,
            text=True,
            timeout=3,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in listing.splitlines():
        parts = line.split()
        if len(parts) < 2 or parts[1] != str(uid):
            continue
        try:
            shown = subprocess.run(
                [loginctl, "show-session", parts[0], "-p", "Type", "-p", "Display",
                 "-p", "Remote", "-p", "State"],
                capture_output=True,
                text=True,
                timeout=3,
            ).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        props = dict(
            item.split("=", 1) for item in shown.splitlines() if "=" in item
        )
        if (
            props.get("Type") in ("x11", "wayland", "mir")
            and props.get("Remote") != "yes"
            and props.get("State") in ("active", "online")
        ):
            return props
    return None


def _user_x_display(uid: int) -> str:
    x11_dir = "/tmp/.X11-unix"
    try:
        names = sorted(os.listdir(x11_dir))
    except OSError:
        return ""
    for name in names:
        path = os.path.join(x11_dir, name)
        if name.startswith("X") and name[1:].isdigit():
            try:
                if os.stat(path).st_uid == uid:
                    return f":{name[1:]}"
            except OSError:
                continue
    return ""


def linux_gui_env() -> dict[str, str]:
    """Environment that reaches the user's desktop, even when started over SSH."""
    env = dict(os.environ)
    if env.get("DISPLAY") or env.get("WAYLAND_DISPLAY"):
        return env

    uid = os.getuid()
    runtime = env.get("XDG_RUNTIME_DIR") or f"/run/user/{uid}"
    session = _logind_graphical_session(uid)

    wayland = ""
    if os.path.isdir(runtime):
        for name in sorted(os.listdir(runtime)):
            if name.startswith("wayland-") and _socket_exists(os.path.join(runtime, name)):
                wayland = name
                break
    display = (session or {}).get("Display", "") or _user_x_display(uid)

    if session is None and not wayland and not display:
        raise LaunchError(NO_DESKTOP)
    if wayland:
        env["WAYLAND_DISPLAY"] = wayland
    if display:
        env["DISPLAY"] = display
    if not (env.get("DISPLAY") or env.get("WAYLAND_DISPLAY")):
        raise LaunchError(NO_DESKTOP)

    env.setdefault("XDG_RUNTIME_DIR", runtime)
    bus = os.path.join(runtime, "bus")
    if _socket_exists(bus):
        env.setdefault("DBUS_SESSION_BUS_ADDRESS", f"unix:path={bus}")
    for xauth in (os.path.join(runtime, "gdm", "Xauthority"), str(Path.home() / ".Xauthority")):
        if os.path.isfile(xauth):
            env.setdefault("XAUTHORITY", xauth)
            break
    return env


# ── Windows helpers ─────────────────────────────────────────────────────────


def split_windows_command(command: str) -> list[str]:
    """Split a registry command template such as `"C:\\x\\chrome.exe" --single-argument %1`."""
    args: list[str] = []
    buf: list[str] = []
    quoted = False
    for ch in command:
        if ch == '"':
            quoted = not quoted
            continue
        if ch.isspace() and not quoted:
            if buf:
                args.append("".join(buf))
                buf = []
            continue
        buf.append(ch)
    if buf:
        args.append("".join(buf))
    return [os.path.expandvars(a) for a in args]


def fill_command_template(argv: list[str], url: str) -> list[str]:
    placeholders = ("%1", "%l", "%L")
    if any(p in a for a in argv for p in placeholders):
        filled = []
        for arg in argv:
            for p in placeholders:
                arg = arg.replace(p, url)
            filled.append(arg)
    else:
        filled = [*argv, url]
    return [a for a in filled if a not in ("%*", "%U", "%u")]


def _windows_default_browser_argv(url: str) -> list[str] | None:
    import winreg

    prog_id = ""
    for scheme in ("https", "http"):
        try:
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                rf"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\{scheme}\UserChoice",
            ) as key:
                prog_id = winreg.QueryValueEx(key, "ProgId")[0]
                break
        except OSError:
            continue
    if not prog_id:
        return None
    try:
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, rf"{prog_id}\shell\open\command") as key:
            template = winreg.QueryValueEx(key, "")[0]
    except OSError:
        return None
    argv = split_windows_command(template)
    if not argv or not os.path.isfile(argv[0]):
        return None
    return fill_command_template(argv, url)


def _windows_browser_exe(spec: BrowserSpec) -> str | None:
    import winreg

    if spec.windows_exe:
        for root in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            try:
                with winreg.OpenKey(
                    root, rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{spec.windows_exe}"
                ) as key:
                    path = os.path.expandvars(winreg.QueryValueEx(key, "")[0].strip('"'))
                    if os.path.isfile(path):
                        return path
            except OSError:
                continue
    for candidate in spec.windows_paths:
        path = os.path.expandvars(candidate)
        if os.path.isfile(path):
            return path
    return shutil.which(spec.windows_exe) if spec.windows_exe else None


def _windows_shell_open(target: str) -> None:
    try:
        os.startfile(target)  # type: ignore[attr-defined]
    except OSError as exc:
        raise LaunchError(f"Windows has no app set up to open that ({exc.strerror or exc}).") from exc


# ── macOS helpers ───────────────────────────────────────────────────────────


def _mac_open(args: list[str]) -> None:
    try:
        result = subprocess.run(["open", *args], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError) as exc:
        raise LaunchError(f"macOS couldn't open it ({exc}).") from exc
    if result.returncode != 0:
        detail = result.stderr.strip() or f"exit code {result.returncode}"
        raise LaunchError(f"macOS couldn't open it ({detail}).")


# ── Public API ──────────────────────────────────────────────────────────────


def _open_in_browser(url: str, name: str) -> Launched | None:
    spec = BROWSERS.get(name)
    if spec is None:
        return None
    if IS_WINDOWS:
        exe = _windows_browser_exe(spec)
        if not exe:
            return None
        _spawn([exe, url])
        return Launched(url, spec.label)
    if IS_MAC:
        if not spec.mac_app:
            return None
        try:
            _mac_open(["-a", spec.mac_app, url])
        except LaunchError:
            return None
        return Launched(url, spec.label)
    env = linux_gui_env()
    for command in spec.linux:
        exe = shutil.which(command)
        if exe:
            _spawn([exe, url], env)
            return Launched(url, spec.label)
    return None


def _linux_open(target: str, *, web: bool) -> Launched:
    env = linux_gui_env()
    for argv in (["xdg-open"], ["gio", "open"]):
        exe = shutil.which(argv[0])
        if not exe:
            continue
        code = _spawn([exe, *argv[1:], target], env, wait_s=3.0)
        if code in (0, None):
            return Launched(target, argv[0])
    if web:
        for command in _LINUX_FALLBACK_BROWSERS:
            exe = shutil.which(command)
            if exe:
                _spawn([exe, target], env)
                return Launched(target, command)
    raise LaunchError("No browser or link handler was found on this Linux desktop (install xdg-utils).")


def open_url(url: str, *, browser: str = "default", dry_run: bool = False) -> Launched:
    """Open an http(s) link in a browser or a mailto: link in the mail app."""
    scheme = urlsplit(url).scheme.lower()
    if scheme not in ("http", "https", "mailto"):
        raise LaunchError("I can only open web links and email drafts.")
    if dry_run:
        return Launched(url, "dry-run", dry_run=True)

    web = scheme in ("http", "https")
    if web and browser not in ("", "default"):
        launched = _open_in_browser(url, browser)
        if launched:
            return launched

    if IS_WINDOWS:
        if web:
            argv = _windows_default_browser_argv(url)
            if argv:
                _spawn(argv)
                return Launched(url, Path(argv[0]).stem)
        _windows_shell_open(url)
        return Launched(url, "windows-shell")
    if IS_MAC:
        _mac_open([url])
        return Launched(url, "open")
    return _linux_open(url, web=web)


def open_app(key: str, *, dry_run: bool = False) -> Launched:
    """Open one of the allow-listed desktop apps in APPS."""
    spec = APPS.get(key)
    if spec is None:
        raise LaunchError(f"I can only open these apps: {', '.join(APPS)}.")
    if dry_run:
        return Launched(spec.label, "dry-run", dry_run=True)

    if IS_WINDOWS:
        if spec.windows_uri:
            _windows_shell_open(spec.windows_uri)
            return Launched(spec.label, "windows-shell")
        for argv in spec.windows:
            exe = shutil.which(argv[0])
            if exe:
                _spawn([exe, *argv[1:]], console=spec.windows_console)
                return Launched(spec.label, argv[0])
        raise LaunchError(f"I couldn't find {spec.label} on this PC.")

    if IS_MAC:
        if key == "file_manager":
            _mac_open([str(Path.home())])
            return Launched(spec.label, "open")
        last_error: LaunchError | None = None
        for app in spec.mac:
            try:
                _mac_open(["-a", app])
                return Launched(spec.label, app)
            except LaunchError as exc:
                last_error = exc
        raise last_error or LaunchError(f"I couldn't find {spec.label} on this Mac.")

    env = linux_gui_env()
    for argv in spec.linux:
        exe = shutil.which(argv[0])
        if exe:
            _spawn([exe, *argv[1:]], env)
            return Launched(spec.label, argv[0])
    if key == "file_manager":
        return _linux_open(str(Path.home()), web=False)
    raise LaunchError(f"I couldn't find {spec.label} on this Linux desktop.")


def desktop_status() -> dict[str, object]:
    """Whether this machine can show windows right now (for /health)."""
    status: dict[str, object] = {"os": platform_label(), "can_open": True, "detail": ""}
    if not IS_WINDOWS and not IS_MAC:
        try:
            env = linux_gui_env()
            status["detail"] = " ".join(
                f"{k}={env[k]}" for k in ("WAYLAND_DISPLAY", "DISPLAY") if env.get(k)
            )
        except LaunchError as exc:
            status["can_open"] = False
            status["detail"] = str(exc)
    return status
