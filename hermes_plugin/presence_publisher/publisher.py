"""Publish Hermes lifecycle hooks to the local presence collector.

Configuration: PRESENCE_COLLECTOR_URL (default http://127.0.0.1:8787/observe).
Identity sent with every event (presence.v1), defaults derived from the active profile
(basename of HERMES_HOME, else the profile root this plugin is installed under):
  PRESENCE_HOST_ID   default: this machine's hostname
  PRESENCE_ROOM_ID   default: build-room
  PRESENCE_BOT_ID    default: <profile>
  PRESENCE_PET_SLUG  default: <profile>
  PRESENCE_PET_VERSION default: 1.0.0
  PRESENCE_PET_URL   default: /pets/<pet slug>-v1.png
The publisher is observer-only and fail-open: a stopped dashboard cannot interrupt Hermes.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import socket
from queue import Full, Queue
from threading import Thread
from urllib.request import Request, urlopen

_ENDPOINT = os.getenv("PRESENCE_COLLECTOR_URL", "http://127.0.0.1:8787/observe")
_QUEUE: Queue[dict] = Queue(maxsize=128)


def _profile() -> str:
    # Installed at $HERMES_HOME/plugins/presence_publisher/publisher.py.
    home = Path(os.getenv("HERMES_HOME") or Path(__file__).resolve().parents[2])
    return "default" if home.name == ".hermes" else home.name


def identity() -> dict:
    profile = _profile()
    slug = os.getenv("PRESENCE_PET_SLUG") or profile
    return {
        "hostId": os.getenv("PRESENCE_HOST_ID") or socket.gethostname().split(".")[0],
        "roomId": os.getenv("PRESENCE_ROOM_ID") or "build-room",
        "botId": os.getenv("PRESENCE_BOT_ID") or profile,
        "pet": {
            "slug": slug,
            "version": os.getenv("PRESENCE_PET_VERSION") or "1.0.0",
            "url": os.getenv("PRESENCE_PET_URL") or f"/pets/{slug}-v1.png",
        },
    }


def event_for_hook(hook_name: str, **kwargs):
    mapping = {
        "pre_gateway_dispatch": ("gateway", "received"),
        "pre_llm_call": ("llm", "started"),
        "post_llm_call": ("llm", "completed"),
        "pre_tool_call": ("tool", "started"),
    }
    if hook_name == "post_tool_call":
        failed = kwargs.get("error") or str(kwargs.get("status", "")).lower() in {"error", "failed", "failure"}
        return ("tool", "failed" if failed else "completed")
    return mapping[hook_name]


def _activity(hook_name: str, kwargs: dict) -> str | None:
    if hook_name in {"pre_tool_call", "post_tool_call"}:
        tool_name = kwargs.get("tool_name", "tool")
        return f"Running {tool_name}" if hook_name == "pre_tool_call" else f"Finished {tool_name}"
    if hook_name == "pre_gateway_dispatch":
        return "Received a gateway message"
    if hook_name == "pre_llm_call":
        return "Processing a request"
    if hook_name == "post_llm_call":
        return "Completed response"
    return None


def _send_loop() -> None:
    while True:
        event = _QUEUE.get()
        try:
            body = json.dumps(event).encode("utf-8")
            request = Request(_ENDPOINT, data=body, headers={"content-type": "application/json"}, method="POST")
            with urlopen(request, timeout=0.5):
                pass
        except Exception:
            # Presence is telemetry, not a dependency of the agent turn.
            pass
        finally:
            _QUEUE.task_done()


def publish(hook_name: str, **kwargs) -> None:
    try:
        _enqueue(hook_name, **kwargs)
    except Exception:
        pass  # observer-only: never break the hook caller


def _enqueue(hook_name: str, **kwargs) -> None:
    source, event_type = event_for_hook(hook_name, **kwargs)
    event = {
        **identity(),
        "source": source,
        "type": event_type,
        "at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    activity = _activity(hook_name, kwargs)
    if activity:
        event["activity"] = activity
    try:
        _QUEUE.put_nowait(event)
    except Full:
        pass


def register(ctx) -> None:
    for hook_name in ("pre_gateway_dispatch", "pre_llm_call", "post_llm_call", "pre_tool_call", "post_tool_call"):
        ctx.register_hook(hook_name, lambda _hook_name=hook_name, **kwargs: publish(_hook_name, **kwargs))


Thread(target=_send_loop, name="presence-publisher", daemon=True).start()
