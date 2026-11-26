(function () {
  const state = { cameras: [], mode: "floor", signature: "", players: new Map(), timer: null };

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function isRecent(camera) {
    return Number(camera.last_event_ts || 0) > Date.now() / 1000 - 30;
  }

  function groups() {
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
      if (!result.has(key)) result.set(key, { title, cameras: [] });
      result.get(key).cameras.push(camera);
    }
    return [...result.values()];
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
    const error = tile.querySelector(".mosaic-player-error");
    if (error) error.remove();
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

  function build() {
    teardown();
    const root = document.getElementById("mosaicGroups");
    root.innerHTML = "";
    for (const group of groups()) {
      const section = document.createElement("section");
      section.className = "mosaic-group";
      const head = document.createElement("h2");
      head.className = "mosaic-group-head";
      head.innerHTML = `${esc(group.title)} <span>${group.cameras.length} кам.</span>`;
      section.appendChild(head);
      const grid = document.createElement("div");
      grid.className = "mosaic-grid";
      for (const camera of group.cameras) {
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
    if (!state.cameras.length) {
      root.innerHTML = '<p class="muted">Камеры не найдены. Проверьте синхронизацию с Viewer.</p>';
    }
  }

  function updateStatus(data) {
    state.cameras = data.cameras || [];
    const signature = state.cameras.map((c) => `${c.id}:${c.stream_url || ""}`).join("|");
    if (signature !== state.signature) {
      state.signature = signature;
      build();
    } else {
      for (const camera of state.cameras) {
        const tile = document.querySelector(`[data-camera-id="${camera.id}"]`);
        if (tile) updateTile(tile, camera);
      }
    }
    const status = document.getElementById("mosaicStatus");
    if (status) status.textContent = `Камер: ${state.cameras.length} · обновлено ${new Date().toLocaleTimeString("ru-RU")}`;
  }

  async function load() {
    try {
      const response = await fetch("/api/mosaic", { headers: { Accept: "application/json" } });
      if (response.status === 401) { window.location.href = "/login?next=/mosaic"; return; }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      updateStatus(await response.json());
    } catch (exc) {
      const status = document.getElementById("mosaicStatus");
      if (status) status.textContent = `Ошибка загрузки: ${exc.message}`;
    }
  }

  document.getElementById("mosaicGroup")?.addEventListener("change", (event) => {
    state.mode = event.target.value;
    build();
  });
  document.getElementById("mosaicRefresh")?.addEventListener("click", load);

  load();
  state.timer = setInterval(load, 5000);
  window.addEventListener("beforeunload", () => {
    clearInterval(state.timer);
    teardown();
  });
})();
