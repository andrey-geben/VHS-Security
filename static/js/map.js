const CSRF = window.CSRF_TOKEN;
const READ_ONLY = window.USER_ROLE !== "admin";
const state = { floorId: null, data: null, busy: false, selectedId: null, selectedEventId: null, highlightEventId: null, highlightCameraId: null, cameraFilter: null, wallMode: false, wallStart: null, wallPreview: null, zoom: 1, panX: 0, panY: 0, panning: null };

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(url, options = {}) {
  const headers = Object.assign({ "X-CSRF-Token": CSRF }, options.headers || {});
  if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) { window.location = "/login"; throw new Error("unauthorized"); }
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function setStatus(text) { $("#status").textContent = text || ""; }
function normAngle(value) { let a = Number(value) || 0; a %= 360; return a < 0 ? a + 360 : a; }
function currentCamera() { return (state.data?.floor?.cameras || []).find((c) => String(c.id) === String(state.selectedId)); }

async function loadState(floorId) {
  setStatus("Загрузка…");
  const query = floorId ? `?floor_id=${encodeURIComponent(floorId)}` : "";
  try {
    state.data = await api(`/api/state${query}`);
    state.floorId = state.data.floor.id;
    renderFloors();
    renderPlan();
    renderMarkers();
    renderEvents();
    applyMapTransform();
    setStatus("");
  } catch (error) {
    setStatus(`Ошибка: ${error.message}`);
  }
}

function renderFloors() {
  const select = $("#floorSelect");
  select.innerHTML = state.data.floors.map((f) =>
    `<option value="${f.id}">${esc(f.building_name)} · ${esc(f.name)}</option>`
  ).join("");
  select.value = String(state.floorId);
  select.onchange = () => { state.selectedId = null; resetMapView(); loadState(select.value); };
}

function renderPlan() {
  const floor = state.data.floor;
  const image = $("#planImage");
  const empty = $("#emptyPlan");
  if (floor.plan_url) {
    image.src = `${floor.plan_url}?v=${Date.now()}`;
    image.hidden = false;
    empty.hidden = true;
  } else {
    image.hidden = true;
    empty.hidden = false;
  }
}

function applyMapTransform() {
  const world = $("#planWorld");
  if (world) world.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  const label = $("#zoomLabel");
  if (label) label.textContent = `${Math.round(state.zoom * 100)}%`;
}

function setMapZoom(nextZoom, anchorX, anchorY) {
  const stage = $("#planStage");
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  const px = anchorX ?? rect.width / 2;
  const py = anchorY ?? rect.height / 2;
  const previous = state.zoom;
  const clamped = Math.max(0.5, Math.min(10, nextZoom));
  if (Math.abs(clamped - previous) < 0.001) return;
  state.panX = px - (px - state.panX) * (clamped / previous);
  state.panY = py - (py - state.panY) * (clamped / previous);
  state.zoom = clamped;
  applyMapTransform();
}

function resetMapView() {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  applyMapTransform();
}

function panMap(dx, dy) {
  const stage = $("#planStage");
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  state.panX += dx * rect.width;
  state.panY += dy * rect.height;
  applyMapTransform();
}

function recentAlarm(cameraId) {
  return (state.data.floor.alarms || []).some((a) => Number(a.camera_id) === Number(cameraId) && a.status === "active");
}

function setMarkerGeometry(marker, cam) {
  const angle = normAngle(cam.angle);
  const handle = marker.querySelector(".rotate-handle");
  if (handle) handle.style.transform = `translate(-50%,-50%) rotate(${angle}deg) translateX(46px)`;
}

function planBounds() {
  const stage = $("#planStage");
  const img = $("#planImage");
  const w = stage.clientWidth || 1, h = stage.clientHeight || 1;
  if (!img || !img.naturalWidth || !img.naturalHeight) return { x: 0, y: 0, w, h };
  const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
  const pw = img.naturalWidth * scale, ph = img.naturalHeight * scale;
  return { x: (w - pw) / 2, y: (h - ph) / 2, w: pw, h: ph };
}

function cameraOutside(cam) {
  const stage = $("#planStage");
  const w = stage.clientWidth || 1, h = stage.clientHeight || 1;
  const box = planBounds();
  const cx = (Number(cam.x) / 100) * w, cy = (Number(cam.y) / 100) * h;
  const angle = normAngle(cam.angle);
  const fov = Math.max(10, Math.min(180, Number(cam.fov) || 70));
  const radius = Math.max(5, Math.min(100, Number(cam.view_range) || 35)) / 100 * Math.min(box.w, box.h);
  for (let i = 0; i <= 24; i++) {
    const a = (angle - fov / 2 + (fov * i) / 24) * Math.PI / 180;
    const x = cx + Math.cos(a) * radius, y = cy + Math.sin(a) * radius;
    if (x < box.x || x > box.x + box.w || y < box.y || y > box.y + box.h) return true;
  }
  return false;
}

function wallSegments() {
  const walls = state.data?.floor?.walls || [];
  return walls.map((w) => w.map(Number)).filter((w) => w.length === 4);
}

