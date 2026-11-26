"""VHS-Security — карта объекта, камеры и события VHS.

Отдельный сервис поверх VHS-Streamer (видео/ONVIF) и VHS-Viewer (ALPR/YOLO).
Не изменяет их конфигурацию и не хранит видео: только пространственную
привязку камер и журнал событий.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import socket
import concurrent.futures
import json
import os
import re
import secrets
import sqlite3
import sys
import time
import uuid
from functools import wraps
from pathlib import Path
from urllib.parse import quote, urlparse

import requests
from flask import (
    Flask,
    abort,
    g,
    jsonify,
    redirect,
    render_template,
    request,
    send_from_directory,
    session,
    url_for,
)
from werkzeug.utils import secure_filename
from werkzeug.security import check_password_hash, generate_password_hash

import notifications
import vhs_sso
from __version__ import APP_FOOTER, APP_NAME, __author__, __copyright__, __license__, __url__, __version__

BASE_DIR = (
    Path(sys.executable).resolve().parent
    if getattr(sys, "frozen", False)
    else Path(__file__).resolve().parent
)


def _load_env(path: Path):
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_env(BASE_DIR / ".env")

DATA_DIR = Path(os.environ.get("VHS_SECURITY_DATA", BASE_DIR / "data"))
if not DATA_DIR.is_absolute():
    DATA_DIR = (BASE_DIR / DATA_DIR).resolve()
PLAN_DIR = DATA_DIR / "plans"
DB_PATH = DATA_DIR / "vhs_security.db"
SECRET_KEY = os.environ.get("SECRET_KEY", "vhs-security-dev-key-change-me")
AUTH_ENABLED = os.environ.get("VHS_SECURITY_AUTH", "1") not in ("0", "false", "False")
AUTH_USER = os.environ.get("VHS_SECURITY_USER", "admin")
AUTH_PASSWORD = os.environ.get("VHS_SECURITY_PASSWORD", "change-me")
STREAMER_URL = os.environ.get("STREAMER_URL", "").rstrip("/")
STREAMER_TOKEN = os.environ.get("STREAMER_API_TOKEN", "")
VIEWER_URL_DEFAULT = os.environ.get("VIEWER_URL", "").rstrip("/")
GEO_MAP_PROVIDER = os.environ.get("GEO_MAP_PROVIDER", "leaflet").strip().lower()
YANDEX_MAPS_API_KEY = os.environ.get("YANDEX_MAPS_API_KEY", "").strip()
VIEWER_EVENTS_PATH = Path(os.environ.get("VIEWER_EVENTS_PATH", "")) if os.environ.get("VIEWER_EVENTS_PATH") else None
INGEST_TOKEN = os.environ.get("VHS_SECURITY_INGEST_TOKEN", "")
SSO_SECRET = os.environ.get("VHS_SSO_SECRET", "")

DATA_DIR.mkdir(parents=True, exist_ok=True)
PLAN_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)
app.secret_key = SECRET_KEY
app.config.update(
    SESSION_COOKIE_NAME="vhs_security_session",
    MAX_CONTENT_LENGTH=16 * 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
)


# ----------------------------------------------------------------------
# База
# ----------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS buildings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'building',
    center_lat REAL NOT NULL DEFAULT 0,
    center_lon REAL NOT NULL DEFAULT 0,
    geo_zoom INTEGER NOT NULL DEFAULT 16,
    boundary_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS floors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 1,
    plan_filename TEXT NOT NULL DEFAULT '',
    plan_width INTEGER NOT NULL DEFAULT 0,
    plan_height INTEGER NOT NULL DEFAULT 0,
    walls_json TEXT NOT NULL DEFAULT '[]' 
);
CREATE TABLE IF NOT EXISTS territory_buildings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    territory_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    points_json TEXT NOT NULL DEFAULT '[]',
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS cameras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_ref TEXT NOT NULL,
    placed INTEGER NOT NULL DEFAULT 0,
    source_url TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    floor_id INTEGER NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
    x REAL NOT NULL DEFAULT 50,
    y REAL NOT NULL DEFAULT 50,
    angle REAL NOT NULL DEFAULT 0,
    fov REAL NOT NULL DEFAULT 70,
    view_range REAL NOT NULL DEFAULT 35,
    stream_url TEXT NOT NULL DEFAULT '',
    zone_id INTEGER REFERENCES zones(id) ON DELETE SET NULL,
    armed INTEGER NOT NULL DEFAULT 0,
    guard_schedule_enabled INTEGER NOT NULL DEFAULT 0,
    alarm_types_json TEXT NOT NULL DEFAULT '["person","vehicle","plate"]',
    geo_lat REAL,
    geo_lon REAL,
    geo_alt REAL NOT NULL DEFAULT 0,
    geo_azimuth REAL NOT NULL DEFAULT 0,
    geo_fov REAL NOT NULL DEFAULT 60,
    geo_range_m REAL NOT NULL DEFAULT 80,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_seen REAL,
    UNIQUE(camera_ref)
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id INTEGER REFERENCES cameras(id) ON DELETE SET NULL,
    source TEXT NOT NULL,
    external_key TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    plate TEXT NOT NULL DEFAULT '',
    snapshot_url TEXT NOT NULL DEFAULT '',
    ts REAL NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    active INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS alarms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
    camera_id INTEGER REFERENCES cameras(id) ON DELETE SET NULL,
    alarm_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',
    status TEXT NOT NULL DEFAULT 'active',
    title TEXT NOT NULL DEFAULT '',
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at REAL NOT NULL,
    resolved_at REAL
);
CREATE INDEX IF NOT EXISTS idx_alarms_status ON alarms(status, created_at DESC);
CREATE TABLE IF NOT EXISTS camera_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    weekday INTEGER NOT NULL,
    arm_time TEXT NOT NULL DEFAULT '',
    disarm_time TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    UNIQUE(camera_id, weekday)
);
CREATE TABLE IF NOT EXISTS holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS zones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    floor_id INTEGER NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    geometry_json TEXT NOT NULL DEFAULT '[]',
    armed INTEGER NOT NULL DEFAULT 0,
    schedule_enabled INTEGER NOT NULL DEFAULT 0,
    holiday_mode TEXT NOT NULL DEFAULT 'weekday',
    weekend_arm_time TEXT NOT NULL DEFAULT '',
    weekend_disarm_time TEXT NOT NULL DEFAULT '',
    holiday_arm_time TEXT NOT NULL DEFAULT '',
    holiday_disarm_time TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS zone_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zone_id INTEGER NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
    weekday INTEGER NOT NULL,
    arm_time TEXT NOT NULL DEFAULT '',
    disarm_time TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    UNIQUE(zone_id, weekday)
);
CREATE TABLE IF NOT EXISTS notification_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alarm_id INTEGER REFERENCES alarms(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    recipient TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at REAL NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    sent_at REAL
);
CREATE INDEX IF NOT EXISTS idx_notification_status ON notification_jobs(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_camera ON events(camera_id, ts DESC);
"""


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = get_db()
    db.executescript(SCHEMA)
    columns = {row[1] for row in db.execute("PRAGMA table_info(cameras)").fetchall()}
    if "view_range" not in columns:
        db.execute("ALTER TABLE cameras ADD COLUMN view_range REAL NOT NULL DEFAULT 35")
    if "stream_url" not in columns:
        db.execute("ALTER TABLE cameras ADD COLUMN stream_url TEXT NOT NULL DEFAULT ''")
    if "armed" not in columns:
        db.execute("ALTER TABLE cameras ADD COLUMN armed INTEGER NOT NULL DEFAULT 0")
    if "guard_schedule_enabled" not in columns:
        db.execute("ALTER TABLE cameras ADD COLUMN guard_schedule_enabled INTEGER NOT NULL DEFAULT 0")
    if "alarm_types_json" not in columns:
        db.execute("ALTER TABLE cameras ADD COLUMN alarm_types_json TEXT NOT NULL DEFAULT '[\"person\",\"vehicle\",\"plate\"]'")
    if "zone_id" not in columns:
        db.execute("ALTER TABLE cameras ADD COLUMN zone_id INTEGER REFERENCES zones(id) ON DELETE SET NULL")
    if "placed" not in columns:
        db.execute("ALTER TABLE cameras ADD COLUMN placed INTEGER NOT NULL DEFAULT 0")
        db.execute("UPDATE cameras SET placed=1")
    for geo_column, definition in (
        ("geo_lat", "REAL"),
        ("geo_lon", "REAL"),
        ("geo_alt", "REAL NOT NULL DEFAULT 0"),
        ("geo_azimuth", "REAL NOT NULL DEFAULT 0"),
        ("geo_fov", "REAL NOT NULL DEFAULT 60"),
        ("geo_range_m", "REAL NOT NULL DEFAULT 80"),
    ):
        if geo_column not in columns:
            db.execute(f"ALTER TABLE cameras ADD COLUMN {geo_column} {definition}")
    for camera in db.execute("SELECT * FROM cameras WHERE zone_id IS NULL").fetchall():
        db.execute(
            "INSERT INTO zones (floor_id, name, armed, schedule_enabled, created_at) VALUES (?, ?, ?, ?, ?)",
            (camera["floor_id"], f"{camera['name']} — зона", camera["armed"], camera["guard_schedule_enabled"], time.time()),
        )
        zone_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        db.execute("UPDATE cameras SET zone_id=? WHERE id=?", (zone_id, camera["id"]))
        for rule in db.execute("SELECT * FROM camera_schedules WHERE camera_id=?", (camera["id"],)).fetchall():
            db.execute(
                "INSERT OR IGNORE INTO zone_schedules (zone_id, weekday, arm_time, disarm_time, enabled) VALUES (?, ?, ?, ?, ?)",
                (zone_id, rule["weekday"], rule["arm_time"], rule["disarm_time"], rule["enabled"]),
            )
    floor_columns = {row[1] for row in db.execute("PRAGMA table_info(floors)").fetchall()}
    if "walls_json" not in floor_columns:
        db.execute("ALTER TABLE floors ADD COLUMN walls_json TEXT NOT NULL DEFAULT '[]'")
    zone_columns = {row[1] for row in db.execute("PRAGMA table_info(zones)").fetchall()}
    if "geometry_json" not in zone_columns:
        db.execute("ALTER TABLE zones ADD COLUMN geometry_json TEXT NOT NULL DEFAULT '[]'")
    building_columns = {row[1] for row in db.execute("PRAGMA table_info(buildings)").fetchall()}
    for building_column, definition in (
        ("kind", "TEXT NOT NULL DEFAULT 'building'"),
        ("center_lat", "REAL NOT NULL DEFAULT 0"),
        ("center_lon", "REAL NOT NULL DEFAULT 0"),
        ("geo_zoom", "INTEGER NOT NULL DEFAULT 16"),
        ("boundary_json", "TEXT NOT NULL DEFAULT '[]'"),
    ):
        if building_column not in building_columns:
            db.execute(f"ALTER TABLE buildings ADD COLUMN {building_column} {definition}")
    db.commit()
    # Журнал Security наполняется только событиями Viewer.
    db.execute("DELETE FROM events WHERE source='streamer'")
    db.commit()
    if db.execute("SELECT COUNT(*) FROM buildings").fetchone()[0] == 0:
        db.execute("INSERT INTO buildings (name, address) VALUES (?, ?)", ("Объект", ""))
        building_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        db.execute(
            "INSERT INTO floors (building_id, name, level) VALUES (?, ?, ?)",
            (building_id, "1 этаж", 1),
        )
        db.commit()


