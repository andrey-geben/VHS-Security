(function () {
  const state = {
    cameras: [], mode: "building", objectKey: null, detailKey: null, page: 0,
    cols: 3, rows: 2, perPage: 6, signature: "", players: new Map(), timer: null,
  };

  document.body.classList.add("mosaic-body");

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function isRecent(camera) {
    return Number(camera.last_event_ts || 0) > Date.now() / 1000 - 30;
  }

  function buildObjects() {
    const result = new Map();
    for (const camera of state.cameras) {
      const key = `building-${camera.building_id ?? "none"}`;
      if (!result.has(key)) {
        result.set(key, {
          key,
          title: camera.building_name || "Без объекта",
          cameras: [],
        });
      }
      result.get(key).cameras.push(camera);
    }
    return [...result.values()];
  }

  function currentObject() {
    const objects = buildObjects();
    if (!objects.length) return null;
    let object = objects.find((item) => item.key === state.objectKey);
    if (!object) {
      object = objects[0];
      state.objectKey = object.key;
      state.detailKey = null;
      state.page = 0;
    }
    return object;
  }

  function buildDetails(object) {
    if (state.mode === "building") {
      return [{ key: "all", title: object.title, cameras: object.cameras }];
    }
    const result = new Map();
    for (const camera of object.cameras) {
      let key, title;
      if (state.mode === "guard") {
        if (!camera.zone_id) { key = "none"; title = "Без зоны"; }
        else if (camera.effective_armed) { key = "armed"; title = "На охране"; }
        else { key = "disarmed"; title = "Сняты с охраны"; }
      } else {
        key = `floor-${camera.floor_id}`;
        title = camera.floor_name || "Этаж";
      }
      if (!result.has(key)) result.set(key, { key, title, cameras: [] });
      result.get(key).cameras.push(camera);
    }
    return [...result.values()];
  }

  function currentDetail(object) {
    const details = buildDetails(object);
    if (!details.length) return null;
    let detail = details.find((item) => item.key === state.detailKey);
    if (!detail) {
      detail = details[0];
      state.detailKey = detail.key;
      state.page = 0;
    }
    return detail;
  }

  function computeLayout() {
    const stage = document.querySelector(".mosaic-stage");
    const page = document.querySelector(".mosaic-page");
    const width = Math.max(320, stage?.clientWidth || page?.clientWidth || window.innerWidth - 32);
    const height = Math.max(180, stage?.clientHeight || page?.clientHeight - 180 || window.innerHeight - 220);
    const gap = 7;
    const minWidth = 230;
    const cols = Math.max(1, Math.min(6, Math.floor((width + gap) / (minWidth + gap))));
    const tileHeight = ((width - (cols - 1) * gap) / cols) * 9 / 16;
    const rows = Math.max(1, Math.min(4, Math.floor((height + gap) / (tileHeight + gap))));
    state.cols = cols;
    state.rows = rows;
    state.perPage = Math.max(1, cols * rows);
  }

  function teardown() {
    for (const handle of state.players.values()) {
      try { handle.close(); } catch (e) {}
    }
    state.players.clear();
  }

  function updateTile(tile, camera) {
    const armed = !!camera.effective_armed;
    const recent = isRecent(camera) || !!camera.active_alarm;
    tile.classList.toggle("armed", armed);
    tile.classList.toggle("event", recent && !camera.active_alarm);
    tile.classList.toggle("alarm", !!camera.active_alarm);
    const stateEl = tile.querySelector(".mosaic-state");
    if (stateEl) {
      stateEl.textContent = armed ? "на охране" : "снята";
      stateEl.classList.toggle("on", armed);
    }
    const badge = tile.querySelector(".mosaic-badge");
    if (badge) {
      badge.hidden = !recent;
      badge.textContent = camera.active_alarm ? "Тревога" : "Событие";
      badge.classList.toggle("event", !camera.active_alarm);
    }
  }

  async function connectTile(tile, camera) {
    if (!camera.stream_url || state.players.has(camera.id)) return;
    const video = tile.querySelector("video");
    if (!video || !window.VHSWhep) return;
    try {
      const handle = await window.VHSWhep.connect(video, camera.stream_url, {
        onState(status) {
          if (status === "playing") {
            const old = tile.querySelector(".mosaic-player-error");
            if (old) old.remove();
          }
        },
      });
      state.players.set(camera.id, handle);
    } catch (exc) {
      const box = document.createElement("div");
      box.className = "mosaic-player-error";
      box.textContent = `Поток недоступен: ${exc.message}`;
      tile.appendChild(box);
    }
  }

  function renderObjectTabs(objects) {
    const root = document.getElementById("mosaicGroupTabs");
    if (!root) return;
    root.innerHTML = objects.map((object) => (
      `<button type="button" class="mosaic-tab${object.key === state.objectKey ? " active" : ""}" data-object="${esc(object.key)}">${esc(object.title)} <small>${object.cameras.length}</small></button>`
    )).join("");
  }

  function renderDetailTabs(details) {
    const root = document.getElementById("mosaicDetailTabs");
    if (!root) return;
    if (state.mode === "building" || details.length === 0) {
      root.hidden = true;
      root.innerHTML = "";
      return;
    }
    root.hidden = false;
    root.innerHTML = details.map((detail) => (
      `<button type="button" class="mosaic-tab${detail.key === state.detailKey ? " active" : ""}" data-detail="${esc(detail.key)}">${esc(detail.title)} <small>${detail.cameras.length}</small></button>`
    )).join("");
  }

  function renderPager(detail) {
    const root = document.getElementById("mosaicPager");
    if (!root) return;
    const pages = Math.max(1, Math.ceil(detail.cameras.length / state.perPage));
    state.page = Math.max(0, Math.min(state.page, pages - 1));
    if (pages <= 1) { root.innerHTML = ""; return; }
    const buttons = [`<button type="button" class="mosaic-page-btn" data-page="${state.page - 1}" ${state.page === 0 ? "disabled" : ""}>‹</button>`];
    for (let index = 0; index < pages; index += 1) {
      buttons.push(`<button type="button" class="mosaic-page-btn${index === state.page ? " active" : ""}" data-page="${index}">${index + 1}</button>`);
    }
    buttons.push(`<button type="button" class="mosaic-page-btn" data-page="${state.page + 1}" ${state.page >= pages - 1 ? "disabled" : ""}>›</button>`);
    root.innerHTML = buttons.join("");
  }

  function renderGrid(detail) {
    teardown();
    const root = document.getElementById("mosaicGroups");
    if (!root) return;
    root.innerHTML = "";
    if (!detail || !detail.cameras.length) {
      root.innerHTML = '<p class="muted">Камеры не найдены. Проверьте синхронизацию с Viewer.</p>';
      return;
    }
    const start = state.page * state.perPage;
    const cameras = detail.cameras.slice(start, start + state.perPage);
    const section = document.createElement("section");
    section.className = "mosaic-group";
    const grid = document.createElement("div");
    grid.className = "mosaic-grid";
    grid.style.setProperty("--cols", state.cols);
    grid.style.setProperty("--rows", state.rows);

    for (const camera of cameras) {
      const tile = document.createElement("article");
      tile.className = "mosaic-tile";
      tile.dataset.cameraId = camera.id;
      tile.innerHTML = `
        <video autoplay muted playsinline></video>
        <div class="mosaic-placeholder">${camera.stream_url ? "Подключение…" : "Поток не назначен"}</div>
        <span class="mosaic-state">снята</span>
        <span class="mosaic-badge" hidden>Событие</span>
        <div class="mosaic-overlay">
          <b class="mosaic-name">${esc(camera.name)}</b>
          <span class="mosaic-meta">${esc(camera.building_name || "")} · ${esc(camera.floor_name || "")}${camera.zone_name ? ` · ${esc(camera.zone_name)}` : ""}</span>
        </div>`;
      if (camera.stream_url) {
        const placeholder = tile.querySelector(".mosaic-placeholder");
        if (placeholder) placeholder.remove();
      }
      updateTile(tile, camera);
      grid.appendChild(tile);
      connectTile(tile, camera);
    }
    section.appendChild(grid);
    root.appendChild(section);
  }

  function ensureSelection() {
    const object = currentObject();
    const details = object ? buildDetails(object) : [];
    const detail = object ? currentDetail(object) : null;
    return { object, details, detail };
  }

  function render() {
    computeLayout();
    const objects = buildObjects();
    const { object, details, detail } = ensureSelection();
    renderObjectTabs(objects);
    renderDetailTabs(details);
    if (!object || !detail) {
      renderPager({ cameras: [] });
      renderGrid(null);
      return;
    }
    renderPager(detail);
    renderGrid(detail);
    const pages = Math.max(1, Math.ceil(detail.cameras.length / state.perPage));
    const status = document.getElementById("mosaicStatus");
    if (status) {
      status.textContent = `${object.title} · ${detail.title} · камер: ${detail.cameras.length} · страница ${state.page + 1}/${pages}`;
    }
  }

  function updateStatus(data) {
    state.cameras = data.cameras || [];
    const signature = state.cameras.map((c) => `${c.id}:${c.stream_url || ""}`).join("|");
    if (signature !== state.signature) {
      state.signature = signature;
      render();
      return;
    }
    const { object, details, detail } = ensureSelection();
    if (!object || !detail) { render(); return; }
    renderObjectTabs(buildObjects());
    renderDetailTabs(details);
    renderPager(detail);
    const start = state.page * state.perPage;
    for (const camera of detail.cameras.slice(start, start + state.perPage)) {
      const tile = document.querySelector(`[data-camera-id="${camera.id}"]`);
      if (tile) updateTile(tile, camera);
    }
    const pages = Math.max(1, Math.ceil(detail.cameras.length / state.perPage));
    const status = document.getElementById("mosaicStatus");
    if (status) {
      status.textContent = `${object.title} · ${detail.title} · камер: ${detail.cameras.length} · страница ${state.page + 1}/${pages}`;
    }
  }

  async function load(force = false) {
    try {
      const response = await fetch("/api/mosaic", { headers: { Accept: "application/json" } });
      if (response.status === 401) { window.location.href = "/login?next=/mosaic"; return; }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (force) state.signature = "";
      updateStatus(data);
    } catch (exc) {
      const status = document.getElementById("mosaicStatus");
      if (status) status.textContent = `Ошибка загрузки: ${exc.message}`;
    }
  }

  document.getElementById("mosaicGroup")?.addEventListener("change", (event) => {
    state.mode = event.target.value;
    state.objectKey = null;
    state.detailKey = null;
    state.page = 0;
    render();
  });
  document.getElementById("mosaicRefresh")?.addEventListener("click", () => load(true));
  document.getElementById("mosaicGroupTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-object]");
    if (!button) return;
    state.objectKey = button.dataset.object;
    state.detailKey = null;
    state.page = 0;
    render();
  });
  document.getElementById("mosaicDetailTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-detail]");
    if (!button) return;
    state.detailKey = button.dataset.detail;
    state.page = 0;
    render();
  });
  document.getElementById("mosaicPager")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-page]");
    if (!button || button.disabled) return;
    state.page = Number(button.dataset.page);
    render();
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { state.page = 0; render(); }, 150);
  });

  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      const previous = state.perPage;
      computeLayout();
      if (previous !== state.perPage) {
        state.page = 0;
        render();
      }
    }).observe(document.querySelector(".mosaic-stage"));
  }

  load();
  state.timer = setInterval(load, 5000);
  window.addEventListener("beforeunload", () => {
    clearInterval(state.timer);
    teardown();
  });
})();