function rayWallDistance(ox, oy, dx, dy, walls) {
  let best = Infinity;
  for (const [x1, y1, x2, y2] of walls) {
    const sx = x2 - x1, sy = y2 - y1;
    const den = dx * sy - dy * sx;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((x1 - ox) * sy - (y1 - oy) * sx) / den;
    const u = ((x1 - ox) * dy - (y1 - oy) * dx) / den;
    if (t > 0.5 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return best;
}

function boundaryDistance(ox, oy, dx, dy, box) {
  let best = Infinity;
  if (dx > 0) best = Math.min(best, (box.x + box.w - ox) / dx);
  if (dx < 0) best = Math.min(best, (box.x - ox) / dx);
  if (dy > 0) best = Math.min(best, (box.y + box.h - oy) / dy);
  if (dy < 0) best = Math.min(best, (box.y - oy) / dy);
  return best > 0 ? best : 0;
}

function cameraDeadReason(cam) {
  const stage = $("#planStage");
  const w = stage.clientWidth || 1, h = stage.clientHeight || 1;
  const box = planBounds();
  const cx = (Number(cam.x) / 100) * w, cy = (Number(cam.y) / 100) * h;
  const angle = normAngle(cam.angle);
  const fov = Math.max(10, Math.min(180, Number(cam.fov) || 70));
  const radius = Math.max(5, Math.min(100, Number(cam.view_range) || 35)) / 100 * Math.min(box.w, box.h);
  const walls = wallSegments();
  for (let i = 0; i <= 48; i++) {
    const a = (angle - fov / 2 + (fov * i) / 48) * Math.PI / 180;
    const dx = Math.cos(a), dy = Math.sin(a);
    const edge = boundaryDistance(cx, cy, dx, dy, box);
    const wall = rayWallDistance(cx, cy, dx, dy, walls);
    if (wall < Math.min(radius, edge) - 0.5) return "wall";
    if (edge < radius - 0.5) return "edge";
  }
  return "";
}

function renderCoverage() {
  const svg = $("#coverage");
  const stage = $("#planStage");
  if (!svg || !stage || !state.data) return;
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) { svg.innerHTML = ""; return; }
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.innerHTML = "";
  const box = planBounds();
  const planClip = document.createElementNS("http://www.w3.org/2000/svg", "clipPath");
  planClip.setAttribute("id", "plan-clip");
  const clipRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  clipRect.setAttribute("x", box.x); clipRect.setAttribute("y", box.y);
  clipRect.setAttribute("width", box.w); clipRect.setAttribute("height", box.h);
  planClip.appendChild(clipRect);
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.appendChild(planClip); svg.appendChild(defs);
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("clip-path", "url(#plan-clip)");
  svg.appendChild(group);
  const walls = wallSegments();
  const wallsPx = walls.map(([x1, y1, x2, y2]) => [x1 / 100 * w, y1 / 100 * h, x2 / 100 * w, y2 / 100 * h]);
  const cams = state.data.floor.cameras || [];
  for (const cam of cams) {
    const cx = (Number(cam.x) / 100) * w, cy = (Number(cam.y) / 100) * h;
    const angle = normAngle(cam.angle);
    const fov = Math.max(10, Math.min(180, Number(cam.fov) || 70));
    const radius = Math.max(5, Math.min(100, Number(cam.view_range) || 35)) / 100 * Math.min(box.w, box.h);
    const visible = [[cx, cy]];
    const rays = [];
    const deadQuads = [];
    const steps = 64;
    for (let i = 0; i <= steps; i++) {
      const a = (angle - fov / 2 + (fov * i) / steps) * Math.PI / 180;
      const dx = Math.cos(a), dy = Math.sin(a);
      const edge = boundaryDistance(cx, cy, dx, dy, box);
      const wall = rayWallDistance(cx, cy, dx, dy, wallsPx);
      const outer = Math.max(1, Math.min(radius, edge));
      const blocked = wall < outer - 0.5;
      const hit = blocked ? wall : outer;
      const point = [cx + dx * hit, cy + dy * hit];
      visible.push(point);
      rays.push({ outer: [cx + dx * outer, cy + dy * outer], wall: blocked ? [cx + dx * wall, cy + dy * wall] : null });
    }
    // Красные участки: от стены до внешней границы сектора.
    for (let i = 0; i < rays.length - 1; i++) {
      const a = rays[i], b = rays[i + 1];
      if (a.wall && b.wall) {
        deadQuads.push([a.wall, b.wall, b.outer, a.outer]);
      }
    }
    for (const quad of deadQuads) {
      const d = "M " + quad.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L ") + " Z";
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("class", "dead-zone");
      group.appendChild(path);
    }
    const d = "M " + visible.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L ") + " Z";
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    const coneClasses = ["cone-path"];
    if (String(cam.id) === String(state.selectedId)) coneClasses.push("selected");
    if (String(cam.id) === String(state.highlightCameraId)) coneClasses.push("event-zone");
    path.setAttribute("class", coneClasses.join(" "));
    path.addEventListener("click", (event) => { event.stopPropagation(); openCameraJournal(cam.id); });
    group.appendChild(path);
  }
  for (const [x1, y1, x2, y2] of wallsPx) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1); line.setAttribute("y1", y1);
    line.setAttribute("x2", x2); line.setAttribute("y2", y2);
    line.setAttribute("class", "wall-line");
    group.appendChild(line);
  }
  if (state.wallPreview && state.wallStart) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", state.wallStart[0] / 100 * w);
    line.setAttribute("y1", state.wallStart[1] / 100 * h);
    line.setAttribute("x2", state.wallPreview[0] / 100 * w);
    line.setAttribute("y2", state.wallPreview[1] / 100 * h);
    line.setAttribute("class", "wall-preview");
    group.appendChild(line);
  }
}

