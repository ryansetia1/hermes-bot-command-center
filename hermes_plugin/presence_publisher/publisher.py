"""Publish Hermes lifecycle hooks to the local presence collector.

Configuration: PRESENCE_COLLECTOR_URL (default http://127.0.0.1:8787/observe).
Identity sent with every event (presence.v1), defaults derived from the active profile
(basename of HERMES_HOME, else the profile root this plugin is installed under):
  PRESENCE_HOST_ID     default: default
  PRESENCE_ROOM_ID     default: dynamically resolved (fallback: direct)
  PRESENCE_ROOM_NAME   default: dynamically resolved
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
import sqlite3
from threading import Thread
from typing import Any
from urllib.request import Request, urlopen

_ENDPOINT = os.getenv("PRESENCE_COLLECTOR_URL", "http://127.0.0.1:8787/observe")
_QUEUE: Queue[dict] = Queue(maxsize=128)
_CURRENT_ROOM_ID: str = "direct"
_CURRENT_ROOM_NAME: str = "Direct"
_CURRENT_PROFILE: str | None = None

# Scoped turn context to prevent cross-bot / cross-turn context leakage
_TURN_CONTEXT: dict[Any, dict[str, str]] = {}
_ROOM_DIRECTORY_CACHE: dict[str, str] = {}


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


def _lookup_room_manifest() -> dict[str, str]:
    """Dynamically scan profile.yaml files to find room_id -> name mapping."""
    candidates: list[Path] = []
    hermes_home = os.getenv("HERMES_HOME")
    if hermes_home:
        candidates.append(Path(hermes_home) / "profile.yaml")
    candidates.append(Path.home() / ".hermes" / "profile.yaml")

    profiles_dir = Path.home() / ".hermes" / "profiles"
    if profiles_dir.is_dir():
        try:
            for p in profiles_dir.iterdir():
                if p.is_dir():
                    candidates.append(p / "profile.yaml")
        except Exception:
            pass

    manifest: dict[str, str] = dict(_ROOM_DIRECTORY_CACHE)
    for c in candidates:
        try:
            if not c.is_file():
                continue
            text = c.read_text(encoding="utf-8")
            data = None
            try:
                import yaml
                data = yaml.safe_load(text)
            except Exception:
                pass
            if not isinstance(data, dict):
                try:
                    data = json.loads(text)
                except Exception:
                    data = {}

            rooms = (data or {}).get("ui_meta", {}).get("hermes-bots-groups", {}).get("rooms", {})
            for k, v in rooms.items():
                if isinstance(v, dict):
                    rid = v.get("roomId") or v.get("id") or str(k).replace("id:", "")
                    name = v.get("name")
                    if rid and name:
                        manifest[str(rid)] = str(name)
                        manifest[str(name).lower()] = str(rid)
        except Exception:
            pass
    return manifest


def _lookup_room_name(room_id: str) -> str | None:
    if not room_id or room_id == "direct":
        return "Direct"
    if room_id in _ROOM_DIRECTORY_CACHE:
        return _ROOM_DIRECTORY_CACHE[room_id]
    manifest = _lookup_room_manifest()
    if room_id in manifest:
        _ROOM_DIRECTORY_CACHE[room_id] = manifest[room_id]
        return manifest[room_id]
    dir_name = _lookup_channel_directory(room_id)
    if dir_name:
        _ROOM_DIRECTORY_CACHE[room_id] = dir_name
        return dir_name
    return None


def _lookup_session_room(session_id: str, profile: str | None = None) -> tuple[str | None, str | None]:
    if not session_id:
        return None, None
    candidates: list[Path] = []
    hermes_home = os.getenv("HERMES_HOME")
    if hermes_home:
        candidates.append(Path(hermes_home) / "state.db")
    if profile:
        candidates.append(Path.home() / ".hermes" / "profiles" / profile / "state.db")
    candidates.append(Path.home() / ".hermes" / "state.db")

    profiles_dir = Path.home() / ".hermes" / "profiles"
    if profiles_dir.is_dir():
        try:
            for p in profiles_dir.iterdir():
                if p.is_dir():
                    candidates.append(p / "state.db")
        except Exception:
            pass

    for db_path in candidates:
        try:
            if not db_path.is_file():
                continue
            con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            cur = con.cursor()
            cur.execute("SELECT title FROM sessions WHERE id = ? LIMIT 1", (session_id,))
            row = cur.fetchone()
            con.close()
            if row and row[0]:
                title = str(row[0])
                m = re.match(r"^Group:\s*([a-zA-Z0-9_\-]+)", title)
                if m:
                    rid = m.group(1).strip()
                    rname = _lookup_room_name(rid)
                    return rid, rname
        except Exception:
            pass
    return None, None


def _extract_group_prompt_room_name(user_message: Any) -> str | None:
    if not user_message:
        return None
    try:
        if isinstance(user_message, list):
            text = " ".join(str(item) for item in user_message)
        elif isinstance(user_message, dict):
            text = json.dumps(user_message)
        else:
            text = str(user_message)
        m = re.search(r'\[Group chat:\s*"([^"]+)"\]', text)
        if m:
            return m.group(1).strip()
    except Exception:
        pass
    return None


def resolve_room_info(**kwargs) -> tuple[str, str]:
    # 1. Explicit PRESENCE_ROOM_ID environment variable override
    env_room = os.getenv("PRESENCE_ROOM_ID")
    env_name = os.getenv("PRESENCE_ROOM_NAME")
    if env_room:
        return env_room, env_name or env_room

    # 2. Check scoped turn context by session_id, turn_id, or (profile, turn_id)
    session_id = _clean_str(kwargs.get("session_id"))
    turn_id = _clean_str(kwargs.get("turn_id"))
    profile = _clean_str(kwargs.get("profile")) or _clean_str(_CURRENT_PROFILE)

    if session_id and session_id in _TURN_CONTEXT:
        ctx = _TURN_CONTEXT[session_id]
        return ctx["roomId"], ctx.get("roomName") or ctx["roomId"]

    if turn_id and (profile, turn_id) in _TURN_CONTEXT:
        ctx = _TURN_CONTEXT[(profile, turn_id)]
        return ctx["roomId"], ctx.get("roomName") or ctx["roomId"]

    if turn_id and turn_id in _TURN_CONTEXT:
        ctx = _TURN_CONTEXT[turn_id]
        return ctx["roomId"], ctx.get("roomName") or ctx["roomId"]

    # 3. Explicit roomId / room_id keyword arguments
    explicit_room = kwargs.get("roomId") or kwargs.get("room_id")
    if explicit_room:
        rid = sanitize_room_id(str(explicit_room)) if str(explicit_room).startswith("#") else str(explicit_room).strip()
        rname = kwargs.get("roomName") or kwargs.get("room_name") or _lookup_room_name(rid) or rid
        return rid, rname

    # 4. Check user_message prompt header ([Group chat: "<roomName>"])
    user_msg_room_name = _extract_group_prompt_room_name(kwargs.get("user_message"))

    # 5. Check session_id in state.db
    if session_id:
        sess_rid, sess_rname = _lookup_session_room(session_id, profile)
        if sess_rid:
            effective_name = user_msg_room_name or sess_rname or _lookup_room_name(sess_rid) or sess_rid
            _ROOM_DIRECTORY_CACHE[sess_rid] = effective_name
            _ROOM_DIRECTORY_CACHE[effective_name.lower()] = sess_rid
            return sess_rid, effective_name

    # 6. If user_message had roomName, lookup or derive roomId
    if user_msg_room_name:
        manifest = _lookup_room_manifest()
        matched_id = manifest.get(user_msg_room_name.lower())
        rid = matched_id or sanitize_room_id(user_msg_room_name)
        _ROOM_DIRECTORY_CACHE[rid] = user_msg_room_name
        return rid, user_msg_room_name

    # 7. Inbound event / SessionSource (e.g. gateway platforms)
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
            return "direct", "Direct"

        chat_name = getattr(source, "chat_name", None)
        if chat_name is None and isinstance(source, dict):
            chat_name = source.get("chat_name")

        if chat_name:
            rid = sanitize_room_id(chat_name)
            return rid, str(chat_name).strip()

        chat_id = getattr(source, "chat_id", None)
        if chat_id is None and isinstance(source, dict):
            chat_id = source.get("chat_id")

        if chat_id:
            dir_name = _lookup_channel_directory(str(chat_id))
            if dir_name:
                if dir_name == "direct":
                    return "direct", "Direct"
                return sanitize_room_id(dir_name), dir_name

        parent_chat_id = getattr(source, "parent_chat_id", None)
        if parent_chat_id is None and isinstance(source, dict):
            parent_chat_id = source.get("parent_chat_id")

        if parent_chat_id:
            dir_name = _lookup_channel_directory(str(parent_chat_id))
            if dir_name:
                if dir_name == "direct":
                    return "direct", "Direct"
                return sanitize_room_id(dir_name), dir_name

        if chat_id:
            return sanitize_room_id(str(chat_id)), str(chat_id)

    # 8. Fallback to current global if set and not direct
    if _CURRENT_ROOM_ID and _CURRENT_ROOM_ID != "direct":
        return _CURRENT_ROOM_ID, _CURRENT_ROOM_NAME or _CURRENT_ROOM_ID

    return "direct", "Direct"


def resolve_room_id(**kwargs) -> str:
    room_id, _ = resolve_room_info(**kwargs)
    return room_id


def get_current_room_id() -> str:
    return os.getenv("PRESENCE_ROOM_ID") or _CURRENT_ROOM_ID


def get_current_room_name() -> str:
    return os.getenv("PRESENCE_ROOM_NAME") or _CURRENT_ROOM_NAME


def set_current_room_id(room_id: str, room_name: str | None = None) -> None:
    global _CURRENT_ROOM_ID, _CURRENT_ROOM_NAME
    _CURRENT_ROOM_ID = room_id
    _CURRENT_ROOM_NAME = room_name or (room_id if room_id != "direct" else "Direct")


def reset_room_id() -> None:
    global _CURRENT_ROOM_ID, _CURRENT_ROOM_NAME
    _CURRENT_ROOM_ID = "direct"
    _CURRENT_ROOM_NAME = "Direct"
    _TURN_CONTEXT.clear()


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
    prof = _clean_str(kwargs.get("profile")) or _clean_str(kwargs.get("member_id"))
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
    effective_room, effective_room_name = resolve_room_info(room_id=room_id, **kwargs)
    return {
        "hostId": os.getenv("PRESENCE_HOST_ID") or "default",
        "roomId": effective_room,
        "roomName": effective_room_name,
        "botId": os.getenv("PRESENCE_BOT_ID") or profile,
        "pet": {
            "slug": slug,
            "version": os.getenv("PRESENCE_PET_VERSION") or "1.0.0",
            "url": os.getenv("PRESENCE_PET_URL") or f"/pets/{slug}-v1.png",
        },
    }


def event_for_hook(hook_name: str, **kwargs):
    if hook_name == "on_room_member_activity":
        kind = str(kwargs.get("kind") or "").lower()
        if kind.startswith("tool.start"):
            return ("tool", "started")
        if kind.startswith("tool.complete"):
            return ("tool", "completed")
        if kind in ("turn.error", "error", "tool.failed"):
            return ("tool", "failed")
        if any(kind.startswith(p) for p in ("message.delta", "message.interim", "reasoning.delta")):
            return ("llm", "speaking")
        if kind.startswith("request.opened"):
            return ("tool", "started")
        return ("tool", "started")

    mapping = {
        "pre_gateway_dispatch": ("gateway", "received"),
        "pre_llm_call": ("llm", "started"),
        "post_llm_call": ("llm", "completed"),
        "pre_tool_call": ("tool", "started"),
    }
    if hook_name == "post_tool_call":
        failed = kwargs.get("error") or str(kwargs.get("status", "")).lower() in {"error", "failed", "failure"}
        return ("tool", "failed" if failed else "completed")
    return mapping.get(hook_name, ("tool", "started"))


def _activity(hook_name: str, kwargs: dict) -> str | None:
    if hook_name == "on_room_member_activity":
        kind = str(kwargs.get("kind") or "").lower()
        payload = kwargs.get("payload") or {}
        if isinstance(payload, dict):
            tool_name = payload.get("tool") or payload.get("tool_name") or kwargs.get("tool_name")
        else:
            tool_name = kwargs.get("tool_name")
        if kind.startswith("tool.start"):
            return f"Running {tool_name}" if tool_name else "Running tool"
        if kind.startswith("tool.complete"):
            return f"Finished {tool_name}" if tool_name else "Finished tool"
        if any(kind.startswith(p) for p in ("message.delta", "message.interim")):
            return "Responding in room"
        if kind.startswith("reasoning.delta"):
            return "Reasoning"
        if kind in ("turn.error", "error"):
            return "Room turn error"
        return "Active in room"
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
        if hook_name == "on_room_member_activity":
            member_id = _clean_str(kwargs.get("member_id"))
            if member_id:
                kwargs["profile"] = member_id
                set_current_profile(member_id)

        resolved_room, resolved_name = resolve_room_info(**kwargs)

        session_id = _clean_str(kwargs.get("session_id"))
        turn_id = _clean_str(kwargs.get("turn_id"))
        profile = _clean_str(kwargs.get("profile")) or _clean_str(_CURRENT_PROFILE)

        if resolved_room != "direct":
            ctx_payload = {"roomId": resolved_room, "roomName": resolved_name}
            if session_id:
                _TURN_CONTEXT[session_id] = ctx_payload
            if turn_id:
                _TURN_CONTEXT[turn_id] = ctx_payload
                if profile:
                    _TURN_CONTEXT[(profile, turn_id)] = ctx_payload
            set_current_room_id(resolved_room, resolved_name)
        elif hook_name == "pre_gateway_dispatch":
            set_current_room_id("direct", "Direct")

        prof = _extract_profile(**kwargs)
        if prof:
            set_current_profile(prof)
        elif hook_name == "pre_gateway_dispatch":
            set_current_profile(None)

        _enqueue(hook_name, **kwargs)

        # Scoped cleanup when turn finishes to prevent leaks
        if hook_name in ("post_llm_call", "turn.settled"):
            if session_id:
                _TURN_CONTEXT.pop(session_id, None)
            if turn_id:
                _TURN_CONTEXT.pop(turn_id, None)
                if profile:
                    _TURN_CONTEXT.pop((profile, turn_id), None)
            reset_room_id()
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
    for hook_name in (
        "pre_gateway_dispatch",
        "pre_llm_call",
        "post_llm_call",
        "pre_tool_call",
        "post_tool_call",
        "on_room_member_activity",
    ):
        ctx.register_hook(hook_name, lambda _hook_name=hook_name, **kwargs: publish(_hook_name, **kwargs))


Thread(target=_send_loop, name="presence-publisher", daemon=True).start()
