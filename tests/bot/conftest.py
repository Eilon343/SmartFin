import sys
import os
from unittest.mock import MagicMock

# Add bot/ directory to path so `from app.xxx import yyy` works
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'bot'))

# apscheduler is only installed inside Docker — mock it for local test runs
for _mod in [
    'apscheduler',
    'apscheduler.schedulers',
    'apscheduler.schedulers.asyncio',
    'apscheduler.triggers',
    'apscheduler.triggers.cron',
]:
    sys.modules.setdefault(_mod, MagicMock())