function renderMarkers() {
  const layer = $("#markers");
  layer.innerHTML = "";
  for (const cam of state.data.floor.cameras) {
    const marker = document.createElement("div");
    marker.className = `marker${(cam.effective_armed ?? cam.armed) ? " armed" : ""}${(cam.effective_armed ?? cam.armed) && recentAlarm(cam.id) ? " alarm" : ""}`;
    marker.style.left = `${cam.x}%`;
    marker.style.top = `${cam.y}%`;
    marker.title = `${cam.name} · ${cam.camera_ref}`;
    marker.dataset.cameraId = String(cam.id);
    marker.tabIndex = 0;
    marker.setAttribute("role", "button");
    const cutoff = Date.now() / 1000 - 15 * 60;
    const effectivelyArmed = cam.effective_armed ?? cam.armed;
    const unread = effectivelyArmed ? (state.data.floor.events || []).filter((e) => Number(e.camera_id) === Number(cam.id) && Number(e.ts) >= cutoff).length : 0;
    marker.innerHTML = `<span class="camera-dot"></span><span class="camera-label">${esc(cam.name)}</span>${unread ? `<button type="button" class="camera-events" data-camera-events="${cam.id}" title="События на охране: ${unread}">${unread}</button>` : ""}<button type="button" class="rotate-handle" title="Повернуть камеру"></button>`;
    setMarkerGeometry(marker, cam);
    const badge = marker.querySelector(".camera-events");
    if (badge) badge.addEventListener("click", (event) => { event.stopPropagation(); openCameraJournal(cam.id); });
    marker.addEventListener("click", (event) => {
      if (state.wallMode) return;
      if (event.target.closest(".rotate-handle")) return;
      if (marker.dataset.dragged === "1") { marker.dataset.dragged = "0"; return; }
      selectCamera(cam);
    });
    marker.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectCamera(cam); }
    });
    bindDrag(marker, cam);
    bindRotate(marker, cam);
    layer.appendChild(marker);
  }
  const zoneRows = state.data.floor.zones || [];
  const armedCount = zoneRows.filter((z) => z.effective_armed ?? z.armed).length;
  const totalCount = zoneRows.length;
  const alarms = (state.data.floor.alarms || []).length;
  $("#guardSummary").textContent = `Зон на охране: ${armedCount}/${totalCount} · тревог: ${alarms}`;
  renderCoverage();
  const selected = currentCamera();
  if (selected) {
    selectCamera(selected, true);
  } else {
    hideEditor();
  }
}

let previewPlayer = null;

function closePreview() {
  const box = $("#cePreview"), video = $("#cePlayer"), error = $("#cePlayerError");
  if (previewPlayer) { try { previewPlayer.close(); } catch (e) {} previewPlayer = null; }
  if (video) { try { video.srcObject = null; } catch (e) {} }
  if (error) { error.textContent = ""; error.classList.remove("show"); }
  if (box) box.hidden = true;
}

function selectCamera(cam, silent = false) {
  const changed = state.selectedId !== String(cam.id);
  state.selectedId = String(cam.id);
  if (changed) closePreview();
  document.querySelectorAll(".marker").forEach((node) => {
    node.classList.toggle("selected", node.dataset.cameraId === String(cam.id));
  });
  const editor = $("#cameraEditor");
  editor.hidden = false;
  $("#ceName").textContent = cam.name;
  $("#ceAngle").value = Math.round(normAngle(cam.angle));
  $("#ceFov").value = Math.round(cam.fov || 70);
  $("#ceRange").value = Math.round(cam.view_range || 35);
  if (cam.stream_url) $("#ceStream").textContent = "Поток";
  const armBtn = $("#ceArm");
  if (armBtn) {
    const zone = (state.data?.floor?.zones || []).find((z) => String(z.id) === String(cam.zone_id));
    const effective = cam.effective_armed ?? cam.armed;
    const scheduled = zone ? !!zone.schedule_enabled : !!cam.guard_schedule_enabled;
    armBtn.textContent = scheduled
      ? `По расписанию: ${effective ? "на охране" : "снята"}`
      : (effective ? "Снять с охраны" : "Взять на охрану");
    armBtn.classList.toggle("disarm", !!effective);
    armBtn.disabled = scheduled;
  }
  ["#ceAngle", "#ceFov", "#ceRange"].forEach((id) => { const el = $(id); if (el) el.disabled = READ_ONLY; });
  updateEditorLabels(cam);
  renderCoverage();
  if (!silent) setStatus(`Камера «${cam.name}»: настрой направление, сектор и дальность, затем сохрани.`);
}

function updateEditorLabels(cam) {
  $("#ceAngleOut").textContent = `${Math.round(normAngle(cam.angle))}°`;
  $("#ceFovOut").textContent = `${Math.round(cam.fov || 70)}°`;
  $("#ceRangeOut").textContent = `${Math.round(cam.view_range || 35)}%`;
  const reason = cameraDeadReason(cam);
  $("#ceDead").hidden = !reason;
  $("#ceDead").textContent = reason === "wall"
    ? "⚠ Сектор перекрыт стеной — участок за стеной мёртвый."
    : "⚠ Сектор выходит за границы плана — часть зоны мёртвая.";
}