def rows(sql: str, params=()):
    return [dict(row) for row in get_db().execute(sql, params).fetchall()]


def one(sql: str, params=()):
    row = get_db().execute(sql, params).fetchone()
    return dict(row) if row else None


def get_streamer_url() -> str:
    row = one("SELECT value FROM settings WHERE key='streamer_url'")
    return (row["value"] if row else STREAMER_URL).rstrip("/")


def set_streamer_url(url: str):
    url = url.rstrip("/")
    get_db().execute(
        "INSERT INTO settings (key, value) VALUES ('streamer_url', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (url,)
    )
    get_db().commit()


def get_app_setting(key: str, default: str = "") -> str:
    row = one("SELECT value FROM settings WHERE key=?", (key,))
    return row["value"] if row else default


def get_viewer_url() -> str:
    row = one("SELECT value FROM settings WHERE key='viewer_url'")
    return (row["value"] if row else VIEWER_URL_DEFAULT).rstrip("/")


def set_viewer_url(url: str):
    url = url.rstrip("/")
    get_db().execute(
        "INSERT INTO settings (key, value) VALUES ('viewer_url', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (url,)
    )
    get_db().commit()


def _local_ip() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def _probe_viewer(url: str):
    try:
        response = requests.get(url.rstrip("/") + "/api/integration/info", timeout=0.45)
        if not response.ok:
            return None
        data = response.json()
        if data.get("app") != "VHS-Viewer":
            return None
        return {"url": url.rstrip("/"), "version": data.get("version", ""), "app": "VHS-Viewer"}
    except Exception:
        return None


def discover_viewers(subnet: str | None = None):
    if subnet:
        network = ipaddress.ip_network(subnet, strict=False)
    else:
        network = ipaddress.ip_network(f"{_local_ip()}/24", strict=False)
    hosts = list(network.hosts())[:254]
    candidates = [(str(host), 8200) for host in hosts]
    found = []
    def check(item):
        host, port = item
        return _probe_viewer(f"http://{host}:{port}")
    with concurrent.futures.ThreadPoolExecutor(max_workers=64) as pool:
        for result in pool.map(check, candidates):
            if result:
                found.append(result)
    current_url = get_viewer_url()
    current = _probe_viewer(current_url) if current_url else None
    if current and all(x["url"] != current["url"] for x in found):
        found.append(current)
    unique = {item["url"]: item for item in found}
    return str(network), sorted(unique.values(), key=lambda x: x["url"])


def _streamer_headers():
    return {"X-API-Token": STREAMER_TOKEN} if STREAMER_TOKEN else {}


def _default_floor_id() -> int:
    row = one("SELECT id FROM floors ORDER BY id LIMIT 1")
    return row["id"] if row else 1


def _camera_for_ref(camera_ref: str, name: str, source_url: str, floor_id: int):
    cam = one("SELECT * FROM cameras WHERE camera_ref=?", (camera_ref,))
    if cam:
        return cam
    base_ref = re.sub(r"_s\d+$", "", str(camera_ref or ""))
    for candidate in rows("SELECT * FROM cameras"):
        if re.sub(r"_s\d+$", "", str(candidate.get("camera_ref") or "")) == base_ref:
            return candidate
    # Viewer присылает stream_id (usb_..._s1), а камера уже создана по
    # camera_id/имени из состояния Viewer. Не плодим вторую запись.
    if source_url and source_url == get_viewer_url() and name:
        cam = one(
            "SELECT * FROM cameras WHERE name=? AND floor_id=? "
            "ORDER BY (stream_url != '') DESC, id LIMIT 1",
            (name, floor_id),
        )
        if cam:
            return cam
    get_db().execute(
        "INSERT INTO cameras (camera_ref, source_url, name, floor_id, placed) VALUES (?, ?, ?, ?, 0)",
        (camera_ref, source_url, name or camera_ref, floor_id),
    )
    get_db().commit()
    return one("SELECT * FROM cameras WHERE camera_ref=?", (camera_ref,))


def _parse_hhmm(value: str):
    try:
        hh, mm = str(value).split(":", 1)
        hh, mm = int(hh), int(mm)
        if 0 <= hh <= 23 and 0 <= mm <= 59:
            return hh * 60 + mm
    except (TypeError, ValueError):
        pass
    return None


def _holiday_today(now=None):
    from datetime import datetime
    now = now or datetime.now()
    return one(
        "SELECT * FROM holidays WHERE date=? AND enabled=1",
        (now.strftime("%Y-%m-%d"),),
    )


def _schedule_armed(cam: dict, now=None) -> bool:
    from datetime import datetime, timedelta
    now = now or datetime.now()
    if _holiday_today(now):
        return True
    rules = {r["weekday"]: r for r in rows(
        "SELECT * FROM camera_schedules WHERE camera_id=? AND enabled=1",
        (cam["id"],),
    )}
    def active_on(weekday, minutes):
        rule = rules.get(weekday)
        if not rule:
            return False
        arm = _parse_hhmm(rule.get("arm_time"))
        disarm = _parse_hhmm(rule.get("disarm_time"))
        if arm is None or disarm is None:
            return False
        if arm == disarm:
            return True
        if arm < disarm:
            return arm <= minutes < disarm
        return minutes >= arm or minutes < disarm
    today = now.isoweekday()
    minutes = now.hour * 60 + now.minute
    if active_on(today, minutes):
        return True
    # Ночной интервал предыдущего дня: 20:00–08:00.
    prev = now - timedelta(days=1)
    prev_rule = rules.get(prev.isoweekday())
    if prev_rule:
        arm = _parse_hhmm(prev_rule.get("arm_time"))
        disarm = _parse_hhmm(prev_rule.get("disarm_time"))
        if arm is not None and disarm is not None and arm > disarm and minutes < disarm:
            return True
    return False


def _time_in_interval(arm_time: str, disarm_time: str, now) -> bool:
    arm = _parse_hhmm(arm_time)
    disarm = _parse_hhmm(disarm_time)
    if arm is None or disarm is None:
        return False
    minutes = now.hour * 60 + now.minute
    if arm == disarm:
        return True
    if arm < disarm:
        return arm <= minutes < disarm
    return minutes >= arm or minutes < disarm


def _zone_effective(zone: dict, now=None) -> bool:
    from datetime import datetime
    now = now or datetime.now()
    if not zone.get("schedule_enabled"):
        return bool(zone.get("armed"))
    holiday = _holiday_today(now)
    mode = str(zone.get("holiday_mode") or "weekday")
    if holiday:
        if mode == "disarmed":
            return False
        if mode == "custom":
            return _time_in_interval(
                zone.get("holiday_arm_time", ""), zone.get("holiday_disarm_time", ""), now
            )
        if mode == "weekend":
            return _time_in_interval(
                zone.get("weekend_arm_time", ""), zone.get("weekend_disarm_time", ""), now
            )
    rules = {r["weekday"]: r for r in rows(
        "SELECT * FROM zone_schedules WHERE zone_id=? AND enabled=1", (zone["id"],)
    )}
    rule = rules.get(now.isoweekday())
    if rule and _time_in_interval(rule.get("arm_time", ""), rule.get("disarm_time", ""), now):
        return True
    # Ночной интервал предыдущего дня.
    from datetime import timedelta
    prev = now - timedelta(days=1)
    prev_rule = rules.get(prev.isoweekday())
    if prev_rule:
        arm = _parse_hhmm(prev_rule.get("arm_time", ""))
        disarm = _parse_hhmm(prev_rule.get("disarm_time", ""))
        if arm is not None and disarm is not None and arm > disarm:
            return now.hour * 60 + now.minute < disarm
    return False


def _effective_armed(cam: dict) -> bool:
    zone = one("SELECT * FROM zones WHERE id=?", (cam.get("zone_id"),)) if cam.get("zone_id") else None
    if zone:
        return _zone_effective(zone)
    return bool(cam.get("armed"))


def _sync_camera_list(cameras, base: str, floor_id: int):
    refs = []
    for cam in cameras if isinstance(cameras, list) else []:
        ref = str(cam.get("id") or "").strip()
        if not ref:
            continue
        _camera_for_ref(ref, cam.get("name") or ref, base, floor_id)
        refs.append(ref)
    db = get_db()
    if refs:
        placeholders = ",".join("?" for _ in refs)
        cursor = db.execute(
            f"DELETE FROM cameras WHERE source_url=? AND camera_ref NOT IN ({placeholders})",
            (base, *refs),
        )
    else:
        cursor = db.execute("DELETE FROM cameras WHERE source_url=?", (base,))
    db.commit()
    return len(refs), cursor.rowcount


def _event_type(topic: str, data: dict) -> str:
    topic = (topic or "").lower()
    if "motion" in topic or "fielddetector" in topic or "linedetector" in topic:
        return "motion"
    if "tamper" in topic:
        return "tamper"
    if data.get("plate") or data.get("PlateNumber"):
        return "plate"
    return "event"


