(function () {
  const state = { data: null, buildingId: null, floorId: null, search: "", draggingCamera: null, geoMap: null, geoLayer: null, geoSelected: null };
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
      ${items.map((camera) => `
        <div class="camera-card" draggable="true" data-camera-id="${camera.id}" title="Перетащите на план">
          <span class="cam-ico">◉</span>
          <span><b>${esc(camera.name)}</b><small>${esc(camera.camera_ref)}${camera.zone_name ? ` · ${esc(camera.zone_name)}` : ""}</small></span>
        </div>`).join("")}
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
  }

  function currentCamera(id) {
    return (state.data?.cameras || []).find((c) => String(c.id) === String(id));
  }

  async function placeCamera(cameraId, floorId, x, y) {
    await api(`/api/cameras/${cameraId}/place`, {
      method: "POST",
      body: JSON.stringify({ floor_id: floorId, x, y }),
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
    }
    renderCameras();
    renderMarkers();
    renderPlan();
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
        await placeCamera(camera.id, state.floorId, point.x, point.y);
        setStatus(`Камера «${camera.name}» установлена.`);
      } catch (error) {
        setStatus(`Ошибка: ${error.message}`);
      }
    });
  }

  $("#setupCameras").addEventListener("dragstart", (event) => {
    const card = event.target.closest(".camera-card");
    if (!card) return;
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
    try {
      await placeCamera(cameraId, state.floorId, point.x, point.y);
      setStatus(`Камера установлена: ${point.x.toFixed(1)}%, ${point.y.toFixed(1)}%.`);
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

  $("#setupFloor").addEventListener("change", (event) => {
    state.floorId = Number(event.target.value);
    renderPlan();
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