function hideEditor() {
  closePreview();
  $("#cameraEditor").hidden = true;
  $("#ceDead").hidden = true;
  state.selectedId = null;
  document.querySelectorAll(".marker.selected").forEach((node) => node.classList.remove("selected"));
}

function syncSelectedMarker(cam) {
  const marker = document.querySelector(`.marker[data-camera-id="${cam.id}"]`);
  if (marker) setMarkerGeometry(marker, cam);
  updateEditorLabels(cam);
  renderCoverage();
}

function bindRotate(marker, cam) {
  if (READ_ONLY) return;
  const handle = marker.querySelector(".rotate-handle");
  let rotating = false;
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    rotating = true;
    marker.classList.add("rotating");
    handle.setPointerCapture(event.pointerId);
    const move = (ev) => {
      if (!rotating) return;
      const stage = $("#planStage").getBoundingClientRect();
      const cx = stage.left + state.panX + (cam.x / 100) * stage.width * state.zoom;
      const cy = stage.top + state.panY + (cam.y / 100) * stage.height * state.zoom;
      cam.angle = normAngle(Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI);
      syncSelectedMarker(cam);
    };
    const up = async () => {
      if (!rotating) return;
      rotating = false;
      marker.classList.remove("rotating");
      handle.removeEventListener("pointermove", move);
      try {
        await saveCamera(cam);
        setStatus(`Камера «${cam.name}» повернута: ${Math.round(cam.angle)}°.`);
      } catch (error) { setStatus(`Не удалось сохранить поворот: ${error.message}`); }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  });
}

function bindDrag(marker, cam) {
  if (READ_ONLY) return;
  let dragging = false, moved = false;
  marker.addEventListener("pointerdown", (event) => {
    if (event.altKey || event.target.closest(".rotate-handle") || event.button !== 0) return;
    event.preventDefault();
    dragging = true; moved = false;
    marker.setPointerCapture(event.pointerId);
    marker.classList.add("dragging");
  });
  marker.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const [x, y] = stagePoint(event);
    marker.style.left = `${x}%`; marker.style.top = `${y}%`;
    cam.x = x; cam.y = y; moved = true;
    renderCoverage();
  });
  marker.addEventListener("pointerup", async () => {
    if (!dragging) return;
    dragging = false; marker.classList.remove("dragging");
    if (!moved) return;
    marker.dataset.dragged = "1";
    try {
      await saveCamera(cam);
      setStatus(`Камера «${cam.name}» перемещена.`);
    } catch (error) { setStatus(`Не удалось сохранить: ${error.message}`); }
  });
}

async function saveCamera(cam) {
  await api(`/api/cameras/${cam.id}/position`, {
    method: "POST",
    body: JSON.stringify({ x: cam.x, y: cam.y, angle: cam.angle, fov: cam.fov, view_range: cam.view_range }),
  });
}

function ts(value) {
  return new Date(Number(value) * 1000).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const WEEKDAYS = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];

function currentZone(cam) {
  return (state.data?.floor?.zones || []).find((z) => String(z.id) === String(cam?.zone_id));
}

function openSchedule(cam) {
  if (READ_ONLY || !cam) return;
  const zone = currentZone(cam);
  if (!zone) { setStatus("Для камеры не назначена зона."); return; }
  state.scheduleCameraId = cam.id;
  $("#scheduleEnabled").checked = !!zone.schedule_enabled;
  const rules = Object.fromEntries((zone.schedule || []).map((r) => [Number(r.weekday), r]));
  $("#scheduleRows").innerHTML = WEEKDAYS.map((name, index) => {
    const day = index + 1;
    const rule = rules[day] || {};
    return `<tr><td><label><input type="checkbox" data-day-enabled="${day}" ${rule.id || rule.arm_time ? "checked" : ""}>${name}</label></td>
      <td><input type="time" data-arm="${day}" value="${esc(rule.arm_time || "20:00")}"></td>
      <td><input type="time" data-disarm="${day}" value="${esc(rule.disarm_time || "08:00")}"></td></tr>`;
  }).join("");
  $("#holidayMode").value = zone.holiday_mode || "weekday";
  $("#holidayArm").value = zone.holiday_arm_time || "20:00";
  $("#holidayDisarm").value = zone.holiday_disarm_time || "08:00";
  $("#weekendArm").value = zone.weekend_arm_time || "20:00";
  $("#weekendDisarm").value = zone.weekend_disarm_time || "08:00";
  toggleHolidayInputs();
  document.querySelectorAll("#alarmTypeChecks input").forEach((input) => {
    input.checked = (cam.alarm_types || ["person", "vehicle", "plate"]).includes(input.value);
  });
  $("#scheduleModal").hidden = false;
}

function toggleHolidayInputs() {
  const mode = $("#holidayMode").value;
  $("#holidayTimes").hidden = mode !== "custom";
  $("#weekendTimes").hidden = mode !== "weekend";
}

