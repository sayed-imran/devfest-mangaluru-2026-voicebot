import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["TOOLS_DRY_RUN"] = "1"
os.environ["TOOLS_MAIL_CLIENT"] = "gmail"
os.environ["TOOLS_BROWSER"] = "default"

from gemma_tools.config import get_desktop_settings, get_settings  # noqa: E402

get_settings.cache_clear()
get_desktop_settings.cache_clear()
