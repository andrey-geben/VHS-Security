"""Очередь и отправка уведомлений VHS-Security.

Уведомления создаются только для тревог (alarm). Очередь хранится в SQLite,
поэтому отправка переживает перезапуск. GSM работает через AT-команды и
pyserial; при отсутствии модема ошибка пишется в журнал, сервис не падает.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path

import requests

try:
    import serial
except ImportError:  # pyserial необязателен
    serial = None

_DB_PATH: Path | None = None
_WORKER: threading.Thread | None = None
_LOCK = threading.Lock()

MAX_ATTEMPTS = 5


def configure(db_path):
    global _DB_PATH
    _DB_PATH = Path(db_path)
    start_worker()


def _conn():
    conn = sqlite3.connect(str(_DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def load_settings():
    with _conn() as db:
        return {row["key"]: row["value"] for row in db.execute("SELECT key, value FROM settings")}


def get(key, default=""):
    return load_settings().get(key, default)


def save_settings(values: dict):
    with _conn() as db:
        for key, value in values.items():
            db.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, str(value)),
            )
        db.commit()


def _bool(values, key):
    return str(values.get(key, "0")).lower() in ("1", "true", "yes", "on")


def _recipient(values):
    return values.get("gsm_phone", "").strip()


def _alarm_text(alarm, event, camera, zone, values):
    template = values.get(
        "message_template",
        "🚨 VHS-Security: {title}\nЗона: {zone}\nКамера: {camera}\nТип: {type}\nВремя: {time}",
    )
    try:
        return template.format(
            title=alarm.get("title") or "Тревога",
            zone=zone.get("name") or "—",
            camera=camera.get("name") or "—",
            type=alarm.get("alarm_type") or "—",
            time=datetime.fromtimestamp(alarm.get("created_at") or time.time()).strftime("%d.%m.%Y %H:%M:%S"),
            plate=(event or {}).get("plate") or "",
        )
    except (KeyError, ValueError):
        return f"Тревога: {alarm.get('title') or ''}"


def enqueue_alarm(alarm_id: int):
    """Поставить в очередь уведомления по тревоге. Вызывается из Alarm engine."""
    values = load_settings()
    if not _bool(values, "notify_enabled"):
        return []
    with _conn() as db:
        alarm = db.execute("SELECT * FROM alarms WHERE id=?", (alarm_id,)).fetchone()
        if not alarm:
            return []
        alarm = dict(alarm)
        event = db.execute("SELECT * FROM events WHERE id=?", (alarm.get("event_id"),)).fetchone()
        camera = db.execute("SELECT * FROM cameras WHERE id=?", (alarm.get("camera_id"),)).fetchone()
        zone = None
        if camera and camera["zone_id"]:
            zone = db.execute("SELECT * FROM zones WHERE id=?", (camera["zone_id"],)).fetchone()
        text = _alarm_text(alarm, dict(event) if event else {}, dict(camera) if camera else {}, dict(zone) if zone else {}, values)
        sms_text = values.get("sms_template") or text
        channels = []
        if values.get("telegram_bot_token") and values.get("telegram_chat_id"):
            channels.append(("telegram", values["telegram_chat_id"]))
        if values.get("max_webhook_url") or (values.get("max_bot_token") and values.get("max_chat_id")):
            channels.append(("max", values.get("max_chat_id") or ""))
        if values.get("webhook_url"):
            channels.append(("webhook", values["webhook_url"]))
        if _bool(values, "sms_enabled") and _recipient(values):
            channels.append(("sms", _recipient(values)))
        now = time.time()
        queued = []
        for channel, recipient in channels:
            existing = db.execute(
                "SELECT id FROM notification_jobs WHERE alarm_id=? AND channel=?",
                (alarm_id, channel),
            ).fetchone()
            if existing:
                continue
            cursor = db.execute(
                "INSERT INTO notification_jobs (alarm_id, channel, recipient, text, status, attempts, "
                "next_attempt_at, created_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)",
                (alarm_id, channel, recipient, sms_text if channel == "sms" else text, now, now),
            )
            queued.append((channel, cursor.lastrowid))
        db.commit()
    return queued


def enqueue_test(channel: str, text: str = "Тест VHS-Security"):
    values = load_settings()
    recipients = {
        "telegram": values.get("telegram_chat_id", ""),
        "max": values.get("max_chat_id", ""),
        "webhook": values.get("webhook_url", ""),
        "sms": _recipient(values),
        "voice": _recipient(values),
    }
    channel = channel if channel in recipients else "sms"
    with _conn() as db:
        cursor = db.execute(
            "INSERT INTO notification_jobs (alarm_id, channel, recipient, text, status, attempts, "
            "next_attempt_at, created_at) VALUES (NULL, ?, ?, ?, 'pending', 0, ?, ?)",
            (channel, recipients[channel], text, time.time(), time.time()),
        )
        db.commit()
        return cursor.lastrowid


def _post_json(url, payload, headers=None, timeout=10):
    response = requests.post(url, json=payload, headers=headers or {}, timeout=timeout)
    response.raise_for_status()
    return response.text[:500]


def _gsm_open(values):
    if serial is None:
        raise RuntimeError("pyserial не установлен")
    port = values.get("gsm_com_port", "").strip()
    if not port:
        raise RuntimeError("COM-порт не задан")
    baud = int(values.get("gsm_baud") or 115200)
    return serial.Serial(port, baudrate=baud, timeout=1)


def _at(ser, command, wait=0.7):
    ser.reset_input_buffer()
    ser.write((command + "\r").encode("ascii"))
    time.sleep(wait)
    return ser.read(ser.in_waiting or 1).decode("utf-8", "replace")


def gsm_status():
    values = load_settings()
    try:
        with _gsm_open(values) as ser:
            pin = _at(ser, "AT+CPIN?")
            signal = _at(ser, "AT+CSQ")
            reg = _at(ser, "AT+CREG?")
            return {
                "ok": True,
                "port": values.get("gsm_com_port", ""),
                "pin": pin.strip(),
                "signal": signal.strip(),
                "registration": reg.strip(),
            }
    except Exception as exc:
        return {"ok": False, "error": str(exc), "port": values.get("gsm_com_port", "")}


def _send_sms(values, phone, text):
    if not _bool(values, "gsm_enabled"):
        raise RuntimeError("GSM отключён")
    if not phone:
        raise RuntimeError("Номер телефона не задан")
    with _gsm_open(values) as ser:
        _at(ser, "AT+CMGF=1")
        if any(ord(ch) > 127 for ch in text):
            _at(ser, 'AT+CSCS="UCS2"')
            payload = text.encode("utf-16-be").hex().upper()
        else:
            _at(ser, 'AT+CSCS="GSM"')
            payload = text
        ser.write(f'AT+CMGS="{phone}"\r'.encode("ascii"))
        time.sleep(1)
        ser.write((payload + "\x1a").encode("ascii"))
        time.sleep(8)
        result = ser.read(ser.in_waiting or 1).decode("utf-8", "replace")
        if "ERROR" in result:
            raise RuntimeError(result.strip()[:300])
        return result[:300]


def _send_voice(values, phone):
    if not _bool(values, "voice_enabled"):
        raise RuntimeError("Голосовые звонки отключены")
    if not phone:
        raise RuntimeError("Номер телефона не задан")
    with _gsm_open(values) as ser:
        ser.write(f"ATD{phone};\r".encode("ascii"))
        time.sleep(2)
        # Короткий дозвон; для голосового шлюза этого достаточно.
        time.sleep(float(values.get("voice_ring_seconds") or 15))
        ser.write(b"ATH\r")
        time.sleep(1)
        return "call completed"


def dispatch(job, values):
    channel = job["channel"]
    text = job["text"]
    if channel == "telegram":
        token = values.get("telegram_bot_token", "")
        if not token or not values.get("telegram_chat_id"):
            raise RuntimeError("Telegram не настроен")
        return _post_json(
            f"https://api.telegram.org/bot{token}/sendMessage",
            {"chat_id": values["telegram_chat_id"], "text": text},
        )
    if channel == "max":
        if values.get("max_webhook_url"):
            return _post_json(values["max_webhook_url"], {"text": text, "chat_id": values.get("max_chat_id", "")})
        token = values.get("max_bot_token", "")
        chat_id = values.get("max_chat_id", "")
        if not token:
            raise RuntimeError("MAX не настроен")
        return _post_json(
            f"https://botapi.max.ru/messages?access_token={token}",
            {"chat_id": chat_id, "text": text},
        )
    if channel == "webhook":
        headers = {"Content-Type": "application/json"}
        if values.get("webhook_secret"):
            headers["X-Webhook-Secret"] = values["webhook_secret"]
        return _post_json(values.get("webhook_url", ""), {"text": text, "source": "vhs-security"}, headers)
    if channel == "sms":
        return _send_sms(values, job["recipient"], text)
    if channel == "voice":
        return _send_voice(values, job["recipient"])
    raise RuntimeError(f"Неизвестный канал: {channel}")


def _maybe_enqueue_voice(db, job, values):
    if job["channel"] not in ("telegram", "max", "webhook", "sms") or job["alarm_id"] is None:
        return
    if not (_bool(values, "voice_enabled") and _recipient(values)):
        return
    existing = db.execute(
        "SELECT id FROM notification_jobs WHERE alarm_id=? AND channel='voice'",
        (job["alarm_id"],),
    ).fetchone()
    if existing:
        return
    # Голос — только после успешной доставки в мессенджер/SMS.
    delivered = db.execute(
        "SELECT 1 FROM notification_jobs WHERE alarm_id=? AND channel IN ('telegram','max','webhook','sms') "
        "AND status='sent' LIMIT 1",
        (job["alarm_id"],),
    ).fetchone()
    if not delivered:
        return
    cooldown = int(values.get("voice_cooldown_sec") or 300)
    last = db.execute(
        "SELECT created_at FROM notification_jobs WHERE channel='voice' AND status='sent' "
        "ORDER BY created_at DESC LIMIT 1"
    ).fetchone()
    if last and time.time() - float(last["created_at"]) < cooldown:
        return
    delay = int(values.get("voice_delay_sec") or 60)
    db.execute(
        "INSERT INTO notification_jobs (alarm_id, channel, recipient, text, status, attempts, "
        "next_attempt_at, created_at) VALUES (?, 'voice', ?, ?, 'pending', 0, ?, ?)",
        (job["alarm_id"], _recipient(values), job["text"], time.time() + delay, time.time()),
    )


def process_once():
    values = load_settings()
    with _conn() as db:
        job = db.execute(
            "SELECT * FROM notification_jobs WHERE status IN ('pending','retry') "
            "AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT 1",
            (time.time(),),
        ).fetchone()
        if not job:
            return False
        job = dict(job)
        try:
            detail = dispatch(job, values)
            db.execute(
                "UPDATE notification_jobs SET status='sent', sent_at=?, last_error='' WHERE id=?",
                (time.time(), job["id"]),
            )
            _maybe_enqueue_voice(db, job, values)
        except Exception as exc:
            attempts = int(job.get("attempts") or 0) + 1
            if attempts >= MAX_ATTEMPTS:
                status = "failed"
                next_at = time.time()
            else:
                status = "retry"
                next_at = time.time() + min(3600, 30 * (2 ** attempts))
            db.execute(
                "UPDATE notification_jobs SET status=?, attempts=?, next_attempt_at=?, last_error=? WHERE id=?",
                (status, attempts, next_at, str(exc)[:500], job["id"]),
            )
        db.commit()
    return True


def worker_loop():
    while True:
        try:
            if _DB_PATH and _DB_PATH.exists():
                while process_once():
                    time.sleep(0.2)
        except Exception:
            pass
        time.sleep(5)


def start_worker():
    global _WORKER
    with _LOCK:
        if _WORKER and _WORKER.is_alive():
            return
        _WORKER = threading.Thread(target=worker_loop, name="vhs-notifications", daemon=True)
        _WORKER.start()