async function saveSchedule() {
  const cam = currentCamera(); if (!cam) return;
  const zone = currentZone(cam);
  if (!zone) { setStatus("Для камеры не назначена зона."); return; }
  const rules = WEEKDAYS.map((_, index) => {
    const day = index + 1;
    return {
      weekday: day,
      enabled: $(`[data-day-enabled="${day}"]`).checked,
      arm_time: $(`[data-arm="${day}"]`).value,
      disarm_time: $(`[data-disarm="${day}"]`).value,
    };
  }).filter((r) => r.enabled);
  const alarm_types = [...document.querySelectorAll("#alarmTypeChecks input:checked")].map((i) => i.value);
  try {
    await api(`/api/cameras/${cam.id}/schedule`, {
      method: "POST",
      body: JSON.stringify({ enabled: false, rules: [], alarm_types }),
    });
    await api(`/api/zones/${zone.id}/schedule`, {
      method: "POST",
      body: JSON.stringify({
        enabled: $("#scheduleEnabled").checked, rules,
        holiday_mode: $("#holidayMode").value,
        holiday_arm_time: $("#holidayArm").value,
        holiday_disarm_time: $("#holidayDisarm").value,
        weekend_arm_time: $("#weekendArm").value,
        weekend_disarm_time: $("#weekendDisarm").value,
      }),
    });
    $("#scheduleModal").hidden = true;
    await loadState(state.floorId);
    setStatus("Расписание зоны сохранено.");
  } catch (error) { setStatus(`Ошибка расписания: ${error.message}`); }
}

function closeSchedule() { $("#scheduleModal").hidden = true; }

function openSnapshot(eventId) {
  const event = (state.data?.floor?.events || []).find((e) => String(e.id) === String(eventId));
  if (!event?.snapshot_endpoint) { setStatus("У события нет снепшота."); return; }
  const image = $("#snapshotImage"), error = $("#snapshotError");
  const src = `${event.snapshot_endpoint}?v=${Date.now()}`;
  error.hidden = true;
  $("#snapshotCaption").textContent = `${event.title} · ${ts(event.ts)}`;
  image.onerror = () => { error.hidden = false; error.textContent = "Не удалось загрузить снепшот из Viewer."; };
  image.src = src;
  $("#snapshotDownload").href = src;
  $("#snapshotOpen").href = src;
  $("#snapshotModal").hidden = false;
}

function closeSnapshot() {
  $("#snapshotModal").hidden = true;
  $("#snapshotImage").src = "";
}

function renderEventMarkers() {
  const layer = $("#eventMarkers");
  if (layer) layer.innerHTML = "";
}

function openCameraJournal(cameraId) {
  const cam = (state.data?.floor?.cameras || []).find((c) => String(c.id) === String(cameraId));
  if (!cam) return;
  state.cameraFilter = String(cameraId);
  state.selectedEventId = null;
  selectCamera(cam, true);
  $("#eventFilterBar").hidden = false;
  $("#eventFilterName").textContent = `Камера: ${cam.name}`;
  $("#eventList").scrollTop = 0;
  renderEvents();
  setStatus(`Журнал камеры «${cam.name}».`);
}

function clearCameraFilter() {
  state.cameraFilter = null;
  $("#eventFilterBar").hidden = true;
  renderEvents();
}

function selectEvent(eventId) {
  state.selectedEventId = String(eventId);
  const event = (state.data?.floor?.events || []).find((e) => String(e.id) === String(eventId));
  if (event?.camera_id) {
    const camera = (state.data.floor.cameras || []).find((c) => Number(c.id) === Number(event.camera_id));
    if (camera) selectCamera(camera, true);
  }
  renderEvents();
  const node = document.querySelector(`.event[data-event-id="${eventId}"]`);
  if (node) node.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function renderEvents() {
  const allEvents = state.data.floor.events || [];
  const events = state.cameraFilter
    ? allEvents.filter((e) => String(e.camera_id) === String(state.cameraFilter))
    : allEvents;
  const list = $("#eventList");
  $("#eventCount").textContent = events.length;
  if (state.cameraFilter) {
    const cam = (state.data.floor.cameras || []).find((c) => String(c.id) === String(state.cameraFilter));
    if (!cam) { state.cameraFilter = null; return renderEvents(); }
    $("#eventFilterBar").hidden = false;
    $("#eventFilterName").textContent = `Камера: ${cam.name}`;
  } else {
    $("#eventFilterBar").hidden = true;
  }
  if (!events.length) {
    state.selectedEventId = null;
    list.innerHTML = `<p class="muted">${state.cameraFilter ? "В зоне этой камеры событий нет." : "Событий нет. Нажмите «Обновить события»."}</p>`;
    renderEventMarkers();
    return;
  }
  if (state.selectedEventId && !events.some((e) => String(e.id) === String(state.selectedEventId))) {
    state.selectedEventId = null;
  }
  const previousScroll = list.scrollTop;
  list.innerHTML = events.map((e) => {
    const camera = (state.data.floor.cameras || []).find((c) => Number(c.id) === Number(e.camera_id));
    const selected = String(e.id) === String(state.selectedEventId);
    const snapshot = e.snapshot_endpoint
      ? `<button type="button" class="snap" data-snapshot="${e.id}">Снепшот</button>`
      : (e.snapshot_url ? `<a href="${esc(e.snapshot_url)}" target="_blank" rel="noopener">Снимок</a>` : "");
    return `<article class="event${selected ? " selected" : ""}${e.alarm_id ? " alarm-event" : ((camera?.effective_armed ?? camera?.armed) ? " armed-event" : " unarmed-event")}" data-event-id="${e.id}" data-camera="${camera ? camera.id : ""}">
      <div class="event-head"><b>${esc(e.title)}</b>${e.alarm_id ? `<span class="alarm-badge">Тревога</span>` : ""}<time>${ts(e.ts)}</time></div>
      <p>${esc(e.camera_name || camera?.name || "Камера не привязана")}${camera ? ` · ${camera.armed ? "на охране" : "не на охране"}` : ""}${e.description ? ` · ${esc(e.description)}` : ""}</p>
      ${e.plate ? `<span class="plate">${esc(e.plate)}</span>` : ""}
      <div class="event-actions">
        ${camera && state.data.streamer_url ? `<a href="${state.data.streamer_url}/player/${encodeURIComponent(camera.camera_ref)}" target="_blank" rel="noopener">Поток</a>` : ""}
        ${snapshot}
      </div>
    </article>`;
  }).join("");
  list.querySelectorAll(".event").forEach((node) => {
    node.addEventListener("click", (event) => {
      if (event.target.closest("button,a")) return;
      selectEvent(node.dataset.eventId);
    });
  });
  list.querySelectorAll("[data-snapshot]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openSnapshot(button.dataset.snapshot);
    });
  });
  list.scrollTop = previousScroll;
  renderEventMarkers();
  updateEventHighlight();
}

