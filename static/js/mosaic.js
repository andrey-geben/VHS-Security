(function () {
  const state = {
    cameras: [], mode: "floor", groupKey: null, page: 0,
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

  function buildGroups() {
    const result = new Map();
    for (const camera of state.cameras) {
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

  function currentGroup() {
    const groups = buildGroups();
    if (!groups.length) return null;
    let group = groups.find((item) => item.key === state.groupKey);
    if (!group) {
      group = groups[0];
      state.groupKey = group.key;
      state.page = 0;
    }
    return group;
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

  function renderTabs(groups) {
    const root = document.getElementById("mosaicGroupTabs");
    if (!root) return;
    root.innerHTML = groups.map((group) => (
      `<button type="button" class="mosaic-tab${group.key === state.groupKey ? " active" : ""}" data-group="${esc(group.key)}">${esc(group.title)} <small>${group.cameras.length}</small></button>`
    )).join("");
  }

  function renderPager(group) {
    const root = document.getElementById("mosaicPager");
    if (!root) return;
    const pages = Math.max(1, Math.ceil(group.cameras.length / state.perPage));
    state.page = Math.max(0, Math.min(state.page, pages - 1));
    if (pages <= 1) { root.innerHTML = ""; return; }
    const buttons = [`<button type="button" class="mosaic-page-btn" data-page="${state.page - 1}" ${state.page === 0 ? "disabled" : ""}>‹</button>`];
    for (let index = 0; index < pages; index += 1) {
      buttons.push(`<button type="button" class="mosaic-page-btn${index === state.page ? " active" : ""}" data-page="${index}">${index + 1}</button>`);
    }
    buttons.push(`<button type="button" class="mosaic-page-btn" data-page="${state.page + 1}" ${state.page >= pages - 1 ? "disabled" : ""}>›</button>`);
    root.innerHTML = buttons.join("");
  }

  function renderGrid(group) {
    teardown();
    const root = document.getElementById("mosaicGroups");
    if (!root) return;
    root.innerHTML = "";
    if (!group || !group.cameras.length) {
      root.innerHTML = '<p class="muted">Камеры не найдены. Проверьте синхронизацию с Viewer.</p>';
      return;
    }
    const start = state.page * state.perPage;
    const cameras = group.cameras.slice(start, start + state.perPage);
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
          <span class="mosaic-meta">${esc(camera.floor_name || "")}${camera.zone_name ? ` · ${esc(camera.zone_name)}` : ""}</span>
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

  function render() {
    computeLayout();
    const groups = buildGroups();
    currentGroup();
    renderTabs(groups);
    const group = currentGroup();
    if (!group) {
      renderPager({ cameras: [] });
      renderGrid(null);
      return;
    }
    renderPager(group);
    renderGrid(group);
    const pages = Math.max(1, Math.ceil(group.cameras.length / state.perPage));
    const status = document.getElementById("mosaicStatus");
    if (status) {
      status.textContent = `Камер: ${state.cameras.length} · страница ${state.page + 1}/${pages}`;
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
    const group = currentGroup();
    if (!group) { render(); return; }
    renderTabs(buildGroups());
    renderPager(group);
    const start = state.page * state.perPage;
    const pageCameras = group.cameras.slice(start, start + state.perPage);
    for (const camera of pageCameras) {
      const tile = document.querySelector(`[data-camera-id="${camera.id}"]`);
      if (tile) updateTile(tile, camera);
    }
    const pages = Math.max(1, Math.ceil(group.cameras.length / state.perPage));
    const status = document.getElementById("mosaicStatus");
    if (status) {
      status.textContent = `Камер: ${state.cameras.length} · страница ${state.page + 1}/${pages}`;
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
    state.groupKey = null;
    state.page = 0;
    render();
  });
  document.getElementById("mosaicRefresh")?.addEventListener("click", () => load(true));
  document.getElementById("mosaicGroupTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-group]");
    if (!button) return;
    state.groupKey = button.dataset.group;
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
