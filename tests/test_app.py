import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

TMP = tempfile.mkdtemp(prefix="vhs-security-test-")
os.environ["VHS_SECURITY_DATA"] = TMP
os.environ["VHS_SECURITY_USER"] = "admin"
os.environ["VHS_SECURITY_PASSWORD"] = "test-password"
os.environ["SECRET_KEY"] = "test-secret-key"
os.environ["STREAMER_URL"] = "http://streamer.test"
os.environ["VIEWER_EVENTS_PATH"] = ""
os.environ["VIEWER_URL"] = "http://viewer.test"
os.environ["VHS_SECURITY_INGEST_TOKEN"] = "test-token"

import app as security  # noqa: E402


class FakeResponse:
    status_code = 200

    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class SecurityTests(unittest.TestCase):
    def setUp(self):
        security.app.config.update(TESTING=True)
        with security.app.app_context():
            db = security.get_db()
            db.execute("DELETE FROM events")
            db.execute("DELETE FROM cameras")
            db.execute("DELETE FROM zones")
            db.execute("DELETE FROM holidays")
            db.execute("DELETE FROM camera_schedules")
            db.execute("DELETE FROM floors")
            db.execute("DELETE FROM buildings")
            db.execute("INSERT INTO buildings (name, address) VALUES ('Тест', '')")
            building = db.execute("SELECT last_insert_rowid()").fetchone()[0]
            db.execute("INSERT INTO floors (building_id, name, level) VALUES (?, '1 этаж', 1)", (building,))
            db.commit()
        self.client = security.app.test_client()
        self.login()

    def csrf(self):
        with self.client.session_transaction() as sess:
            return sess.get("_csrf")

    def login(self):
        self.client.get("/login")
        return self.client.post(
            "/login",
            data={"username": "admin", "password": "test-password", "_csrf": self.csrf()},
        )

    def test_login_required(self):
        client = security.app.test_client()
        response = client.get("/api/state")
        self.assertEqual(response.status_code, 401)

    def test_map_and_settings(self):
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertEqual(self.client.get("/settings").status_code, 200)
        state = self.client.get("/api/state")
        self.assertEqual(state.status_code, 200)
        payload = state.get_json()
        self.assertTrue(payload["floor"]["id"])
        self.assertEqual(payload["floor"]["cameras"], [])

    def test_add_camera_and_position(self):
        token = self.csrf()
        response = self.client.post(
            "/api/cameras",
            json={"camera_ref": "cam-01", "name": "Вход"},
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(response.status_code, 200)
        state = self.client.get("/api/state").get_json()
        camera = state["floor"]["cameras"][0]
        response = self.client.post(
            f"/api/cameras/{camera['id']}/position",
            json={"x": 33, "y": 44, "angle": 90, "fov": 80},
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(response.status_code, 200)
        state = self.client.get("/api/state").get_json()
        self.assertAlmostEqual(state["floor"]["cameras"][0]["x"], 33.0)
        self.assertAlmostEqual(state["floor"]["cameras"][0]["y"], 44.0)

    def test_sync_from_streamer(self):
        token = self.csrf()
        def fake_get(url, **kwargs):
            if url.endswith("/api/integration/state"):
                return FakeResponse({
                    "cameras": [{"id": "cam-01", "name": "Вход", "streams": []}],
                    "events": [],
                })
            return FakeResponse({"events": []})
        floor_id = self.client.get("/api/state").get_json()["floor"]["id"]
        with patch.object(security.requests, "get", side_effect=fake_get):
            response = self.client.post(
                "/api/sync", json={"floor_id": floor_id}, headers={"X-CSRF-Token": token}
            )
        self.assertEqual(response.status_code, 200)
        result = response.get_json()
        self.assertEqual(result["cameras"], 1)
        self.assertEqual(result["streamer_events"], 0)
        state = self.client.get("/api/state").get_json()
        self.assertEqual(state["floor"]["cameras"][0]["camera_ref"], "cam-01")
        self.assertEqual(state["floor"]["events"], [])

    def test_stale_streamer_camera_removed(self):
        with security.app.app_context():
            db = security.get_db()
            floor_id = db.execute("SELECT id FROM floors ORDER BY id LIMIT 1").fetchone()[0]
            db.execute(
                "INSERT INTO cameras (camera_ref, source_url, name, floor_id) VALUES (?, ?, ?, ?)",
                ("gone-camera", "http://streamer.test", "Удалённая", floor_id),
            )
            db.commit()
        token = self.csrf()
        def fake_get(url, **kwargs):
            if url.endswith("/api/integration/state"):
                return FakeResponse({
                    "cameras": [{"id": "cam-01", "name": "Вход", "streams": []}],
                    "events": [],
                })
            return FakeResponse({"events": []})
        floor_id = self.client.get("/api/state").get_json()["floor"]["id"]
        with patch.object(security.requests, "get", side_effect=fake_get):
            response = self.client.post(
                "/api/sync", json={"floor_id": floor_id}, headers={"X-CSRF-Token": token}
            )
        self.assertEqual(response.status_code, 200)
        self.assertGreaterEqual(response.get_json()["cameras_removed"], 1)
        with security.app.app_context():
            gone = security.one("SELECT id FROM cameras WHERE camera_ref='gone-camera'")
        self.assertIsNone(gone)

    def test_zone_schedule_effective_state(self):
        from datetime import datetime
        with security.app.app_context():
            db = security.get_db()
            floor_id = db.execute("SELECT id FROM floors LIMIT 1").fetchone()[0]
            db.execute(
                "INSERT INTO zones (floor_id, name, armed, schedule_enabled, created_at) "
                "VALUES (?, 'Зона', 0, 1, 0)",
                (floor_id,),
            )
            zone_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
            db.execute(
                "INSERT INTO zone_schedules (zone_id, weekday, arm_time, disarm_time, enabled) "
                "VALUES (?, 1, '20:00', '08:00', 1)",
                (zone_id,),
            )
            db.commit()
            zone = security.one("SELECT * FROM zones WHERE id=?", (zone_id,))
            monday_late = datetime(2026, 11, 23, 21, 0)
            monday_day = datetime(2026, 11, 23, 12, 0)
            tuesday_early = datetime(2026, 11, 24, 7, 0)
            self.assertTrue(security._zone_effective(zone, monday_late))
            self.assertFalse(security._zone_effective(zone, monday_day))
            self.assertTrue(security._zone_effective(zone, tuesday_early))

    def test_alarm_types_and_holiday_modes(self):
        from datetime import datetime
        with security.app.app_context():
            db = security.get_db()
            floor_id = db.execute("SELECT id FROM floors LIMIT 1").fetchone()[0]
            db.execute(
                "INSERT INTO zones (floor_id, name, armed, schedule_enabled, holiday_mode, "
                "weekend_arm_time, weekend_disarm_time, holiday_arm_time, holiday_disarm_time, created_at) "
                "VALUES (?, 'Зона', 0, 1, 'weekend', '20:00', '08:00', '22:00', '06:00', 0)",
                (floor_id,),
            )
            zone_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
            db.execute(
                "INSERT INTO holidays (date, name, enabled) VALUES ('2026-12-31', 'Новый год', 1)"
            )
            db.execute(
                "INSERT INTO cameras (camera_ref, source_url, name, floor_id, zone_id, "
                "alarm_types_json) VALUES ('test-cam', 'viewer', 'Тест', ?, ?, '[\"animal\"]')",
                (floor_id, zone_id),
            )
            camera_id = db.execute("SELECT id FROM cameras WHERE camera_ref='test-cam'").fetchone()[0]
            db.execute(
                "INSERT INTO events (source, external_key, event_type, title, ts, created_at) "
                "VALUES ('viewer', 'alarm-event', 'animal', 'Животное', 0, 0)"
            )
            event_id = db.execute("SELECT id FROM events WHERE external_key='alarm-event'").fetchone()[0]
            db.execute(
                "INSERT INTO events (source, external_key, event_type, title, ts, created_at) "
                "VALUES ('viewer', 'no-alarm-event', 'person', 'Человек', 0, 0)"
            )
            other_event_id = db.execute("SELECT id FROM events WHERE external_key='no-alarm-event'").fetchone()[0]
            db.commit()
            camera = security.one("SELECT * FROM cameras WHERE id=?", (camera_id,))
            zone = security.one("SELECT * FROM zones WHERE id=?", (zone_id,))
            # 31.12 — праздник, режим «как в выходной»: 21:00 на охране.
            self.assertTrue(security._zone_effective(zone, datetime(2026, 12, 31, 21, 0)))
            # Для проверки типов тревог зона должна быть на охране сейчас.
            db.execute("UPDATE zones SET armed=1, schedule_enabled=0 WHERE id=?", (zone_id,))
            db.commit()
            # Животное включено в типы тревог этой камеры.
            self.assertIsNotNone(
                security._evaluate_alarm(event_id, camera, "animal", "Животное", 0)
            )
            # Другой тип не создаёт тревогу.
            self.assertIsNone(
                security._evaluate_alarm(other_event_id, camera, "person", "Человек", 0)
            )

    def test_clear_events(self):
        with security.app.app_context():
            db = security.get_db()
            db.execute("INSERT INTO events (source, external_key, event_type, title, ts, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                       ("streamer", "clear-me", "motion", "Очистить", 1000.0, 1000.0))
            db.commit()
        response = self.client.post(
            "/api/events/clear",
            json={"floor_id": 1},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(response.status_code, 200)
        self.assertGreaterEqual(response.get_json()["deleted"], 1)
        with security.app.app_context():
            count = security.get_db().execute("SELECT COUNT(*) FROM events").fetchone()[0]
        self.assertEqual(count, 0)

    def test_csrf_required(self):
        response = self.client.post("/api/cameras", json={"camera_ref": "x"})
        self.assertEqual(response.status_code, 403)


if __name__ == "__main__":
    unittest.main()