function updateEventHighlight() {
  const list = $("#eventList");
  if (!list) return;
  const nodes = [...list.querySelectorAll(".event")];
  if (!nodes.length) {
    state.highlightEventId = null;
    state.highlightCameraId = null;
    renderCoverage();
    return;
  }
  const listRect = list.getBoundingClientRect();
  let active = null, best = Infinity;
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom < listRect.top || rect.top > listRect.bottom) continue;
    const distance = Math.abs(rect.top - listRect.top - 6);
    if (distance < best) { best = distance; active = node; }
  }
  if (!active) active = nodes[0];
  state.highlightEventId = active.dataset.eventId || null;
  const event = (state.data?.floor?.events || []).find((e) => String(e.id) === String(state.highlightEventId));
  state.highlightCameraId = event?.camera_id || null;
  nodes.forEach((node) => node.classList.toggle("active", node === active));
  document.querySelectorAll(".event-marker").forEach((marker) => {
    marker.classList.toggle("active", marker.dataset.eventId === String(state.highlightEventId));
  });
  document.querySelectorAll(".marker").forEach((marker) => {
    marker.classList.toggle("event-zone", marker.dataset.cameraId === String(state.highlightCameraId));
  });
  renderCoverage();
}

async function syncNow() {
  const button = $("#syncBtn");
  if (state.busy) return;
  state.busy = true; button.disabled = true; button.textContent = "Обновление…";
  try {
    const result = await api("/api/sync", { method: "POST", body: JSON.stringify({ floor_id: state.floorId }) });
    await loadState(state.floorId);
    $("#lastSync").textContent = `обновлено ${new Date().toLocaleTimeString("ru-RU")}`;
    setStatus(`Камер: ${result.cameras || 0} · удалено камер: ${result.cameras_removed || 0} · удалено камер Viewer: ${result.viewer_cameras_removed || 0} · объединено дублей: ${result.duplicate_cameras_removed || 0} · события Viewer: ${result.viewer_events || 0}${(result.warnings || []).length ? ` · ${result.warnings.join("; ")}` : ""}`);
  } catch (error) { setStatus(`Ошибка синхронизации: ${error.message}`); }
  state.busy = false; button.disabled = false; button.textContent = "Обновить события";
}

$("#ceClose").addEventListener("click", hideEditor);
$("#ceAngle").addEventListener("input", () => {
  const cam = currentCamera(); if (!cam) return;
  cam.angle = normAngle($("#ceAngle").value); syncSelectedMarker(cam);
});
$("#ceFov").addEventListener("input", () => {
  const cam = currentCamera(); if (!cam) return;
  cam.fov = Number($("#ceFov").value); syncSelectedMarker(cam);
});
$("#ceAngle").addEventListener("change", async () => { const cam = currentCamera(); if (cam) { try { await saveCamera(cam); } catch (e) { setStatus(e.message); } } });
$("#ceFov").addEventListener("change", async () => { const cam = currentCamera(); if (cam) { try { await saveCamera(cam); } catch (e) { setStatus(e.message); } } });
$("#ceRange").addEventListener("input", () => {
  const cam = currentCamera(); if (!cam) return;
  cam.view_range = Number($("#ceRange").value); syncSelectedMarker(cam);
});
$("#ceRange").addEventListener("change", async () => { const cam = currentCamera(); if (cam) { try { await saveCamera(cam); } catch (e) { setStatus(e.message); } } });
$("#ceSchedule").addEventListener("click", () => openSchedule(currentCamera()));
$("#scheduleClose").addEventListener("click", closeSchedule);
$("#scheduleCancel").addEventListener("click", closeSchedule);
$("#scheduleSave").addEventListener("click", saveSchedule);
$("#holidayMode").addEventListener("change", toggleHolidayInputs);

