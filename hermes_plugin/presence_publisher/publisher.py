"""Publish Hermes lifecycle hooks to the local presence collector.

Configuration: PRESENCE_COLLECTOR_URL (default http://127.0.0.1:8787/observe).
Identity sent with every event (presence.v1), defaults derived from the active profile
(basename of HERMES_HOME, else the profile root this plugin is installed under):
  PRESENCE_HOST_ID     default: default
  PRESENCE_ROOM_ID     default: dynamically resolved (fallback: direct)
  PRESENCE_BOT_ID      default: <profile>
  PRESENCE_PET_SLUG    default: <profile>
  PRESENCE_PET_VERSION default: 1.0.0
  PRESENCE_PET_URL     default: /pets/<pet slug>-v1.png
The publisher is observer-only and fail-open: a stopped dashboard cannot interrupt Hermes.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
from queue import Full, Queue
import re
from threading import Thread
from typing import Any
from urllib.request import Request, urlopen

_ENDPOINT = os.getenv("PRESENCE_COLLECTOR_URL", "http://127.0.0.1:8787/observe")
_QUEUE: Queue[dict] = Queue(maxsize=128)
_CURRENT_ROOM_ID: str = "direct"
_CURRENT_PROFILE: str | None = None


def sanitize_room_id(raw_name: str) -> str:
    if not raw_name:
        return "direct"
    name = str(raw_name).strip()
    if "/" in name:
        parts = [p.strip() for p in name.split("/") if p.strip()]
        candidate = next((p for p in parts if p.startswith("#")), None)
        name = candidate or (parts[-1] if parts else name)
    name = name.lstrip("#").lower().strip()
    name = re.sub(r"[^\w\-]+", "-", name)
    name = re.sub(r"[-_]+", "-", name).strip("-")
    return name or "direct"


def _find_channel_directory_path() -> Path | None:
    candidates: list[Path] = []
    hermes_home = os.getenv("HERMES_HOME")
    if hermes_home:
        candidates.append(Path(hermes_home) / "channel_directory.json")
    candidates.append(Path.home() / ".hermes" / "channel_directory.json")
    for candidate in candidates:
        try:
            if candidate.is_file():
                return candidate
        except Exception:
            pass
    return None


def _lookup_channel_directory(chat_id: str) -> str | None:
    if not chat_id:
        return None
    path = _find_channel_directory_path()
    if not path:
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        platforms = data.get("platforms", {})
        target = str(chat_id).strip()
        target_base = target.split(":")[0]
        for _, entries in platforms.items():
            if isinstance(entries, list):
                for entry in entries:
                    if not isinstance(entry, dict):
                        continue
                    entry_id = str(entry.get("id", "")).strip()
                    entry_base = entry_id.split(":")[0]
                    if entry_id == target or (entry_base and entry_base == target_base):
                        if entry.get("type") == "dm":
                            return "direct"
                        return entry.get("name")
    except Exception:
        pass
    return None


def resolve_room_id(**kwargs) -> str:
    # 1. Explicit PRESENCE_ROOM_ID environment variable override
    env_override = os.getenv("PRESENCE_ROOM_ID")
    if env_override:
        return env_override

    # 2. Explicit roomId / room_id keyword arguments
    explicit_room = kwargs.get("roomId") or kwargs.get("room_id")
    if explicit_room:
        return sanitize_room_id(str(explicit_room))

    # 3. Inbound event / SessionSource
    event = kwargs.get("event")
    source: Any = kwargs.get("source")
    if source is None and event is not None:
        source = getattr(event, "source", None)
        if source is None and isinstance(event, dict):
            source = event.get("source")

    if source is not None:
        chat_type = getattr(source, "chat_type", None)
        if chat_type is None and isinstance(source, dict):
            chat_type = source.get("chat_type")

        chat_type_str = str(chat_type).lower().strip() if chat_type else ""
        if chat_type_str in ("dm", "direct", "private"):
            return "direct"

        # Check explicit channel / group chat name
        chat_name = getattr(source, "chat_name", None)
        if chat_name is None and isinstance(source, dict):
            chat_name = source.get("chat_name")

        if chat_name:
            return sanitize_room_id(chat_name)

        # Check chat_id against channel directory
        chat_id = getattr(source, "chat_id", None)
        if chat_id is None and isinstance(source, dict):
            chat_id = source.get("chat_id")

        if chat_id:
            dir_name = _lookup_channel_directory(str(chat_id))
            if dir_name:
                return sanitize_room_id(dir_name)

        parent_chat_id = getattr(source, "parent_chat_id", None)
        if parent_chat_id is None and isinstance(source, dict):
            parent_chat_id = source.get("parent_chat_id")

        if parent_chat_id:
            dir_name = _lookup_channel_directory(str(parent_chat_id))
            if dir_name:
                return sanitize_room_id(dir_name)

        if chat_id:
            return sanitize_room_id(str(chat_id))

    return "direct"


def get_current_room_id() -> str:
    return os.getenv("PRESENCE_ROOM_ID") or _CURRENT_ROOM_ID


def set_current_room_id(room_id: str) -> None:
    global _CURRENT_ROOM_ID
    _CURRENT_ROOM_ID = room_id


def reset_room_id() -> None:
    global _CURRENT_ROOM_ID
    _CURRENT_ROOM_ID = "direct"


def get_current_profile() -> str | None:
    return _CURRENT_PROFILE


def set_current_profile(profile: str | None) -> None:
    global _CURRENT_PROFILE
    _CURRENT_PROFILE = profile


def reset_profile() -> None:
    global _CURRENT_PROFILE
    _CURRENT_PROFILE = None


def _clean_str(val: Any) -> str | None:
    if val is None:
        return None
    # Filter out auto-generated mock attributes in test environments
    if hasattr(val, "_mock_return_value") or hasattr(val, "_mock_name") or "Mock" in type(val).__name__:
        return None
    s = str(val).strip()
    return s if s else None


def _extract_profile(**kwargs) -> str | None:
    prof = _clean_str(kwargs.get("profile"))
    if prof:
        return prof
    event = kwargs.get("event")
    source = kwargs.get("source")
    if source is None and event is not None:
        source = getattr(event, "source", None)
        if source is None and isinstance(event, dict):
            source = event.get("source")
    if source is not None:
        sp = _clean_str(getattr(source, "profile", None))
        if sp is None and isinstance(source, dict):
            sp = _clean_str(source.get("profile"))
        if sp:
            return sp
    if event is not None:
        ep = _clean_str(getattr(event, "profile", None))
        if ep is None and isinstance(event, dict):
            ep = _clean_str(event.get("profile"))
        if ep:
            return ep
    return None


def _profile(profile: str | None = None, **kwargs) -> str:
    # 1. First check kwargs/context profile if provided.
    prof = _clean_str(profile) or _clean_str(kwargs.get("profile")) or _extract_profile(**kwargs) or _clean_str(_CURRENT_PROFILE)
    if prof:
        return prof

    # 2. Check hermes_constants.get_hermes_home():
    try:
        from hermes_constants import get_hermes_home
        h = Path(get_hermes_home())
        if h.name and h.name != ".hermes":
            return h.name
    except Exception:
        pass

    # 3. Check env vars (HERMES_PROFILE_NAME, HERMES_PROFILE).
    for var in ("HERMES_PROFILE_NAME", "HERMES_PROFILE"):
        val = (os.getenv(var) or "").strip()
        if val:
            return val

    # 4. Check HERMES_HOME env var.
    raw_home = os.getenv("HERMES_HOME")
    if raw_home:
        home = Path(raw_home)
        return "default" if home.name == ".hermes" else home.name

    # 5. Installed at $HERMES_HOME/plugins/presence_publisher/publisher.py.
    home = Path(__file__).resolve().parents[2]
    return "default" if home.name == ".hermes" else home.name


def identity(room_id: str | None = None, **kwargs) -> dict:
    profile = _clean_str(kwargs.get("profile")) or _clean_str(_CURRENT_PROFILE) or _profile(**kwargs)
    slug = os.getenv("PRESENCE_PET_SLUG") or profile
    effective_room = os.getenv("PRESENCE_ROOM_ID") or room_id or get_current_room_id()
    return {
        "hostId": os.getenv("PRESENCE_HOST_ID") or "default",
        "roomId": effective_room,
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
        if kwargs.get("event") is not None or kwargs.get("source") is not None or kwargs.get("roomId") or kwargs.get("room_id") or hook_name == "pre_gateway_dispatch":
            resolved = resolve_room_id(**kwargs)
            set_current_room_id(resolved)

        prof = _extract_profile(**kwargs)
        if prof:
            set_current_profile(prof)
        elif hook_name == "pre_gateway_dispatch":
            set_current_profile(None)

        _enqueue(hook_name, **kwargs)
    except Exception:
        pass  # observer-only: never break the hook caller


def _enqueue(hook_name: str, **kwargs) -> None:
    source, event_type = event_for_hook(hook_name, **kwargs)
    event = {
        **identity(**kwargs),
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
