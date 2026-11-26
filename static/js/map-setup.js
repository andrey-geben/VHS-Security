(function () {
  const state = { data: null, buildingId: null, floorId: null, search: "", draggingCamera: null, geoMap: null, geoLayer: null, geoSelected: null, drawMode: null, drawPoints: [], zones: [] };
  const $ = (selector) => document.querySelector(selector);
  const CSRF = window.CSRF_TOKEN;

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  async function api(url, options = {}) {
    const headers = Object.assign({ "X-CSRF-Token": CSRF }, options.headers || {});
    if (options.body) headers["Content-Type"] = "application/json";
    const response = await fetch(url, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function setStatus(text) { $("#setupStatus").textContent = text || ""; }

  function selectedBuilding() {
    return (state.data?.buildings || []).find((b) => String(b.id) === String(state.buildingId));
  }

  function isTerritory() {
    return selectedBuilding()?.kind === "territory";
  }

  function selectedFloor() {
    return (state.data?.floors || []).find((f) => String(f.id) === String(state.floorId));
  }

  function floorsForBuilding() {
    return (state.data?.floors || []).filter((f) => String(f.building_id) === String(state.buildingId));
  }

  function renderBuildingSelect() {
    const select = $("#setupBuilding");
    select.innerHTML = (state.data?.buildings || []).map((b) =>
      `<option value="${b.id}">${esc(b.name)}</option>`
    ).join("");
    if (!state.data?.buildings?.length) {
      select.innerHTML = '<option value="">Нет объектов</option>';
      state.buildingId = null;
      return;
    }
    if (!state.data.buildings.some((b) => String(b.id) === String(state.buildingId))) {
      state.buildingId = state.data.buildings[0].id;
    }
    select.value = String(state.buildingId);
  }

  function renderFloorSelect() {
    const select = $("#setupFloor");
    const floors = floorsForBuilding();
    select.innerHTML = floors.map((f) =>
      `<option value="${f.id}">${esc(f.name)}${f.plan_filename ? "" : " · без плана"}</option>`
    ).join("");
    if (!floors.length) {
      select.innerHTML = '<option value="">Нет этажей</option>';
      state.floorId = null;
      return;
    }
    if (!floors.some((f) => String(f.id) === String(state.floorId))) {
      state.floorId = floors[0].id;
    }
    select.value = String(state.floorId);
  }

  function camerasForSelectedFloor() {
    return (state.data?.cameras || []).filter((c) => String(c.floor_id) === String(state.floorId));
  }

  function renderCameras() {
    const root = $("#setupCameras");
    const query = state.search.trim().toLowerCase();
    const cameras = (state.data?.cameras || []).filter((camera) => {
      if (!query) return true;
      return `${camera.name} ${camera.camera_ref} ${camera.building_name} ${camera.floor_name} ${camera.zone_name || ""}`
        .toLowerCase().includes(query);
    });
    $("#setupCameraCount").textContent = String(cameras.length);
    if (!cameras.length) {
      root.innerHTML = '<p class="muted">Камеры не найдены.</p>';
      return;
    }
    const groups = new Map();
    for (const camera of cameras) {
      const key = `${camera.building_name || "Без объекта"} · ${camera.floor_name || "Без этажа"}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(camera);
    }
    root.innerHTML = [...groups.entries()].map(([title, items]) => `
      <div class="tray-group">${esc(title)} · ${items.length}</div>
      ${items.map((camera) => {
        const locked = Number(camera.placed) === 1;
        return `
        <div class="camera-card${locked ? " locked" : ""}" draggable="${locked ? "false" : "true"}" data-camera-id="${camera.id}" title="${locked ? "Камера уже установлена" : "Перетащите на план"}">
          <span class="cam-ico">${locked ? "●" : "◉"}</span>
          <span><b>${esc(camera.name)}</b><small>${esc(camera.camera_ref)}${camera.zone_name ? ` · ${esc(camera.zone_name)}` : ""}${locked ? " · установлена" : " · не установлена"}</small></span>
          ${locked ? `<button type="button" class="camera-unplace" data-unplace="${camera.id}">Снять</button>` : ""}
        </div>`;
      }).join("")}
    `).join("");
  }

  function renderMarkers() {
    const layer = $("#setupMarkers");
    layer.innerHTML = "";
    if (!state.data || !state.floorId) return;
    for (const camera of camerasForSelectedFloor()) {
      const marker = document.createElement("div");
      marker.className = "setup-marker";
      marker.dataset.cameraId = camera.id;
      marker.style.left = `${Number(camera.x) || 0}%`;
      marker.style.top = `${Number(camera.y) || 0}%`;
      marker.innerHTML = `${esc((camera.name || "?").slice(0, 2).toUpperCase())}<span class="setup-marker-label">${esc(camera.name)}</span>`;
      bindMarkerDrag(marker, camera);
      layer.appendChild(marker);
    }
  }

  function geoCameras() {
    return (state.data?.cameras || []).filter((camera) =>
      camera.geo_lat !== null && camera.geo_lat !== undefined &&
      camera.geo_lon !== null && camera.geo_lon !== undefined
    );
  }

  function sectorPoints(lat, lon, azimuth, fov, range) {
    const points = [[lat, lon]];
    const steps = 24;
    for (let index = 0; index <= steps; index += 1) {
      const angle = (Number(azimuth) - Number(fov) / 2 + (Number(fov) * index) / steps) * Math.PI / 180;
      const dLat = (Number(range) * Math.cos(angle)) / 111320;
      const dLon = (Number(range) * Math.sin(angle)) / (111320 * Math.cos(lat * Math.PI / 180));
      points.push([lat + dLat, lon + dLon]);
    }
    return points;
  }

  function initGeoMap() {
    if (!window.L) {
      const stage = $("#setupGeoStage");
      if (stage && !stage.querySelector(".setup-geo-note")) {
        stage.innerHTML = '<div class="setup-geo-note">Гео-карта не загрузилась. Проверьте доступ к библиотеке Leaflet.</div>';
      }
      return false;
    }
    const building = selectedBuilding();
    if (!state.geoMap) {
      state.geoMap = window.L.map("setupGeoStage", { zoomControl: true }).setView(
        [Number(building?.center_lat) || 55.751244, Number(building?.center_lon) || 37.618423],
        Number(building?.geo_zoom) || 16,
      );
      window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap",
      }).addTo(state.geoMap);
    } else {
      state.geoMap.setView(
        [Number(building?.center_lat) || 55.751244, Number(building?.center_lon) || 37.618423],
        Number(building?.geo_zoom) || 16,
      );
    }
    return true;
  }

  function selectGeoCamera(camera) {
    state.geoSelected = camera;
    const tools = $("#geoCameraTools");
    tools.hidden = false;
    $("#geoSelectedName").textContent = camera.name || "";
    $("#geoAzimuth").value = Math.round(Number(camera.geo_azimuth) || 0);
    $("#geoFov").value = Math.round(Number(camera.geo_fov) || 60);
    $("#geoRange").value = Math.round(Number(camera.geo_range_m) || 80);
  }

  function renderGeo() {
    if (!isTerritory()) return;
    if (!initGeoMap()) return;
    if (state.geoLayer) state.geoMap.removeLayer(state.geoLayer);
    state.geoLayer = window.L.layerGroup().addTo(state.geoMap);
    for (const camera of geoCameras()) {
      const lat = Number(camera.geo_lat);
      const lon = Number(camera.geo_lon);
      const fov = Number(camera.geo_fov) || 60;
      const range = Number(camera.geo_range_m) || 80;
      const azimuth = Number(camera.geo_azimuth) || 0;
      window.L.polygon(sectorPoints(lat, lon, azimuth, fov, range), {
        color: "#49c6d4", weight: 1, fillColor: "#49c6d4", fillOpacity: 0.18,
      }).addTo(state.geoLayer);
      const icon = window.L.divIcon({
        className: "",
        html: `<div class="geo-camera-marker">${esc((camera.name || "?").slice(0, 2).toUpperCase())}</div>`,
        iconSize: [28, 28], iconAnchor: [14, 14],
      });
      const marker = window.L.marker([lat, lon], { draggable: true, icon }).addTo(state.geoLayer);
      marker.bindTooltip(camera.name || "", { direction: "top", offset: [0, -14] });
      marker.on("click", () => selectGeoCamera(camera));
      marker.on("dragend", async () => {
        const position = marker.getLatLng();
        try {
          await placeCameraGeo(camera.id, state.floorId, position.lat, position.lng);
          setStatus(`Камера «${camera.name}» установлена.`);
        } catch (error) {
          setStatus(`Ошибка: ${error.message}`);
        }
      });
    }
    setStatus(`${selectedBuilding()?.name || ""} · камер: ${geoCameras().length}`);
  }

  function renderPlan() {
    const floor = selectedFloor();
    const image = $("#setupPlan");
    const empty = $("#setupEmpty");
    const link = $("#setupPlanLink");
    if (isTerritory()) {
      $("#setupStage").hidden = true;
      $("#setupGeoStage").hidden = false;
      image.hidden = true;
      empty.hidden = true;
      link.hidden = true;
      renderGeo();
      return;
    }
    $("#setupStage").hidden = false;
    $("#setupGeoStage").hidden = true;
    $("#geoCameraTools").hidden = true;
    state.geoSelected = null;
    if (!floor) {
      image.hidden = true;
      image.removeAttribute("src");
      empty.hidden = false;
      link.hidden = true;
      setStatus("Выберите этаж.");
      return;
    }
    if (floor.plan_url) {
      image.src = `${floor.plan_url}?v=${Date.now()}`;
      image.hidden = false;
      empty.hidden = true;
      link.hidden = true;
      setStatus(`${floor.building_name} · ${floor.name} · камер: ${camerasForSelectedFloor().length}`);
    } else {
      image.hidden = true;
      image.removeAttribute("src");
      empty.hidden = false;
      link.hidden = false;
      setStatus(`${floor.building_name} · ${floor.name} · план не загружен`);
    }
    renderMarkers();
  }

  function renderAll() {
    renderBuildingSelect();
    renderFloorSelect();
    renderCameras();
    renderPlan();
    renderWallLayer();
    renderZoneOptions();
  }

  function currentCamera(id) {
    return (state.data?.cameras || []).find((c) => String(c.id) === String(id));
  }

  async function placeCamera(cameraId, floorId, x, y, zoneId = null) {
    const result = await api(`/api/cameras/${cameraId}/place`, {
      method: "POST",
      body: JSON.stringify({ floor_id: floorId, x, y, zone_id: zoneId }),
    });
    const camera = currentCamera(cameraId);
    if (camera) {
      const floor = (state.data.floors || []).find((f) => String(f.id) === String(floorId));
      camera.floor_id = floorId;
      camera.floor_name = floor?.name || camera.floor_name;
      camera.building_id = floor?.building_id || camera.building_id;
      camera.building_name = floor?.building_name || camera.building_name;
      camera.x = x;
      camera.y = y;
      camera.zone_id = zoneId;
      camera.zone_name = state.zones.find((z) => String(z.id) === String(zoneId))?.name || "";
    }
    renderCameras();
    renderMarkers();
    renderPlan();
    return result;
  }

  async function placeCameraGeo(cameraId, floorId, lat, lon) {
    await api(`/api/cameras/${cameraId}/place-geo`, {
      method: "POST",
      body: JSON.stringify({ floor_id: floorId, lat, lon }),
    });
    const camera = currentCamera(cameraId);
    if (camera) {
      const floor = (state.data.floors || []).find((f) => String(f.id) === String(floorId));
      camera.floor_id = floorId;
      camera.floor_name = floor?.name || camera.floor_name;
      camera.building_id = floor?.building_id || camera.building_id;
      camera.building_name = floor?.building_name || camera.building_name;
      camera.geo_lat = lat;
      camera.geo_lon = lon;
    }
    renderCameras();
    renderGeo();
  }

  function stagePoint(event) {
    const rect = $("#setupStage").getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)),
      y: Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100)),
    };
  }

  function bindMarkerDrag(marker, camera) {
    let dragging = false;
    marker.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      dragging = true;
      marker.classList.add("dragging");
      marker.setPointerCapture(event.pointerId);
    });
    marker.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const point = stagePoint(event);
      marker.style.left = `${point.x}%`;
      marker.style.top = `${point.y}%`;
      camera.x = point.x;
      camera.y = point.y;
    });
    marker.addEventListener("pointerup", async (event) => {
      if (!dragging) return;
      dragging = false;
      marker.classList.remove("dragging");
      const point = stagePoint(event);
      try {
        await placeCamera(camera.id, state.floorId, point.x, point.y, camera.zone_id || null);
        setStatus(`Камера «${camera.name}» установлена.`);
      } catch (error) {
        setStatus(`Ошибка: ${error.message}`);
      }
    });
  }

  $("#setupCameras").addEventListener("dragstart", (event) => {
    const card = event.target.closest(".camera-card");
    if (!card || card.classList.contains("locked")) return;
    state.draggingCamera = card.dataset.cameraId;
    card.classList.add("dragging");
    event.dataTransfer.setData("text/plain", card.dataset.cameraId);
    event.dataTransfer.effectAllowed = "copy";
  });
  $("#setupCameras").addEventListener("dragend", (event) => {
    event.target.closest(".camera-card")?.classList.remove("dragging");
    state.draggingCamera = null;
    $("#setupStage").classList.remove("drop-target");
  });
  $("#setupCameras").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-unplace]");
    if (!button) return;
    try {
      await api(`/api/cameras/${button.dataset.unplace}/unplace`, { method: "POST" });
      const camera = currentCamera(button.dataset.unplace);
      if (camera) camera.placed = 0;
      renderCameras();
      renderMarkers();
      setStatus("Камера снята с карты.");
    } catch (error) {
      setStatus(`Ошибка: ${error.message}`);
    }
  });
  const stage = $("#setupStage");
  stage.addEventListener("dragover", (event) => {
    if (!state.draggingCamera) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    stage.classList.add("drop-target");
  });
  stage.addEventListener("dragleave", (event) => {
    if (!stage.contains(event.relatedTarget)) stage.classList.remove("drop-target");
  });
  stage.addEventListener("drop", async (event) => {
    event.preventDefault();
    stage.classList.remove("drop-target");
    const cameraId = event.dataTransfer.getData("text/plain") || state.draggingCamera;
    state.draggingCamera = null;
    if (!cameraId || !state.floorId || !selectedFloor()?.plan_url) {
      setStatus("Сначала выберите этаж с загруженным планом.");
      return;
    }
    const point = stagePoint(event);
    const activeZone = $("#setupZoneSelect")?.value;
    const zone = activeZone
      ? state.zones.find((item) => String(item.id) === String(activeZone))
      : zoneAtPoint(point.x, point.y);
    try {
      const result = await placeCamera(cameraId, state.floorId, point.x, point.y, zone?.id || null);
      setStatus(result.warning || `Камера установлена: ${point.x.toFixed(1)}%, ${point.y.toFixed(1)}%.`);
    } catch (error) {
      setStatus(`Ошибка: ${error.message}`);
    }
  });

  $("#setupCameraSearch").addEventListener("input", (event) => {
    state.search = event.target.value;
    renderCameras();
  });
  $("#setupBuilding").addEventListener("change", (event) => {
    state.buildingId = Number(event.target.value);
    state.floorId = null;
    renderFloorSelect();
    renderPlan();
  });
  function wallsList() {
    return selectedFloor()?.walls || [];
  }

  function renderZoneOptions() {
    const select = $("#setupZoneSelect");
    if (!select) return;
    const zones = (state.zones || []).filter((z) => String(z.floor_id) === String(state.floorId));
    select.innerHTML = '<option value="">Без зоны</option>' + zones.map((zone) =>
      `<option value="${zone.id}">${esc(zone.name)}</option>`
    ).join("");
    if (zones.length === 1) select.value = String(zones[0].id);
  }

  function zoneAtPoint(x, y) {
    for (const zone of (state.zones || []).filter((z) => String(z.floor_id) === String(state.floorId))) {
      const points = zone.points || [];
      if (points.length < 3) continue;
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const xi = Number(points[i][0]), yi = Number(points[i][1]);
        const xj = Number(points[j][0]), yj = Number(points[j][1]);
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi) {
          inside = !inside;
        }
      }
      if (inside) return zone;
    }
    return null;
  }

  function renderWallLayer() {
    const svg = $("#setupWallLayer");
    const stage = $("#setupStage");
    if (!svg || !stage) return;
    const width = stage.clientWidth || 1;
    const height = stage.clientHeight || 1;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.innerHTML = "";
    const ns = "http://www.w3.org/2000/svg";
    for (const wall of wallsList()) {
      if (!Array.isArray(wall) || wall.length !== 4) continue;
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", (Number(wall[0]) / 100) * width);
      line.setAttribute("y1", (Number(wall[1]) / 100) * height);
      line.setAttribute("x2", (Number(wall[2]) / 100) * width);
      line.setAttribute("y2", (Number(wall[3]) / 100) * height);
      line.setAttribute("class", "wall-line");
      svg.appendChild(line);
    }
    for (const zone of (state.zones || []).filter((z) => String(z.floor_id) === String(state.floorId))) {
      if (!zone.points || zone.points.length < 3) continue;
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", "M " + zone.points.map(([x, y]) =>
        `${(Number(x) / 100) * width} ${(Number(y) / 100) * height}`
      ).join(" L ") + " Z");
      path.setAttribute("class", "zone-polygon");
      svg.appendChild(path);
    }
    if (state.drawPoints.length) {
      const points = state.drawPoints;
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", "M " + points.map(([x, y]) => `${(x / 100) * width} ${(y / 100) * height}`).join(" L ") + (state.drawMode === "polygon" || state.drawMode === "zone" ? " Z" : ""));
      path.setAttribute("class", "wall-preview");
      svg.appendChild(path);
      for (const [x, y] of points) {
        const circle = document.createElementNS(ns, "circle");
        circle.setAttribute("cx", (x / 100) * width);
        circle.setAttribute("cy", (y / 100) * height);
        circle.setAttribute("r", "4");
        circle.setAttribute("class", "wall-point");
        svg.appendChild(circle);
      }
    }
  }

  async function saveWalls(walls) {
    const response = await api(`/api/floors/${state.floorId}/walls`, {
      method: "POST",
      body: JSON.stringify({ walls }),
    });
    const floor = selectedFloor();
    if (floor) floor.walls = response.walls || walls;
    renderWallLayer();
  }

  function resetWallDrawing() {
    state.drawMode = null;
    state.drawPoints = [];
    $("#setupWallFinish").hidden = true;
    $("#setupWallCancel").hidden = true;
    $("#setupStage").classList.remove("wall-drawing");
    $("#setupWallLine").classList.remove("active");
    $("#setupWallPolygon").classList.remove("active");
    $("#setupZoneDraw").classList.remove("active");
    renderWallLayer();
  }

  async function finishWallDrawing() {
    if (state.drawMode === "line") {
      if (state.drawPoints.length < 2) { setStatus("Нужны две точки."); return; }
      const [a, b] = state.drawPoints;
      await saveWalls([...wallsList(), [a[0], a[1], b[0], b[1]]]);
      resetWallDrawing();
      setStatus("Стена-линия добавлена.");
      return;
    }
    if (state.drawMode === "polygon") {
      if (state.drawPoints.length < 3) { setStatus("Нужно минимум 3 точки."); return; }
      const additions = [];
      for (let i = 0; i < state.drawPoints.length; i += 1) {
        const a = state.drawPoints[i];
        const b = state.drawPoints[(i + 1) % state.drawPoints.length];
        additions.push([a[0], a[1], b[0], b[1]]);
      }
      await saveWalls([...wallsList(), ...additions]);
      resetWallDrawing();
      setStatus("Стена-контур добавлена.");
      return;
    }
    if (state.drawMode === "zone") {
      if (state.drawPoints.length < 3) { setStatus("Нужно минимум 3 точки."); return; }
      const name = window.prompt("Название зоны:");
      if (!name) return;
      try {
        const zone = await api(`/api/floors/${state.floorId}/zones`, {
          method: "POST",
          body: JSON.stringify({ name, points: state.drawPoints }),
        });
        zone.points = state.drawPoints;
        zone.floor_id = state.floorId;
        state.zones.push(zone);
        resetWallDrawing();
        renderZoneOptions();
        setStatus(`Зона «${name}» создана.`);
      } catch (error) {
        setStatus(`Ошибка зоны: ${error.message}`);
      }
    }
  }

  const geoStage = $("#setupGeoStage");
  geoStage.addEventListener("dragover", (event) => {
    if (!state.draggingCamera || !isTerritory()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    geoStage.classList.add("drop-target");
  });
  geoStage.addEventListener("dragleave", () => geoStage.classList.remove("drop-target"));
  geoStage.addEventListener("drop", async (event) => {
    event.preventDefault();
    geoStage.classList.remove("drop-target");
    const cameraId = event.dataTransfer.getData("text/plain") || state.draggingCamera;
    state.draggingCamera = null;
    if (!cameraId || !isTerritory() || !state.geoMap) return;
    const rect = geoStage.getBoundingClientRect();
    const point = state.geoMap.containerPointToLatLng([
      event.clientX - rect.left,
      event.clientY - rect.top,
    ]);
    try {
      await placeCameraGeo(cameraId, state.floorId, point.lat, point.lng);
      setStatus(`Камера установлена на территории: ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}.`);
    } catch (error) {
      setStatus(`Ошибка: ${error.message}`);
    }
  });

  $("#setupWallLine").addEventListener("click", () => {
    resetWallDrawing();
    state.drawMode = "line";
    $("#setupWallFinish").hidden = false;
    $("#setupWallCancel").hidden = false;
    $("#setupWallLine").classList.add("active");
    $("#setupStage").classList.add("wall-drawing");
    setStatus("Кликните начало и конец стены.");
  });
  $("#setupWallPolygon").addEventListener("click", () => {
    resetWallDrawing();
    state.drawMode = "polygon";
    $("#setupWallFinish").hidden = false;
    $("#setupWallCancel").hidden = false;
    $("#setupWallPolygon").classList.add("active");
    $("#setupStage").classList.add("wall-drawing");
    setStatus("Кликайте точки контура, затем «Завершить».");
  });
  $("#setupZoneDraw").addEventListener("click", () => {
    resetWallDrawing();
    state.drawMode = "zone";
    $("#setupWallFinish").hidden = false;
    $("#setupWallCancel").hidden = false;
    $("#setupZoneDraw").classList.add("active");
    $("#setupStage").classList.add("wall-drawing");
    setStatus("Кликайте точки контура зоны, затем «Завершить».");
  });
  $("#setupWallFinish").addEventListener("click", finishWallDrawing);
  $("#setupWallCancel").addEventListener("click", resetWallDrawing);
  $("#setupWallsClear").addEventListener("click", async () => {
    if (!state.floorId) return;
    try {
      await saveWalls([]);
      setStatus("Стены очищены.");
    } catch (error) { setStatus(`Ошибка: ${error.message}`); }
  });
  $("#setupStage").addEventListener("click", (event) => {
    if (!state.drawMode || event.target.closest(".setup-marker")) return;
    const point = stagePoint(event);
    state.drawPoints.push([point.x, point.y]);
    if (state.drawMode === "line" && state.drawPoints.length >= 2) {
      finishWallDrawing();
      return;
    }
    renderWallLayer();
  });

  $("#setupSaveMap").addEventListener("click", async () => {
    if (!state.floorId) { setStatus("Выберите этаж."); return; }
    if (state.drawMode) { setStatus("Сначала завершите рисование."); return; }
    try {
      await saveWalls(wallsList());
      setStatus("Карта сохранена.");
    } catch (error) {
      setStatus(`Ошибка сохранения: ${error.message}`);
    }
  });

  $("#setupFloor").addEventListener("change", (event) => {
    state.floorId = Number(event.target.value);
    resetWallDrawing();
    renderPlan();
    renderWallLayer();
  });

  $("#geoSaveView").addEventListener("click", async () => {
    if (!state.geoSelected) return;
    const camera = state.geoSelected;
    const azimuth = Number($("#geoAzimuth").value) || 0;
    const fov = Number($("#geoFov").value) || 60;
    const range = Number($("#geoRange").value) || 80;
    try {
      await api(`/api/cameras/${camera.id}/geo-view`, {
        method: "POST",
        body: JSON.stringify({ azimuth, fov, range_m: range }),
      });
      camera.geo_azimuth = azimuth;
      camera.geo_fov = fov;
      camera.geo_range_m = range;
      renderGeo();
      selectGeoCamera(camera);
      setStatus(`Сектор камеры «${camera.name}» обновлён.`);
    } catch (error) {
      setStatus(`Ошибка: ${error.message}`);
    }
  });

  async function load() {
    try {
      state.data = await api("/api/map-setup");
      state.zones = state.data.zones || [];
      const params = new URLSearchParams(window.location.search);
      const queryBuilding = Number(params.get("building_id"));
      const queryFloor = Number(params.get("floor_id"));
      if (queryBuilding) state.buildingId = queryBuilding;
      if (queryFloor) state.floorId = queryFloor;
      if (!state.buildingId && state.data.buildings.length) state.buildingId = state.data.buildings[0].id;
      if (!state.floorId) {
        const first = state.data.floors.find((f) => String(f.building_id) === String(state.buildingId));
        if (first) state.floorId = first.id;
      }
      renderAll();
    } catch (error) {
      setStatus(`Ошибка загрузки: ${error.message}`);
    }
  }

  load();
})();