$("#ceArm").addEventListener("click", async () => {
  if (READ_ONLY) return;
  const cam = currentCamera(); if (!cam) return;
  const zone = currentZone(cam);
  const current = zone
    ? (zone.effective_armed ?? zone.armed)
    : (cam.effective_armed ?? cam.armed);
  const next = !current;
  try {
    await api(`/api/zones/${zone ? zone.id : cam.id}/arm`, { method: "POST", body: JSON.stringify({ armed: next }) });
    if (zone) zone.armed = next; else cam.armed = next;
    await loadState(state.floorId);
    setStatus(next
      ? `Зона «${zone ? zone.name : cam.name}» взята на охрану.`
      : `Зона «${zone ? zone.name : cam.name}» снята с охраны.`);
  } catch (error) { setStatus(`Ошибка охраны: ${error.message}`); }
});

$("#ceSave").addEventListener("click", async () => {
  const cam = currentCamera(); if (!cam) return;
  try { await saveCamera(cam); setStatus(`Сохранено: ${Math.round(cam.angle)}°, сектор ${Math.round(cam.fov)}°, дальность ${Math.round(cam.view_range)}%.`); }
  catch (error) { setStatus(`Ошибка сохранения: ${error.message}`); }
});
$("#ceStream").addEventListener("click", () => {
  const cam = currentCamera();
  if (!cam) return;
  if (!cam.stream_url) {
    if (!state.data.streamer_url) { setStatus("Поток недоступен: не задан STREAMER_URL."); return; }
    window.open(`${state.data.streamer_url}/player/${encodeURIComponent(cam.camera_ref)}`, "_blank", "noopener");
    return;
  }
  const box = $("#cePreview"), frame = $("#cePlayer");
  if (box.hidden) {
    const video = $("#cePlayer"), error = $("#cePlayerError");
    box.hidden = false;
    error.textContent = ""; error.classList.remove("show");
    setStatus(`Подключение к камере «${cam.name}»…`);
    if (!window.VHSWhep) {
      error.textContent = "WHEP-клиент не загружен"; error.classList.add("show");
      return;
    }
    window.VHSWhep.connect(video, cam.stream_url, {
      onState: (state) => {
        if (state === "playing" || state === "connected") setStatus(`Поток камеры «${cam.name}» открыт.`);
        if (state === "failed" || state === "disconnected") {
          error.textContent = "Поток отключился"; error.classList.add("show");
        }
      },
    }).then((player) => { previewPlayer = player; }).catch((err) => {
      error.textContent = "Поток: " + (err.message || err); error.classList.add("show");
      setStatus(`Ошибка потока: ${err.message || err}`);
    });
  } else {
    closePreview();
    setStatus("Поток скрыт.");
  }
});

function stagePoint(event) {
  const rect = $("#planStage").getBoundingClientRect();
  const x = (event.clientX - rect.left - state.panX) / state.zoom;
  const y = (event.clientY - rect.top - state.panY) / state.zoom;
  return [
    Math.max(0, Math.min(100, (x / rect.width) * 100)),
    Math.max(0, Math.min(100, (y / rect.height) * 100)),
  ];
}

$("#zoomIn").addEventListener("click", () => setMapZoom(state.zoom * 1.25));
$("#zoomOut").addEventListener("click", () => setMapZoom(state.zoom / 1.25));
$("#zoomFit").addEventListener("click", resetMapView);
$("#panLeft").addEventListener("click", () => panMap(0.2, 0));
$("#panUp").addEventListener("click", () => panMap(0, 0.2));
$("#panDown").addEventListener("click", () => panMap(0, -0.2));
$("#panRight").addEventListener("click", () => panMap(-0.2, 0));

$("#planStage").addEventListener("wheel", (event) => {
  event.preventDefault();
  const rect = $("#planStage").getBoundingClientRect();
  const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
  setMapZoom(state.zoom * factor, event.clientX - rect.left, event.clientY - rect.top);
}, { passive: false });

$("#planStage").addEventListener("pointerdown", (event) => {
  const panButton = event.button === 1 || (event.button === 0 && event.altKey);
  if (!panButton || event.target.closest(".camera-editor")) return;
  event.preventDefault();
  state.panning = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    panX: state.panX,
    panY: state.panY,
  };
  $("#planStage").classList.add("panning");
  $("#planStage").setPointerCapture(event.pointerId);
});
$("#planStage").addEventListener("pointermove", (event) => {
  if (!state.panning || state.panning.pointerId !== event.pointerId) return;
  state.panX = state.panning.panX + event.clientX - state.panning.startX;
  state.panY = state.panning.panY + event.clientY - state.panning.startY;
  applyMapTransform();
});
$("#planStage").addEventListener("pointerup", (event) => {
  if (!state.panning || state.panning.pointerId !== event.pointerId) return;
  state.panning = null;
  $("#planStage").classList.remove("panning");
});
$("#planStage").addEventListener("pointercancel", () => {
  state.panning = null;
  $("#planStage").classList.remove("panning");
});