def _insert_event(
    camera_id, source, external_key, event_type, title, ts, severity="info",
    description="", plate="", snapshot_url="", metadata=None,
):
    cursor = get_db().execute(
        """INSERT OR IGNORE INTO events
           (camera_id, source, external_key, event_type, severity, title,
            description, plate, snapshot_url, ts, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            camera_id, source, external_key, event_type, severity, title,
            description, plate, snapshot_url, float(ts or time.time()),
            json.dumps(metadata or {}, ensure_ascii=False), time.time(),
        ),
    )
    get_db().commit()
    row = one("SELECT id FROM events WHERE external_key=?", (external_key,))
    return row["id"] if row else cursor.lastrowid


ALARM_TYPES = {"person", "plate", "vehicle", "animal", "tamper", "offline", "line_crossing"}


def _camera_alarm_types(cam: dict) -> set[str]:
    try:
        types = json.loads(cam.get("alarm_types_json") or "[]")
    except (TypeError, ValueError):
        types = []
    if not types:
        types = ["person", "vehicle", "plate"]
    return {str(t).lower() for t in types}


def _evaluate_alarm(event_id, cam, category: str, title: str, ts, metadata=None):
    if not cam or not _effective_armed(cam):
        return None
    category = (category or "object").lower()
    if category not in ALARM_TYPES or category not in _camera_alarm_types(cam):
        return None
    existing = one("SELECT id FROM alarms WHERE event_id=?", (event_id,))
    if existing:
        return existing["id"]
    get_db().execute(
        "INSERT INTO alarms (event_id, camera_id, alarm_type, severity, status, title, details_json, created_at) "
        "VALUES (?, ?, ?, ?, 'active', ?, ?, ?)",
        (event_id, cam["id"], category, "warning", title, json.dumps(metadata or {}, ensure_ascii=False), ts),
    )
    get_db().commit()
    alarm_id = one("SELECT id FROM alarms WHERE event_id=?", (event_id,))["id"]
    try:
        notifications.enqueue_alarm(alarm_id)
    except Exception:
        pass
    return alarm_id


def _event_with_snapshot(event: dict) -> dict:
    try:
        metadata = json.loads(event.get("metadata_json") or "{}")
    except (TypeError, ValueError):
        metadata = {}
    path = metadata.get("snapshot") if isinstance(metadata, dict) else ""
    event = dict(event)
    event["snapshot_endpoint"] = url_for("api_event_snapshot", event_id=event["id"]) if path else ""
    return event


def floor_payload(floor, include_events=False):
    result = dict(floor)
    try:
        result["walls"] = json.loads(floor.get("walls_json") or "[]")
    except ValueError:
        result["walls"] = []
    result["plan_url"] = url_for("plan_file", filename=floor["plan_filename"]) if floor["plan_filename"] else ""
    camera_rows = rows(
        "SELECT * FROM cameras WHERE floor_id=? AND placed=1 ORDER BY name", (floor["id"],)
    )
    for camera in camera_rows:
        camera["effective_armed"] = _effective_armed(camera)
        camera["alarm_types"] = sorted(_camera_alarm_types(camera))
        zone = one("SELECT * FROM zones WHERE id=?", (camera.get("zone_id"),)) if camera.get("zone_id") else None
        camera["zone_name"] = zone["name"] if zone else ""
    result["cameras"] = camera_rows
    zone_rows = rows("SELECT * FROM zones WHERE floor_id=? ORDER BY name", (floor["id"],))
    for zone in zone_rows:
        zone["effective_armed"] = _zone_effective(zone)
        zone["schedule"] = rows(
            "SELECT * FROM zone_schedules WHERE zone_id=? ORDER BY weekday", (zone["id"],)
        )
        zone["camera_count"] = one(
            "SELECT COUNT(*) AS n FROM cameras WHERE zone_id=?", (zone["id"],)
        )["n"]
    result["zones"] = zone_rows
    footprints = rows(
        "SELECT * FROM territory_buildings WHERE territory_id=? ORDER BY id",
        (floor["building_id"],),
    )
    for footprint in footprints:
        try:
            footprint["points"] = json.loads(footprint.get("points_json") or "[]")
        except ValueError:
            footprint["points"] = []
    result["footprints"] = footprints
    result["holidays"] = rows("SELECT * FROM holidays ORDER BY date")
    result["alarms"] = rows(
        "SELECT a.*, c.name AS camera_name FROM alarms a "
        "LEFT JOIN cameras c ON c.id=a.camera_id "
        "WHERE a.status='active' AND (c.floor_id=? OR c.floor_id IS NULL) "
        "ORDER BY a.created_at DESC LIMIT 100",
        (floor["id"],),
    )
    if include_events:
        result["events"] = [
            _event_with_snapshot(e) for e in rows(
                "SELECT e.*, c.name AS camera_name, a.id AS alarm_id, a.status AS alarm_status FROM events e "
                "LEFT JOIN cameras c ON c.id=e.camera_id "
                "LEFT JOIN alarms a ON a.event_id=e.id "
                "WHERE c.floor_id=? OR c.floor_id IS NULL ORDER BY e.ts DESC LIMIT 100",
                (floor["id"],),
            )
        ]
    return result


def sync_streamer_cameras(floor_id: int):
    base = get_streamer_url()
    if not base:
        return 0, 0, "STREAMER_URL не задан"
    try:
        response = requests.get(
            f"{base}/api/cameras", headers=_streamer_headers(), timeout=8
        )
        if response.status_code == 404:
            # Совместимость со сборками Streamer без GET /api/cameras.
            list_response = requests.get(
                f"{base}/api/cameras/list", headers=_streamer_headers(), timeout=8
            )
            if list_response.ok:
                count, removed = _sync_camera_list(list_response.json(), base, floor_id)
                return count, removed, ""
            # Последний fallback: статус + карточки по одной.
            status_response = requests.get(
                f"{base}/api/cameras/status", headers=_streamer_headers(), timeout=8
            )
            status_response.raise_for_status()
            statuses = status_response.json()
            cameras = []
            for cam_id in statuses if isinstance(statuses, dict) else {}:
                detail = requests.get(
                    f"{base}/api/cameras/{cam_id}",
                    headers=_streamer_headers(), timeout=8,
                )
                if detail.ok:
                    cameras.append(detail.json())
        else:
            response.raise_for_status()
            cameras = response.json()
    except Exception as exc:
        return 0, 0, f"Streamer недоступен: {exc}"
    count, removed = _sync_camera_list(cameras, base, floor_id)
    return count, removed, ""


def sync_streamer_streams(floor_id: int):
    """Получить авторизованные WebRTC-URL из Streamer и привязать к камерам."""
    base = get_streamer_url()
    if not base:
        return 0, "STREAMER_URL не задан"
    try:
        response = requests.get(
            f"{base}/api/integration/streams",
            headers=_streamer_headers(), timeout=8,
        )
        response.raise_for_status()
        streams = response.json().get("streams", [])
    except Exception as exc:
        return 0, f"Потоки Streamer недоступны: {exc}"
    count = 0
    for stream in streams:
        cam_ref = str(stream.get("camera_id") or "").strip()
        if not cam_ref:
            continue
        cam = _camera_for_ref(cam_ref, cam_ref, base, floor_id)
        url = str(stream.get("webrtc_url") or "")
        get_db().execute("UPDATE cameras SET stream_url=? WHERE id=?", (url, cam["id"]))
        count += 1
    get_db().commit()
    return count, ""


def sync_streamer_events(floor_id: int):
    base = get_streamer_url()
    if not base:
        return 0, "STREAMER_URL не задан"
    last = one("SELECT MAX(ts) AS ts FROM events WHERE source='streamer'")
    since = last["ts"] if last and last["ts"] else 0
    try:
        response = requests.get(
            f"{base}/api/events",
            params={"since_ts": since, "limit": 1000},
            headers=_streamer_headers(),
            timeout=8,
        )
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        return 0, f"Ошибка событий Streamer: {exc}"
    count = 0
    for ev in payload.get("events", []):
        cam_ref = str(ev.get("camera_id") or "")
        if not cam_ref:
            continue
        data = ev.get("data") or {}
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except ValueError:
                data = {}
        cam = _camera_for_ref(cam_ref, cam_ref, base, floor_id)
        title = ev.get("topic_short") or ev.get("topic") or "Событие"
        etype = _event_type(ev.get("topic") or "", data)
        plate = str(data.get("plate") or data.get("PlateNumber") or "")
        external = f"streamer:{ev.get('id') or (cam_ref + ':' + str(ev.get('ts')))}"
        _insert_event(
            cam["id"], "streamer", external, etype, title,
            ev.get("ts") or time.time(), ev.get("severity") or "info",
            plate=plate, metadata={"topic": ev.get("topic"), "data": data},
        )
        count += 1
    return count, ""


# ----------------------------------------------------------------------
# Интеграция с Viewer (JSONL ALPR/YOLO)
# ----------------------------------------------------------------------
def sync_viewer_events(floor_id: int):
    if not VIEWER_EVENTS_PATH or not VIEWER_EVENTS_PATH.exists():
        return 0, "VIEWER_EVENTS_PATH не задан или файл не найден"
    count = 0
    try:
        with VIEWER_EVENTS_PATH.open("r", encoding="utf-8") as fh:
            lines = fh.readlines()[-500:]
    except OSError as exc:
        return 0, f"Не удалось прочитать события Viewer: {exc}"
    for line in lines:
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        cam_ref = str(ev.get("camera_id") or "")
        if not cam_ref:
            continue
        cam = _camera_for_ref(cam_ref, ev.get("camera_name") or cam_ref, get_viewer_url() or "viewer", floor_id)
        category = ev.get("category") or "object"
        plate = str(ev.get("plate") or "")
        label = ev.get("label") or plate or "объект"
        snapshot = ev.get("snapshot") or ""
        snapshot_url = f"{get_viewer_url()}/snapshot/{snapshot}" if get_viewer_url() and snapshot else ""
        external = f"viewer:{ev.get('ts')}:{cam_ref}:{label}"
        title = {
            "plate": f"Номер {plate or label}",
            "person": "Обнаружен человек",
            "vehicle": "Обнаружен транспорт",
            "animal": "Обнаружено животное",
        }.get(category, f"Объект: {label}")
        _insert_event(
            cam["id"], "viewer", external, category, title,
            ev.get("ts") or time.time(), "warning" if category in ("plate", "person") else "info",
            description=f"Уверенность: {round(float(ev.get('confidence', 0)) * 100)}%",
            plate=plate, snapshot_url=snapshot_url, metadata=ev,
        )
        count += 1
    return count, ""


def merge_duplicate_cameras():
    """Объединить camera_id и stream_id одной камеры Viewer.

    Viewer отдаёт камеру как usb_..., а событие/старый импорт мог сохранить
    stream_id usb_..._s1. Это одна камера; оставляем запись без суффикса,
    переносим на неё события и тревоги.
    """
    cameras = rows("SELECT * FROM cameras ORDER BY id")
    groups = {}
    for camera in cameras:
        base_ref = re.sub(r"_s\d+$", "", str(camera.get("camera_ref") or ""))
        groups.setdefault(base_ref, []).append(camera)
    removed = 0
    db = get_db()
    for base_ref, cams in groups.items():
        if len(cams) < 2:
            continue
        # Предпочитаем camera_id без stream-суффикса; иначе — более новую запись.
        keeper = next(
            (camera for camera in cams if camera["camera_ref"] == base_ref and camera.get("placed")),
            None,
        ) or next((camera for camera in cams if camera.get("placed")), None) or next(
            (camera for camera in cams if camera["camera_ref"] == base_ref),
            cams[-1],
        )
        for camera in cams:
            if camera["id"] == keeper["id"]:
                continue
            db.execute("UPDATE events SET camera_id=? WHERE camera_id=?", (keeper["id"], camera["id"]))
            db.execute("UPDATE alarms SET camera_id=? WHERE camera_id=?", (keeper["id"], camera["id"]))
            db.execute("DELETE FROM cameras WHERE id=?", (camera["id"],))
            removed += 1
    if removed:
        db.commit()
    return removed


def cleanup_phantom_zones():
    """Удалить пустые автозоны, оставшиеся от старых миграций камер."""
    db = get_db()
    cursor = db.execute(
        "DELETE FROM zones WHERE "
        "id NOT IN (SELECT zone_id FROM cameras WHERE zone_id IS NOT NULL) "
        "AND (geometry_json IS NULL OR geometry_json='[]') "
        "AND id NOT IN (SELECT DISTINCT zone_id FROM zone_schedules)"
    )
    db.commit()
    return cursor.rowcount


def sync_viewer_cameras(floor_id: int):
    """Удалить камеры Viewer, которых нет в актуальном журнале событий."""
    if not VIEWER_EVENTS_PATH or not VIEWER_EVENTS_PATH.exists():
        return 0, ""
    refs = set()
    try:
        with VIEWER_EVENTS_PATH.open("r", encoding="utf-8") as fh:
            for line in fh.readlines()[-2000:]:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                ref = str(event.get("camera_id") or "").strip()
                if ref:
                    refs.add(ref)
    except OSError as exc:
        return 0, f"Не удалось проверить камеры Viewer: {exc}"
    db = get_db()
    if refs:
        placeholders = ",".join("?" for _ in refs)
        cursor = db.execute(
            f"DELETE FROM cameras WHERE source_url=? AND camera_ref NOT IN ({placeholders})",
            (get_viewer_url() or "viewer", *refs),
        )
    else:
        cursor = db.execute("DELETE FROM cameras WHERE source_url=?", (get_viewer_url() or "viewer",))
    db.commit()
    return cursor.rowcount, ""


def sync_viewer_state(floor_id: int):
    """Единственный источник камер, потоков и событий для Security — Viewer."""
    if not get_viewer_url():
        return 0, 0, 0, "VIEWER_URL не задан"
    if not INGEST_TOKEN:
        return 0, 0, 0, "VHS_SECURITY_INGEST_TOKEN не задан"
    try:
        response = requests.get(
            f"{get_viewer_url()}/api/integration/state",
            headers={"X-Ingest-Token": INGEST_TOKEN}, timeout=12,
        )
        response.raise_for_status()
        state = response.json()
    except Exception as exc:
        return 0, 0, 0, f"Viewer недоступен: {exc}"
    cameras = state.get("cameras", [])
    refs = []
    streams = 0
    for item in cameras:
        ref = str(item.get("id") or "").strip()
        if not ref:
            continue
        name = str(item.get("name") or ref)
        cam = _camera_for_ref(ref, name, get_viewer_url(), floor_id)
        stream_list = item.get("streams") or []
        stream_url = str(stream_list[0].get("url") or "") if stream_list else ""
        get_db().execute(
            "UPDATE cameras SET name=?, source_url=?, stream_url=? WHERE camera_ref=? OR name=?",
            (name, get_viewer_url(), stream_url, ref, name),
        )
        if stream_url:
            streams += 1
        refs.append(ref)
        refs.extend(
            row["camera_ref"] for row in get_db().execute(
                "SELECT camera_ref FROM cameras WHERE name=?", (name,)
            ).fetchall()
        )
    refs = list(dict.fromkeys(refs))
    removed = 0
    db = get_db()
    if refs:
        placeholders = ",".join("?" for _ in refs)
        cursor = db.execute(
            f"DELETE FROM cameras WHERE source_url != 'manual' AND camera_ref NOT IN ({placeholders})",
            (*refs,),
        )
        removed = cursor.rowcount
    else:
        cursor = db.execute("DELETE FROM cameras WHERE source_url != 'manual'")
        removed = cursor.rowcount
    db.commit()
    accepted = 0
    for event in state.get("events", []):
        if isinstance(event, dict) and _ingest_viewer_event(event, floor_id) is not None:
            accepted += 1
    merge_duplicate_cameras()
    return len(refs), removed, accepted, ""


def _authenticate(username: str, password: str):
    if hmac.compare_digest(username, AUTH_USER) and hmac.compare_digest(password, AUTH_PASSWORD):
        return {"username": username, "role": "admin"}
    row = one("SELECT * FROM users WHERE username=? AND active=1", (username,))
    if row and check_password_hash(row["password_hash"], password):
        return {"username": row["username"], "role": row["role"]}
    return None


def admin_required(view):
    @wraps(view)
    @login_required
    def wrapped(*args, **kwargs):
        if (getattr(g, "user", None) or {}).get("role") != "admin":
            if request.path.startswith("/api/"):
                return jsonify({"error": "forbidden"}), 403
            return "Доступ только для администратора", 403
        return view(*args, **kwargs)
    return wrapped


def csrf_token() -> str:
    if "_csrf" not in session:
        session["_csrf"] = secrets.token_urlsafe(32)
    return session["_csrf"]


app.jinja_env.globals["csrf_token"] = csrf_token


def _current_user():
    if not AUTH_ENABLED:
        return {"username": "local", "role": "admin"}
    user = session.get("user")
    if user:
        if user.get("username") != AUTH_USER:
            row = one("SELECT * FROM users WHERE username=? AND active=1", (user.get("username"),))
            if not row:
                session.pop("user", None)
                return None
            user = {"username": row["username"], "role": row["role"]}
            session["user"] = user
        return user
    sso_user = vhs_sso.read(SSO_SECRET)
    if sso_user:
        user = {"username": sso_user["username"], "role": sso_user.get("role", "admin")}
        session["user"] = user
        return user
    return None


@app.before_request
def _protect():
    if request.path == "/api/integrations/viewer/events":
        return
    if request.path == "/login" and request.method == "POST":
        origin = request.headers.get("Origin") or request.headers.get("Referer") or ""
        if origin and urlparse(origin).netloc != request.host:
            return "CSRF: external origin", 403
        return
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        provided = request.headers.get("X-CSRF-Token") or request.form.get("_csrf", "")
        expected = session.get("_csrf", "")
        if not expected or not hmac.compare_digest(provided, expected):
            if request.path.startswith("/api/"):
                return jsonify({"error": "csrf"}), 403
            return "CSRF token missing or invalid", 403


@app.after_request
def _no_cache_login(response):
    if request.path == "/login":
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
    return response


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        user = _current_user()
        if not user:
            if request.path.startswith("/api/"):
                return jsonify({"error": "unauthorized"}), 401
            return redirect(url_for("login", next=request.path))
        g.user = user
        return view(*args, **kwargs)
    return wrapped


@app.context_processor
def _inject():
    return {
        "user": _current_user(),
        "streamer_url": get_streamer_url(),
        "viewer_url": get_viewer_url(),
        "auth_enabled": AUTH_ENABLED,
        "app_name": APP_NAME,
        "app_version": __version__,
        "app_author": __author__,
        "app_footer": APP_FOOTER,
    }


@app.route("/login", methods=["GET", "POST"])
def login():
    error = ""
    if request.method == "POST":
        username = request.form.get("username", "")
        password = request.form.get("password", "")
        authenticated = _authenticate(username, password)
        if authenticated:
            session.clear()
            session["user"] = authenticated
            csrf_token()
            nxt = request.args.get("next") or url_for("index")
            response = redirect(nxt if nxt.startswith("/") else url_for("index"))
            return vhs_sso.set_cookie(response, SSO_SECRET, username, authenticated["role"])
        error = "Неверный логин или пароль."
    csrf_token()
    return render_template("login.html", error=error)


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return vhs_sso.clear_cookie(redirect(url_for("login")))


@app.route("/api/sync", methods=["POST"])
@admin_required
def api_sync():
    floor_id = int((request.get_json(silent=True) or {}).get("floor_id") or _default_floor_id())
    cameras, removed, viewer_events, error = sync_viewer_state(floor_id)
    return jsonify({
        "ok": not error,
        "cameras": cameras,
        "cameras_removed": removed,
        "viewer_cameras_removed": 0,
        "duplicate_cameras_removed": 0,
        "streams": cameras,
        "streamer_events": 0,
        "viewer_events": viewer_events,
        "warnings": [error] if error else [],
    })


@app.route("/api/state")
@login_required
def api_state():
    ensure_viewer_stream_urls()
    floor_id = request.args.get("floor_id", type=int) or _default_floor_id()
    floor = one(
        "SELECT f.*, b.name AS building_name, b.kind AS building_kind, "
        "b.center_lat AS building_center_lat, b.center_lon AS building_center_lon, "
        "b.geo_zoom AS building_geo_zoom FROM floors f "
        "JOIN buildings b ON b.id=f.building_id WHERE f.id=?", (floor_id,)
    )
    if not floor:
        return jsonify({"error": "floor not found"}), 404
    floors = rows(
        "SELECT f.id, f.name, f.level, f.building_id, f.plan_filename, b.name AS building_name "
        "FROM floors f JOIN buildings b ON b.id=f.building_id "
        "ORDER BY b.id, f.level, f.id"
    )
    return jsonify({
        "floor": floor_payload(floor, include_events=True),
        "floors": floors,
        "buildings": rows("SELECT id, name, kind FROM buildings ORDER BY name"),
        "holidays": rows("SELECT * FROM holidays ORDER BY date"),
        "streamer_url": get_streamer_url(),
        "viewer_url": get_viewer_url(),
    })


@app.route("/api/events")
@login_required
def api_events():
    floor_id = request.args.get("floor_id", type=int) or _default_floor_id()
    sql = (
        "SELECT e.*, c.name AS camera_name, a.id AS alarm_id, a.status AS alarm_status FROM events e "
        "LEFT JOIN cameras c ON c.id=e.camera_id "
        "LEFT JOIN alarms a ON a.event_id=e.id "
        "WHERE (c.floor_id=? OR c.floor_id IS NULL)"
    )
    params = [floor_id]
    sql += " ORDER BY e.ts DESC LIMIT 100"
    return jsonify({"events": [_event_with_snapshot(e) for e in rows(sql, params)]})


@app.get("/api/alarms")
@login_required
def api_alarms():
    status = request.args.get("status", "active")
    if status not in ("active", "resolved", "all"):
        status = "active"
    sql = (
        "SELECT a.*, c.name AS camera_name FROM alarms a "
        "LEFT JOIN cameras c ON c.id=a.camera_id"
    )
    params = ()
    if status != "all":
        sql += " WHERE a.status=?"
        params = (status,)
    sql += " ORDER BY a.created_at DESC LIMIT 200"
    return jsonify({"alarms": rows(sql, params)})


@app.get("/api/events/<int:event_id>/snapshot")
@login_required
def api_event_snapshot(event_id: int):
    event = one("SELECT * FROM events WHERE id=?", (event_id,))
    if not event:
        return jsonify({"error": "not found"}), 404
    try:
        metadata = json.loads(event.get("metadata_json") or "{}")
    except (TypeError, ValueError):
        metadata = {}
    path = str(metadata.get("snapshot") or "") if isinstance(metadata, dict) else ""
    if not path:
        return jsonify({"error": "snapshot not found"}), 404
    if not get_viewer_url() or not INGEST_TOKEN:
        return jsonify({"error": "viewer not configured"}), 503
    try:
        response = requests.get(
            f"{get_viewer_url()}/api/integration/snapshot/{quote(path, safe='/')}",
            headers={"X-Ingest-Token": INGEST_TOKEN}, timeout=10,
        )
    except requests.RequestException as exc:
        return jsonify({"error": str(exc)}), 502
    if not response.ok:
        return jsonify({"error": "viewer snapshot error"}), 404
    return app.response_class(
        response.content,
        status=200,
        mimetype=response.headers.get("Content-Type", "image/jpeg"),
    )


@app.post("/api/events/clear")
@login_required
def api_clear_events():
    """Очистка оперативного журнала. all=1 — весь журнал, иначе текущий этаж."""
    if (getattr(g, "user", None) or {}).get("role") != "admin":
        return jsonify({"error": "forbidden"}), 403
    data = request.get_json(silent=True) or {}
    clear_all = bool(data.get("all"))
    if clear_all:
        cursor = get_db().execute("DELETE FROM events")
    else:
        floor_id = int(data.get("floor_id") or _default_floor_id())
        cursor = get_db().execute(
            "DELETE FROM events WHERE camera_id IN (SELECT id FROM cameras WHERE floor_id=?) "
            "OR camera_id IS NULL",
            (floor_id,),
        )
    get_db().commit()
    return jsonify({"ok": True, "deleted": cursor.rowcount, "all": clear_all})


@app.post("/api/zones/<int:zone_id>/arm")
@admin_required
def api_arm_zone(zone_id: int):
    data = request.get_json(silent=True) or {}
    armed = 1 if data.get("armed") else 0
    get_db().execute("UPDATE zones SET armed=? WHERE id=?", (armed, zone_id))
    get_db().commit()
    return jsonify({"ok": True, "armed": bool(armed)})


@app.get("/api/zones/<int:zone_id>/schedule")
@admin_required
def api_get_zone_schedule(zone_id: int):
    zone = one("SELECT * FROM zones WHERE id=?", (zone_id,))
    if not zone:
        return jsonify({"error": "not found"}), 404
    return jsonify({
        "zone": zone,
        "rules": rows("SELECT * FROM zone_schedules WHERE zone_id=? ORDER BY weekday", (zone_id,)),
        "holidays": rows("SELECT * FROM holidays ORDER BY date"),
    })


@app.post("/api/zones/<int:zone_id>/schedule")
@admin_required
def api_set_zone_schedule(zone_id: int):
    data = request.get_json(silent=True) or {}
    rules = data.get("rules") or []
    if not isinstance(rules, list):
        return jsonify({"error": "invalid rules"}), 400
    db = get_db()
    db.execute("DELETE FROM zone_schedules WHERE zone_id=?", (zone_id,))
    for rule in rules:
        try:
            weekday = int(rule.get("weekday"))
        except (TypeError, ValueError):
            continue
        if weekday not in range(1, 8) or not rule.get("enabled", True):
            continue
        arm = str(rule.get("arm_time") or "")
        disarm = str(rule.get("disarm_time") or "")
        if _parse_hhmm(arm) is None or _parse_hhmm(disarm) is None:
            continue
        db.execute(
            "INSERT INTO zone_schedules (zone_id, weekday, arm_time, disarm_time, enabled) "
            "VALUES (?, ?, ?, ?, 1)", (zone_id, weekday, arm, disarm),
        )
    mode = str(data.get("holiday_mode") or "weekday")
    if mode not in ("weekday", "weekend", "custom", "disarmed"):
        mode = "weekday"
    db.execute(
        "UPDATE zones SET schedule_enabled=?, holiday_mode=?, weekend_arm_time=?, "
        "weekend_disarm_time=?, holiday_arm_time=?, holiday_disarm_time=? WHERE id=?",
        (
            1 if data.get("enabled") else 0, mode,
            str(data.get("weekend_arm_time") or ""),
            str(data.get("weekend_disarm_time") or ""),
            str(data.get("holiday_arm_time") or ""),
            str(data.get("holiday_disarm_time") or ""),
            zone_id,
        ),
    )
    db.commit()
    return jsonify({"ok": True})


@app.get("/api/cameras/<int:camera_id>/schedule")
@admin_required
def api_get_schedule(camera_id: int):
    camera = one("SELECT * FROM cameras WHERE id=?", (camera_id,))
    if not camera:
        return jsonify({"error": "not found"}), 404
    return jsonify({
        "enabled": bool(camera.get("guard_schedule_enabled")),
        "rules": rows("SELECT * FROM camera_schedules WHERE camera_id=? ORDER BY weekday", (camera_id,)),
        "holidays": rows("SELECT * FROM holidays ORDER BY date"),
    })


@app.post("/api/cameras/<int:camera_id>/schedule")
@admin_required
def api_set_schedule(camera_id: int):
    data = request.get_json(silent=True) or {}
    rules = data.get("rules") or []
    if not isinstance(rules, list):
        return jsonify({"error": "invalid rules"}), 400
    db = get_db()
    db.execute("DELETE FROM camera_schedules WHERE camera_id=?", (camera_id,))
    for rule in rules:
        try:
            weekday = int(rule.get("weekday"))
        except (TypeError, ValueError):
            continue
        if weekday not in range(1, 8) or not rule.get("enabled", True):
            continue
        arm = str(rule.get("arm_time") or "")
        disarm = str(rule.get("disarm_time") or "")
        if _parse_hhmm(arm) is None or _parse_hhmm(disarm) is None:
            continue
        db.execute(
            "INSERT OR REPLACE INTO camera_schedules (camera_id, weekday, arm_time, disarm_time, enabled) "
            "VALUES (?, ?, ?, ?, 1)",
            (camera_id, weekday, arm, disarm),
        )
    alarm_types = data.get("alarm_types")
    if isinstance(alarm_types, list):
        allowed = sorted({str(x).lower() for x in alarm_types if str(x).lower() in ALARM_TYPES})
        db.execute(
            "UPDATE cameras SET alarm_types_json=? WHERE id=?",
            (json.dumps(allowed), camera_id),
        )
    db.execute(
        "UPDATE cameras SET guard_schedule_enabled=? WHERE id=?",
        (1 if data.get("enabled") else 0, camera_id),
    )
    db.commit()
    return jsonify({"ok": True})


@app.get("/api/holidays")
@login_required
def api_holidays():
    return jsonify({"holidays": rows("SELECT * FROM holidays ORDER BY date")})


@app.post("/api/holidays")
@admin_required
def api_add_holiday():
    data = request.get_json(silent=True) or {}
    date = str(data.get("date") or "").strip()
    name = str(data.get("name") or "").strip()
    try:
        from datetime import datetime as _dt
        _dt.strptime(date, "%Y-%m-%d")
    except ValueError:
        return jsonify({"error": "invalid date"}), 400
    get_db().execute(
        "INSERT OR REPLACE INTO holidays (date, name, enabled) VALUES (?, ?, 1)",
        (date, name),
    )
    get_db().commit()
    return jsonify({"ok": True})


@app.delete("/api/holidays/<int:holiday_id>")
@admin_required
def api_delete_holiday(holiday_id: int):
    get_db().execute("DELETE FROM holidays WHERE id=?", (holiday_id,))
    get_db().commit()
    return jsonify({"ok": True})


@app.post("/api/cameras/<int:camera_id>/arm")
@admin_required
def api_arm_camera(camera_id: int):
    data = request.get_json(silent=True) or {}
    armed = 1 if data.get("armed") else 0
    get_db().execute("UPDATE cameras SET armed=? WHERE id=?", (armed, camera_id))
    get_db().commit()
    return jsonify({"ok": True, "armed": bool(armed)})


@app.route("/api/cameras/<int:camera_id>/position", methods=["POST"])
@admin_required
def api_position(camera_id: int):
    data = request.get_json(silent=True) or {}
    try:
        x = max(0.0, min(100.0, float(data.get("x"))))
        y = max(0.0, min(100.0, float(data.get("y"))))
        angle = float(data.get("angle", 0))
        fov = max(10.0, min(180.0, float(data.get("fov", 70))))
        view_range = max(5.0, min(100.0, float(data.get("view_range", 35))))
    except (TypeError, ValueError):
        return jsonify({"error": "invalid position"}), 400
    get_db().execute(
        "UPDATE cameras SET x=?, y=?, angle=?, fov=?, view_range=?, placed=1 WHERE id=?",
        (x, y, angle, fov, view_range, camera_id),
    )
    get_db().commit()
    return jsonify({"ok": True})


@app.route("/api/cameras", methods=["POST"])
@admin_required
def api_add_camera():
    data = request.get_json(silent=True) or {}
    ref = str(data.get("camera_ref") or "").strip()
    name = str(data.get("name") or ref).strip()
    floor_id = int(data.get("floor_id") or _default_floor_id())
    if not ref:
        return jsonify({"error": "camera_ref required"}), 400
    camera = _camera_for_ref(ref, name, data.get("source_url") or get_streamer_url() or "manual", floor_id)
    get_db().execute("UPDATE cameras SET placed=1 WHERE id=?", (camera["id"],))
    get_db().commit()
    return jsonify({"ok": True})


@app.route("/api/cameras/<int:camera_id>", methods=["DELETE"])
@admin_required
def api_delete_camera(camera_id: int):
    get_db().execute("DELETE FROM cameras WHERE id=?", (camera_id,))
    get_db().commit()
    return jsonify({"ok": True})


# ----------------------------------------------------------------------
# Планы, здания, этажи
# ----------------------------------------------------------------------
@app.route("/plans/<path:filename>")
@login_required
def plan_file(filename):
    return send_from_directory(PLAN_DIR, filename)


@app.post("/api/floors/<int:floor_id>/walls")
@admin_required
def api_floor_walls(floor_id: int):
    payload = request.get_json(silent=True) or {}
    walls = payload.get("walls")
    if not isinstance(walls, list) or len(walls) > 200:
        return jsonify({"error": "invalid walls"}), 400
    clean = []
    for wall in walls:
        if not isinstance(wall, (list, tuple)) or len(wall) != 4:
            return jsonify({"error": "wall must be [x1,y1,x2,y2]"}), 400
        try:
            x1, y1, x2, y2 = [max(0.0, min(100.0, float(v))) for v in wall]
        except (TypeError, ValueError):
            return jsonify({"error": "wall must be numeric"}), 400
        if abs(x1 - x2) + abs(y1 - y2) >= 0.5:
            clean.append([round(x1, 2), round(y1, 2), round(x2, 2), round(y2, 2)])
    get_db().execute("UPDATE floors SET walls_json=? WHERE id=?", (json.dumps(clean), floor_id))
    get_db().commit()
    return jsonify({"ok": True, "walls": clean})


@app.route("/settings")
@admin_required
def settings():
    buildings = rows("SELECT * FROM buildings ORDER BY id")
    floors = rows(
        "SELECT f.*, b.name AS building_name FROM floors f "
        "JOIN buildings b ON b.id=f.building_id ORDER BY b.id, f.level"
    )
    cameras = rows(
        "SELECT c.*, f.name AS floor_name, f.building_id AS building_id, z.name AS zone_name FROM cameras c "
        "JOIN floors f ON f.id=c.floor_id LEFT JOIN zones z ON z.id=c.zone_id "
        "ORDER BY c.name"
    )
    users = rows("SELECT id, username, role, active, created_at FROM users ORDER BY id")
    holidays = rows("SELECT * FROM holidays ORDER BY date")
    zones = rows(
        "SELECT z.*, (SELECT COUNT(*) FROM cameras c WHERE c.zone_id=z.id) AS camera_count "
        "FROM zones z ORDER BY z.floor_id, z.name"
    )
    notify = notifications.load_settings()
    jobs = rows(
        "SELECT j.*, a.title AS alarm_title FROM notification_jobs j "
        "LEFT JOIN alarms a ON a.id=j.alarm_id ORDER BY j.created_at DESC LIMIT 100"
    )
    geo_provider = get_app_setting("geo_map_provider", GEO_MAP_PROVIDER)
    yandex_key = get_app_setting("yandex_maps_api_key", YANDEX_MAPS_API_KEY)
    return render_template(
        "settings.html", buildings=buildings, floors=floors, cameras=cameras,
        users=users, holidays=holidays, zones=zones, notify=notify, jobs=jobs,
        current_year=time.localtime().tm_year,
        geo_provider=geo_provider, yandex_key=yandex_key,
    )


@app.post("/settings/notifications")
@admin_required
def save_notification_settings():
    keys = (
        "telegram_bot_token", "telegram_chat_id", "max_bot_token", "max_chat_id",
        "max_webhook_url", "webhook_url", "webhook_secret", "gsm_phone",
        "gsm_com_port", "gsm_baud", "message_template", "sms_template",
        "voice_cooldown_sec", "voice_delay_sec", "voice_ring_seconds",
    )
    values = {key: request.form.get(key, "") for key in keys}
    values["message_template"] = values["message_template"].strip() or (
        "🚨 VHS-Security: {title}\nЗона: {zone}\nКамера: {camera}\nТип: {type}\nВремя: {time}"
    )
    values["sms_template"] = values["sms_template"].strip() or (
        "Тревога: {title}. Зона: {zone}. Камера: {camera}. {time}"
    )
    values["voice_delay_sec"] = values["voice_delay_sec"] or "60"
    values["voice_cooldown_sec"] = values["voice_cooldown_sec"] or "300"
    values["voice_ring_seconds"] = values["voice_ring_seconds"] or "15"
    for key in ("notify_enabled", "gsm_enabled", "sms_enabled", "voice_enabled"):
        values[key] = "1" if request.form.get(key) else "0"
    notifications.save_settings(values)
    return redirect(url_for("settings"))


@app.post("/settings/notifications/test")
@admin_required
def test_notification():
    channel = request.form.get("channel", "sms")
    notifications.enqueue_test(channel, "Тест VHS-Security")
    return redirect(url_for("settings"))


@app.get("/api/gsm/status")
@admin_required
def api_gsm_status():
    return jsonify(notifications.gsm_status())


@app.post("/settings/buildings/<int:building_id>/edit")
@admin_required
def edit_building(building_id: int):
    name = request.form.get("name", "").strip()
    address = request.form.get("address", "").strip()
    kind = request.form.get("kind", "building")
    if kind not in ("building", "territory"):
        kind = "building"
    try:
        center_lat = float(request.form.get("center_lat") or 55.751244)
        center_lon = float(request.form.get("center_lon") or 37.618423)
        geo_zoom = int(request.form.get("geo_zoom") or 16)
    except ValueError:
        center_lat, center_lon, geo_zoom = 55.751244, 37.618423, 16
    if name:
        get_db().execute(
            "UPDATE buildings SET name=?, address=?, kind=?, center_lat=?, center_lon=?, geo_zoom=? WHERE id=?",
            (name, address, kind, center_lat, center_lon, max(2, min(20, geo_zoom)), building_id),
        )
        if kind == "territory":
            has_floor = get_db().execute(
                "SELECT 1 FROM floors WHERE building_id=? LIMIT 1", (building_id,)
            ).fetchone()
            if not has_floor:
                get_db().execute(
                    "INSERT INTO floors (building_id, name, level) VALUES (?, 'Территория', 0)",
                    (building_id,),
                )
        get_db().commit()
    return redirect(url_for("settings"))


@app.post("/settings/buildings/<int:building_id>/delete")
@admin_required
def delete_building(building_id: int):
    db = get_db()
    count = db.execute("SELECT COUNT(*) AS n FROM buildings").fetchone()["n"]
    if count <= 1:
        return redirect(url_for("settings", building_error="last"))
    db.execute("DELETE FROM buildings WHERE id=?", (building_id,))
    db.commit()
    return redirect(url_for("settings"))


@app.post("/settings/zones")
@admin_required
def add_zone_page():
    name = request.form.get("name", "").strip()
    floor_id = request.form.get("floor_id", type=int)
    if name and floor_id:
        get_db().execute(
            "INSERT INTO zones (floor_id, name, armed, schedule_enabled, created_at) VALUES (?, ?, 0, 0, ?)",
            (floor_id, name, time.time()),
        )
        get_db().commit()
    return redirect(url_for("settings"))


@app.post("/settings/cameras/<int:camera_id>/zone")
@admin_required
def assign_camera_zone(camera_id: int):
    zone_id = request.form.get("zone_id", type=int)
    if zone_id:
        get_db().execute("UPDATE cameras SET zone_id=? WHERE id=?", (zone_id, camera_id))
        get_db().commit()
    return redirect(url_for("settings"))


@app.post("/settings/holidays")
@admin_required
def add_holiday_page():
    date = request.form.get("date", "").strip()
    name = request.form.get("name", "").strip()
    try:
        from datetime import datetime as _dt
        _dt.strptime(date, "%Y-%m-%d")
    except ValueError:
        return redirect(url_for("settings"))
    get_db().execute(
        "INSERT OR REPLACE INTO holidays (date, name, enabled) VALUES (?, ?, 1)",
        (date, name),
    )
    get_db().commit()
    return redirect(url_for("settings"))


@app.post("/settings/holidays/import")
@admin_required
def import_holidays():
    from datetime import date, datetime, timedelta

    year = request.form.get("year", type=int) or datetime.now().year
    imported = 0
    db = get_db()
    try:
        response = requests.get(
            f"https://date.nager.at/api/v3/PublicHolidays/{year}/RU",
            timeout=10,
        )
        response.raise_for_status()
        for item in response.json():
            value = str(item.get("date") or "")
            name = str(item.get("localName") or item.get("name") or "Праздник")
            if len(value) != 10:
                continue
            cursor = db.execute(
                "INSERT OR IGNORE INTO holidays (date, name, enabled) VALUES (?, ?, 1)",
                (value, name),
            )
            imported += cursor.rowcount
    except Exception:
        # Резерв: isdayoff.ru, без названий.
        try:
            response = requests.get(
                "https://isdayoff.ru/api/getdata",
                params={"year": year, "cc": "ru"},
                timeout=10,
            )
            response.raise_for_status()
            data = response.text.strip()
            if len(data) in (365, 366) and set(data) <= set("012"):
                current = date(year, 1, 1)
                for index, flag in enumerate(data):
                    if flag == "1":
                        cursor = db.execute(
                            "INSERT OR IGNORE INTO holidays (date, name, enabled) VALUES (?, ?, 1)",
                            (current.isoformat(), "Праздничный день"),
                        )
                        imported += cursor.rowcount
                    current += timedelta(days=1)
        except Exception:
            imported = 0
    db.commit()
    return redirect(url_for("settings", imported=imported))


@app.post("/settings/holidays/<int:holiday_id>/delete")
@admin_required
def delete_holiday_page(holiday_id: int):
    get_db().execute("DELETE FROM holidays WHERE id=?", (holiday_id,))
    get_db().commit()
    return redirect(url_for("settings"))


@app.post("/settings/users")
@admin_required
def add_user():
    username = request.form.get("username", "").strip()
    password = request.form.get("password", "")
    role = request.form.get("role", "viewer")
    if not username or len(password) < 4 or role not in ("viewer", "admin"):
        return redirect(url_for("settings"))
    try:
        get_db().execute(
            "INSERT INTO users (username, password_hash, role, active, created_at) VALUES (?, ?, ?, 1, ?)",
            (username, generate_password_hash(password), role, time.time()),
        )
        get_db().commit()
    except sqlite3.IntegrityError:
        pass
    return redirect(url_for("settings"))


@app.post("/settings/users/<int:user_id>/delete")
@admin_required
def delete_user(user_id: int):
    get_db().execute("DELETE FROM users WHERE id=?", (user_id,))
    get_db().commit()
    return redirect(url_for("settings"))


@app.route("/settings/building", methods=["POST"])
@admin_required
def add_building():
    name = request.form.get("name", "").strip()
    address = request.form.get("address", "").strip()
    kind = request.form.get("kind", "building")
    if kind not in ("building", "territory"):
        kind = "building"
    try:
        center_lat = float(request.form.get("center_lat") or 55.751244)
        center_lon = float(request.form.get("center_lon") or 37.618423)
        geo_zoom = int(request.form.get("geo_zoom") or 16)
    except ValueError:
        center_lat, center_lon, geo_zoom = 55.751244, 37.618423, 16
    if name:
        db = get_db()
        db.execute(
            "INSERT INTO buildings (name, address, kind, center_lat, center_lon, geo_zoom) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (name, address, kind, center_lat, center_lon, max(2, min(20, geo_zoom))),
        )
        building_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        if kind == "territory":
            db.execute(
                "INSERT INTO floors (building_id, name, level) VALUES (?, 'Территория', 0)",
                (building_id,),
            )
        db.commit()
    return redirect(url_for("settings"))


@app.route("/settings/floor", methods=["POST"])
@admin_required
def add_floor():
    building_id = request.form.get("building_id", type=int)
    name = request.form.get("name", "").strip()
    level = request.form.get("level", type=int) or 1
    if building_id and name:
        get_db().execute(
            "INSERT INTO floors (building_id, name, level) VALUES (?, ?, ?)",
            (building_id, name, level),
        )
        get_db().commit()
    return redirect(url_for("settings"))


@app.route("/settings/floor/<int:floor_id>/plan", methods=["POST"])
@admin_required
def upload_plan(floor_id: int):
    file = request.files.get("plan")
    if not file or not file.filename:
        return redirect(url_for("settings"))
    ext = Path(file.filename).suffix.lower()
    if ext not in (".png", ".jpg", ".jpeg", ".webp", ".svg"):
        abort(400)
    filename = f"{floor_id}-{uuid.uuid4().hex}{ext}"
    file.save(PLAN_DIR / filename)
    get_db().execute("UPDATE floors SET plan_filename=? WHERE id=?", (filename, floor_id))
    get_db().commit()
    return redirect(url_for("settings"))


@app.route("/about")
@login_required
def about():
    return render_template(
        "about.html", name=APP_NAME, version=__version__, author=__author__,
        copyright=__copyright__, license=__license__, url=__url__,
    )


def ensure_viewer_stream_urls():
    """Обновить пустые stream_url из Viewer без ручной синхронизации."""
    db = get_db()
    empty = db.execute(
        "SELECT COUNT(*) AS n FROM cameras WHERE stream_url IS NULL OR stream_url=''"
    ).fetchone()["n"]
    if not empty or not get_viewer_url() or not INGEST_TOKEN:
        return
    try:
        response = requests.get(
            f"{get_viewer_url()}/api/integration/state",
            headers={"X-Ingest-Token": INGEST_TOKEN}, timeout=8,
        )
        response.raise_for_status()
        for item in response.json().get("cameras", []):
            ref = str(item.get("id") or "").strip()
            streams = item.get("streams") or []
            url = str(streams[0].get("url") or "") if streams else ""
            if ref and url:
                name = str(item.get("name") or "")
                db.execute(
                    "UPDATE cameras SET stream_url=? WHERE camera_ref=? OR name=?",
                    (url, ref, name),
                )
        db.commit()
    except Exception:
        pass


@app.route("/favicon.ico")
def favicon():
    return send_from_directory(app.static_folder, "favicon.ico", mimetype="image/x-icon")


@app.route("/")
@login_required
def index():
    return render_template("index.html")


@app.route("/map-setup")
@admin_required
def map_setup_page():
    return render_template(
        "map_setup.html",
        geo_provider=get_app_setting("geo_map_provider", GEO_MAP_PROVIDER),
        yandex_key=get_app_setting("yandex_maps_api_key", YANDEX_MAPS_API_KEY),
    )


@app.post("/settings/maps")
@admin_required
def save_map_settings():
    provider = request.form.get("geo_map_provider", "leaflet")
    if provider not in ("leaflet", "yandex"):
        provider = "leaflet"
    key = request.form.get("yandex_maps_api_key", "").strip()
    db = get_db()
    for name, value in (("geo_map_provider", provider), ("yandex_maps_api_key", key)):
        db.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (name, value),
        )
    db.commit()
    return redirect(url_for("settings"))


@app.get("/api/map-setup")
@admin_required
def api_map_setup():
    buildings = rows("SELECT * FROM buildings ORDER BY name")
    floors = rows(
        "SELECT f.*, b.name AS building_name FROM floors f "
        "JOIN buildings b ON b.id=f.building_id ORDER BY b.name, f.level, f.name"
    )
    for floor in floors:
        floor["plan_url"] = url_for("plan_file", filename=floor["plan_filename"]) if floor["plan_filename"] else ""
        try:
            floor["walls"] = json.loads(floor.get("walls_json") or "[]")
        except ValueError:
            floor["walls"] = []
    cameras = rows(
        "SELECT c.*, f.name AS floor_name, f.building_id AS building_id, "
        "b.name AS building_name, z.name AS zone_name "
        "FROM cameras c JOIN floors f ON f.id=c.floor_id "
        "JOIN buildings b ON b.id=f.building_id "
        "LEFT JOIN zones z ON z.id=c.zone_id ORDER BY b.name, f.level, c.name"
    )
    zones = rows(
        "SELECT z.*, f.name AS floor_name, f.building_id AS building_id, b.name AS building_name "
        "FROM zones z JOIN floors f ON f.id=z.floor_id JOIN buildings b ON b.id=f.building_id "
        "ORDER BY b.name, f.level, z.name"
    )
    for zone in zones:
        try:
            zone["points"] = json.loads(zone.get("geometry_json") or "[]")
        except ValueError:
            zone["points"] = []
    footprints = rows(
        "SELECT tb.*, b.name AS territory_name FROM territory_buildings tb "
        "JOIN buildings b ON b.id=tb.territory_id ORDER BY tb.id"
    )
    for footprint in footprints:
        try:
            footprint["points"] = json.loads(footprint.get("points_json") or "[]")
        except ValueError:
            footprint["points"] = []
    return jsonify({
        "buildings": buildings, "floors": floors, "cameras": cameras,
        "zones": zones, "footprints": footprints,
    })


def _point_in_polygon(x: float, y: float, points: list) -> bool:
    inside = False
    j = len(points) - 1
    for i, point in enumerate(points):
        try:
            xi, yi = float(point[0]), float(point[1])
            xj, yj = float(points[j][0]), float(points[j][1])
        except (TypeError, ValueError, IndexError):
            j = i
            continue
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-9) + xi:
            inside = not inside
        j = i
    return inside


@app.post("/api/floors/<int:floor_id>/zones")
@admin_required
def api_create_zone(floor_id: int):
    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()
    points = data.get("points") or []
    if not name or not isinstance(points, list) or len(points) < 3:
        return jsonify({"error": "нужно имя и минимум 3 точки"}), 400
    clean = []
    for point in points:
        try:
            clean.append([max(0.0, min(100.0, float(point[0]))), max(0.0, min(100.0, float(point[1])))])
        except (TypeError, ValueError, IndexError):
            continue
    if len(clean) < 3:
        return jsonify({"error": "некорректный контур"}), 400
    if not one("SELECT * FROM floors WHERE id=?", (floor_id,)):
        return jsonify({"error": "этаж не найден"}), 404
    db = get_db()
    db.execute(
        "INSERT INTO zones (floor_id, name, geometry_json, armed, schedule_enabled, created_at) "
        "VALUES (?, ?, ?, 0, 0, ?)",
        (floor_id, name, json.dumps(clean), time.time()),
    )
    zone_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    db.commit()
    return jsonify({"ok": True, "zone_id": zone_id, "id": zone_id, "name": name, "points": clean})


@app.post("/api/buildings/<int:territory_id>/footprints")
@admin_required
def api_add_footprint(territory_id: int):
    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()
    points = data.get("points") or []
    if not name or not isinstance(points, list) or len(points) < 3:
        return jsonify({"error": "нужно имя и минимум 3 точки"}), 400
    clean = []
    for point in points:
        try:
            lat, lon = float(point[0]), float(point[1])
        except (TypeError, ValueError, IndexError):
            continue
        if -90 <= lat <= 90 and -180 <= lon <= 180:
            clean.append([lat, lon])
    if len(clean) < 3:
        return jsonify({"error": "некорректный контур"}), 400
    if not one("SELECT * FROM buildings WHERE id=?", (territory_id,)):
        return jsonify({"error": "объект не найден"}), 404
    db = get_db()
    db.execute(
        "INSERT INTO territory_buildings (territory_id, name, points_json, created_at) VALUES (?, ?, ?, ?)",
        (territory_id, name, json.dumps(clean), time.time()),
    )
    footprint_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    db.commit()
    return jsonify({"ok": True, "id": footprint_id, "name": name, "points": clean})


@app.delete("/api/buildings/<int:territory_id>/footprints/<int:footprint_id>")
@admin_required
def api_delete_footprint(territory_id: int, footprint_id: int):
    get_db().execute(
        "DELETE FROM territory_buildings WHERE id=? AND territory_id=?",
        (footprint_id, territory_id),
    )
    get_db().commit()
    return jsonify({"ok": True})


@app.post("/api/cameras/<int:camera_id>/place")
@admin_required
def api_place_camera(camera_id: int):
    data = request.get_json(silent=True) or {}
    try:
        floor_id = int(data.get("floor_id"))
        x = max(0.0, min(100.0, float(data.get("x"))))
        y = max(0.0, min(100.0, float(data.get("y"))))
    except (TypeError, ValueError):
        return jsonify({"error": "floor_id, x, y обязательны"}), 400
    floor = one("SELECT * FROM floors WHERE id=?", (floor_id,))
    camera = one("SELECT * FROM cameras WHERE id=?", (camera_id,))
    if not floor or not camera:
        return jsonify({"error": "камера или этаж не найдены"}), 404
    if camera.get("placed") and str(camera.get("floor_id")) != str(floor_id):
        return jsonify({"error": "Камера уже установлена на другом этаже. Сначала снимите её с карты."}), 409
    zone_id = data.get("zone_id")
    warning = ""
    if zone_id:
        try:
            zone_id = int(zone_id)
        except (TypeError, ValueError):
            zone_id = None
    if zone_id:
        zone = one("SELECT * FROM zones WHERE id=? AND floor_id=?", (zone_id, floor_id))
        if not zone:
            zone_id = None
        else:
            try:
                points = json.loads(zone.get("geometry_json") or "[]")
            except ValueError:
                points = []
            if len(points) >= 3 and not _point_in_polygon(x, y, points):
                warning = f"Камера вне контура зоны «{zone['name']}»."
    get_db().execute(
        "UPDATE cameras SET floor_id=?, x=?, y=?, zone_id=?, placed=1 WHERE id=?",
        (floor_id, x, y, zone_id, camera_id),
    )
    get_db().commit()
    return jsonify({"ok": True, "camera_id": camera_id, "floor_id": floor_id, "x": x, "y": y, "zone_id": zone_id, "warning": warning})


@app.post("/api/cameras/<int:camera_id>/unplace")
@admin_required
def api_unplace_camera(camera_id: int):
    camera = one("SELECT * FROM cameras WHERE id=?", (camera_id,))
    if not camera:
        return jsonify({"error": "камера не найдена"}), 404
    get_db().execute("UPDATE cameras SET placed=0 WHERE id=?", (camera_id,))
    get_db().commit()
    return jsonify({"ok": True})


@app.post("/api/cameras/<int:camera_id>/place-geo")
@admin_required
def api_place_camera_geo(camera_id: int):
    data = request.get_json(silent=True) or {}
    try:
        floor_id = int(data.get("floor_id"))
        lat = float(data.get("lat"))
        lon = float(data.get("lon"))
        azimuth = float(data.get("azimuth", 0))
        fov = float(data.get("fov", 60))
        range_m = float(data.get("range_m", 80))
    except (TypeError, ValueError):
        return jsonify({"error": "floor_id, lat, lon обязательны"}), 400
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return jsonify({"error": "некорректные координаты"}), 400
    floor = one("SELECT * FROM floors WHERE id=?", (floor_id,))
    camera = one("SELECT * FROM cameras WHERE id=?", (camera_id,))
    if not floor or not camera:
        return jsonify({"error": "камера или объект не найдены"}), 404
    get_db().execute(
        "UPDATE cameras SET floor_id=?, geo_lat=?, geo_lon=?, geo_azimuth=?, "
        "geo_fov=?, geo_range_m=? WHERE id=?",
        (floor_id, lat, lon, azimuth, max(5, min(180, fov)), max(5, min(2000, range_m)), camera_id),
    )
    get_db().commit()
    return jsonify({"ok": True, "camera_id": camera_id, "floor_id": floor_id, "lat": lat, "lon": lon})


@app.post("/api/cameras/<int:camera_id>/geo-view")
@admin_required
def api_set_camera_geo_view(camera_id: int):
    data = request.get_json(silent=True) or {}
    try:
        azimuth = float(data.get("azimuth", 0))
        fov = float(data.get("fov", 60))
        range_m = float(data.get("range_m", 80))
    except (TypeError, ValueError):
        return jsonify({"error": "некорректные параметры"}), 400
    get_db().execute(
        "UPDATE cameras SET geo_azimuth=?, geo_fov=?, geo_range_m=? WHERE id=?",
        (azimuth, max(5, min(180, fov)), max(5, min(2000, range_m)), camera_id),
    )
    get_db().commit()
    return jsonify({"ok": True})


@app.route("/mosaic")
@login_required
def mosaic_page():
    return render_template("mosaic.html")


@app.post("/api/whep")
@login_required
def api_whep():
    data = request.get_json(silent=True) or {}
    stream_url = str(data.get("url") or "").strip()
    sdp = str(data.get("sdp") or "")
    if not stream_url or not sdp:
        return jsonify({"ok": False, "error": "url и sdp обязательны"}), 400
    try:
        parsed = urlparse(stream_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError("некорректный URL")
        whep_url = parsed.origin if hasattr(parsed, "origin") else f"{parsed.scheme}://{parsed.netloc}"
        whep_url = whep_url.rstrip("/") + parsed.path.rstrip("/") + "/whep"
        headers = {"Content-Type": "application/sdp", "Accept": "application/sdp"}
        if parsed.username or parsed.password:
            credentials = f"{parsed.username or ''}:{parsed.password or ''}"
            headers["Authorization"] = "Basic " + __import__("base64").b64encode(
                credentials.encode("utf-8")
            ).decode("ascii")
        response = requests.post(whep_url, data=sdp.encode("utf-8"), headers=headers, timeout=15)
        if not response.ok:
            return jsonify({
                "ok": False,
                "error": f"MediaMTX WHEP HTTP {response.status_code}: {response.text[:200]}",
            }), 502
        return jsonify({"ok": True, "sdp": response.text})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502


@app.get("/api/mosaic")
@login_required
def api_mosaic():
    ensure_viewer_stream_urls()
    rows_data = rows(
        "SELECT c.*, f.name AS floor_name, f.level AS floor_level, "
        "f.building_id AS building_id, b.name AS building_name, "
        "z.name AS zone_name, z.armed AS zone_armed, z.schedule_enabled AS zone_schedule_enabled, "
        "z.holiday_mode AS zone_holiday_mode, "
        "(SELECT MAX(e.ts) FROM events e WHERE e.camera_id=c.id) AS last_event_ts, "
        "(SELECT COUNT(*) FROM alarms a WHERE a.camera_id=c.id AND a.status='active') AS active_alarms "
        "FROM cameras c JOIN floors f ON f.id=c.floor_id JOIN buildings b ON b.id=f.building_id "
        "LEFT JOIN zones z ON z.id=c.zone_id "
        "WHERE c.enabled=1 AND c.placed=1 ORDER BY b.name, f.level, f.name, c.name"
    )
    cameras = []
    for camera in rows_data:
        zone = one("SELECT * FROM zones WHERE id=?", (camera.get("zone_id"),)) if camera.get("zone_id") else None
        camera["effective_armed"] = _zone_effective(zone) if zone else bool(camera.get("armed"))
        camera["active_alarm"] = bool(camera.get("active_alarms"))
        camera["last_event_ts"] = camera.get("last_event_ts") or 0
        cameras.append(camera)
    return jsonify({"cameras": cameras})


def _ingest_viewer_event(ev: dict, floor_id: int | None = None):
    cam_ref = str(ev.get("camera_id") or "").strip()
    if not cam_ref:
        return None
    cam = _camera_for_ref(cam_ref, ev.get("camera_name") or cam_ref, get_viewer_url() or "viewer", floor_id or _default_floor_id())
    category = str(ev.get("category") or "object")
    label = ev.get("label") or ev.get("plate") or "объект"
    plate = str(ev.get("plate") or "")
    snapshot = ev.get("snapshot") or ""
    snapshot_url = f"{get_viewer_url()}/snapshot/{snapshot}" if get_viewer_url() and snapshot else ""
    ts = ev.get("ts") or time.time()
    external = f"viewer:{ts}:{cam_ref}:{label}"
    title = {
        "plate": f"Номер {plate or label}",
        "person": "Обнаружен человек",
        "vehicle": "Обнаружен транспорт",
        "animal": "Обнаружено животное",
    }.get(category, f"Объект: {label}")
    event_id = _insert_event(
        cam["id"], "viewer", external, category, title, ts,
        "warning" if category in ("plate", "person") else "info",
        description=f"Уверенность: {round(float(ev.get('confidence', 0)) * 100)}%",
        plate=plate, snapshot_url=snapshot_url, metadata=ev,
    )
    if event_id:
        _evaluate_alarm(event_id, cam, category, title, ts, ev)
    return cam["id"]


@app.post("/api/integrations/viewer/events")
def viewer_event_ingest():
    """Приём событий от VHS-Viewer (machine-to-machine, X-Ingest-Token)."""
    if not INGEST_TOKEN:
        return jsonify({"error": "ingest disabled"}), 503
    token = request.headers.get("X-Ingest-Token", "")
    if not hmac.compare_digest(token, INGEST_TOKEN):
        return jsonify({"error": "unauthorized"}), 401
    payload = request.get_json(silent=True) or {}
    events = payload if isinstance(payload, list) else payload.get("events", [payload])
    accepted = 0
    for ev in events:
        if isinstance(ev, dict) and _ingest_viewer_event(ev) is not None:
            accepted += 1
    return jsonify({"ok": True, "accepted": accepted})


with app.app_context():
    init_db()
    cleanup_phantom_zones()
notifications.configure(DB_PATH)




@app.route("/api/integration/info")
def integration_info():
    return jsonify({
        "app": "VHS-Security",
        "version": __version__,
        "role": "security",
        "capabilities": ["map", "events", "alpr", "ack"],
    })


@app.post("/api/discovery/viewers")
@admin_required
def api_discover_viewers():
    payload = request.get_json(silent=True) or {}
    subnet = str(payload.get("subnet") or "").strip() or None
    if subnet:
        try:
            ipaddress.ip_network(subnet, strict=False)
        except ValueError:
            return jsonify({"error": "invalid subnet"}), 400
    network, found = discover_viewers(subnet)
    return jsonify({"network": network, "viewers": found, "current": get_viewer_url()})


@app.post("/api/discovery/use-viewer")
@admin_required
def api_use_viewer():
    payload = request.get_json(silent=True) or {}
    url = str(payload.get("url") or "").strip().rstrip("/")
    if not url:
        return jsonify({"error": "url required"}), 400
    probed = _probe_viewer(url)
    if not probed:
        return jsonify({"error": "VHS-Viewer not found at this URL"}), 400
    set_viewer_url(url)
    return jsonify({"ok": True, "viewer": probed})


@app.route("/system")
@login_required
def system_page():
    modules = [
        {"name": "VHS-Viewer", "role": "Камеры, потоки, ALPR и события", "url": get_viewer_url()},
    ]
    for module in modules:
        module["online"] = None
        if module["url"]:
            try:
                module["online"] = requests.get(
                    module["url"].rstrip("/") + "/api/integration/info", timeout=2
                ).ok
            except requests.RequestException:
                module["online"] = False
    return render_template("system.html", modules=modules)


if __name__ == "__main__":
    app.run(
        host=os.environ.get("VHS_SECURITY_HOST", "127.0.0.1"),
        port=int(os.environ.get("VHS_SECURITY_PORT", "8300")),
        debug=os.environ.get("VHS_SECURITY_DEBUG", "0") == "1",
    )

