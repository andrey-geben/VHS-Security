(function () {
  const state = { data: null, buildingId: null, floorId: null, search: "", draggingCamera: null };
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

  function renderPlan() {
    const floor = selectedFloor();
    const image = $("#setupPlan");
    const empty = $("#setupEmpty");
    const link = $("#setupPlanLink");
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
  $("#setupFloor").addEventListener("change", (event) => {
    state.floorId = Number(event.target.value);
    renderPlan();
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