$("#wallBtn").addEventListener("click", () => {
  state.wallMode = !state.wallMode;
  $("#wallBtn").classList.toggle("active", state.wallMode);
  $("#planStage").classList.toggle("wall-mode", state.wallMode);
  setStatus(state.wallMode ? "Режим стен: протащи мышью по плану, чтобы добавить стену." : "Режим стен выключен.");
});
$("#wallClear").addEventListener("click", async () => {
  if (!state.data) return;
  try {
    await api(`/api/floors/${state.floorId}/walls`, { method: "POST", body: JSON.stringify({ walls: [] }) });
    state.data.floor.walls = [];
    renderCoverage();
    setStatus("Стены удалены.");
  } catch (error) { setStatus(`Ошибка: ${error.message}`); }
});
$("#planStage").addEventListener("pointerdown", (event) => {
  if (!state.wallMode || event.button !== 0 || event.altKey) return;
  if (event.target.closest(".marker") || event.target.closest(".camera-editor")) return;
  event.preventDefault();
  state.wallStart = stagePoint(event);
  state.wallPreview = state.wallStart;
  $("#planStage").setPointerCapture(event.pointerId);
});
$("#planStage").addEventListener("pointermove", (event) => {
  if (!state.wallStart) return;
  state.wallPreview = stagePoint(event);
  renderCoverage();
});
$("#planStage").addEventListener("pointerup", async (event) => {
  if (!state.wallStart) return;
  const start = state.wallStart;
  const end = stagePoint(event);
  state.wallStart = null; state.wallPreview = null;
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  if (length < 0.8) { renderCoverage(); return; }
  state.data.floor.walls = [...(state.data.floor.walls || []), [start[0], start[1], end[0], end[1]]];
  renderCoverage();
  try {
    await api(`/api/floors/${state.floorId}/walls`, {
      method: "POST",
      body: JSON.stringify({ walls: state.data.floor.walls }),
    });
    setStatus("Стена добавлена.");
  } catch (error) { setStatus(`Не удалось сохранить стену: ${error.message}`); }
});

function renderDiscovery(data) {
  const list = $("#discoveryList");
  if (!data.viewers || !data.viewers.length) {
    list.innerHTML = `<p class="muted">Viewer не найден в подсети ${esc(data.network || "")}. Проверь сеть или укажи подсеть вручную.</p>`;
    return;
  }
  list.innerHTML = data.viewers.map((s) => `
    <div class="discovery-item${s.url === data.current ? " current" : ""}">
      <div><b>${esc(s.url)}</b><br><span class="muted">VHS-Viewer${s.version ? ` v${esc(s.version)}` : ""}${s.url === data.current ? " · текущий" : ""}</span></div>
      <button type="button" class="ghost" data-use="${esc(s.url)}">${s.url === data.current ? "Выбран" : "Использовать"}</button>
    </div>`).join("");
}

async function discoverViewers() {
  const button = $("#discoveryRun");
  button.disabled = true; button.textContent = "Ищу…";
  $("#discoveryList").innerHTML = `<p class="muted">Сканирую локальную сеть…</p>`;
  try {
    const data = await api("/api/discovery/viewers", {
      method: "POST",
      body: JSON.stringify({ subnet: $("#discoverySubnet").value.trim() }),
    });
    renderDiscovery(data);
    setStatus(`Найдено Viewer: ${(data.viewers || []).length}`);
  } catch (error) {
    $("#discoveryList").innerHTML = `<p class="muted">Ошибка поиска: ${esc(error.message)}</p>`;
  }
  button.disabled = false; button.textContent = "Искать";
}

$("#discoverBtn")?.addEventListener("click", () => {
  $("#discovery").hidden = false;
  discoverViewers();
});
$("#discoveryClose").addEventListener("click", () => { $("#discovery").hidden = true; });
$("#discovery").addEventListener("click", (event) => {
  if (event.target === $("#discovery")) $("#discovery").hidden = true;
});
$("#discoveryRun").addEventListener("click", discoverViewers);
$("#discoveryList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-use]");
  if (!button) return;
  button.disabled = true; button.textContent = "Подключаю…";
  try {
    await api("/api/discovery/use-viewer", { method: "POST", body: JSON.stringify({ url: button.dataset.use }) });
    $("#discovery").hidden = true;
    await loadState(state.floorId);
    await syncNow();
    setStatus(`Подключён Viewer: ${button.dataset.use}`);
  } catch (error) {
    setStatus(`Не удалось подключить Viewer: ${error.message}`);
    button.disabled = false; button.textContent = "Использовать";
  }
});

$("#clearEventFilter").addEventListener("click", clearCameraFilter);

$("#snapshotClose").addEventListener("click", closeSnapshot);
$("#snapshotModal").addEventListener("click", (event) => {
  if (event.target === $("#snapshotModal")) closeSnapshot();
});

$("#clearEvents").addEventListener("click", async () => {
  if (!state.floorId) return;
  if (!confirm("Очистить оперативный журнал текущего этажа? События будут удалены без возможности восстановления.")) return;
  try {
    const result = await api("/api/events/clear", {
      method: "POST",
      body: JSON.stringify({ floor_id: state.floorId }),
    });
    await loadState(state.floorId);
    setStatus(`Журнал очищен. Удалено событий: ${result.deleted || 0}.`);
  } catch (error) {
    setStatus(`Ошибка очистки: ${error.message}`);
  }
});

$("#eventList").addEventListener("scroll", () => {
  if (state.scrollRaf) return;
  state.scrollRaf = requestAnimationFrame(() => {
    state.scrollRaf = null;
    updateEventHighlight();
  });
});

$("#syncBtn").addEventListener("click", syncNow);
$("#planImage").addEventListener("load", renderCoverage);
window.addEventListener("resize", renderCoverage);
loadState();
setInterval(() => {
  if (!document.querySelector(".marker.dragging, .marker.rotating")) loadState(state.floorId);
}, 15000);
