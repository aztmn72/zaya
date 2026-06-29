const state = {
  token: localStorage.getItem("zaya_token") || "",
  user: null,
  devices: [],
  authMode: "login"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(path, { ...options, headers });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || "request_failed");
  return data;
}

function showAuth(show) {
  $("#auth-view").classList.toggle("hidden", !show);
  $$(".view").forEach((view) => view.classList.add("hidden"));
  $(".tabs").classList.toggle("hidden", show);
}

function showView(name) {
  if (!state.user) return showAuth(true);
  showAuth(false);
  $$(".view").forEach((view) => view.classList.add("hidden"));
  $(`#${name}-view`).classList.remove("hidden");
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === name));
  if (name === "admin") loadAdmin();
}

function renderAccount() {
  $("#account-line").textContent = `${state.user.name} / ${state.user.email}`;
  $("#plan-name").textContent = state.user.plan;
  $("#zone-limit").textContent = state.user.zoneLimit;
  $$(".admin-only").forEach((el) => el.classList.toggle("hidden", state.user.role !== "admin"));
}

function renderDevices() {
  const list = $("#devices-list");
  if (!state.devices.length) {
    list.innerHTML = `<div class="device-card"><strong>Устройств пока нет</strong><span class="muted">Добавьте ESP32 по коду с этикетки.</span></div>`;
    return;
  }
  list.innerHTML = state.devices.map((device) => {
    const online = device.status === "online";
    const seen = device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : "ещё не выходило в сеть";
    return `
      <article class="device-card ${online ? "online" : ""}">
        <div class="row">
          <strong>${escapeHtml(device.name)}</strong>
          <span class="pill ${online ? "green" : "orange"}">${online ? "online" : device.status}</span>
        </div>
        <div class="row"><span class="muted">Device ID</span><span>${escapeHtml(device.localDeviceId)}</span></div>
        <div class="row"><span class="muted">Зоны</span><span>${device.zoneLimit} / ${device.maxZones}</span></div>
        <div class="row"><span class="muted">Прошивка</span><span>${escapeHtml(device.firmware || "неизвестно")}</span></div>
        <small class="muted">Последний сигнал: ${seen}</small>
      </article>
    `;
  }).join("");
}

function renderDemoZones() {
  const names = ["Газон", "Цветник", "Теплица", "Терраса", "Огород", "Деревья", "Сад", "Резерв"];
  $("#demo-zones").innerHTML = names.map((name, index) => {
    const locked = index >= state.user?.zoneLimit;
    return `
      <div class="zone-card">
        <div class="row">
          <strong>${index + 1}. ${name}</strong>
          <span class="pill ${locked ? "orange" : "green"}">${locked ? "закрыто" : "доступно"}</span>
        </div>
        <small class="muted">Влажность ${42 + index * 3}%</small>
      </div>
    `;
  }).join("");
}

async function loadMe() {
  if (!state.token) return showAuth(true);
  try {
    const data = await api("/api/me");
    state.user = data.user;
    state.devices = data.devices;
    renderAccount();
    renderDevices();
    renderDemoZones();
    showView("dashboard");
  } catch {
    localStorage.removeItem("zaya_token");
    state.token = "";
    state.user = null;
    showAuth(true);
  }
}

async function loadAdmin() {
  if (state.user?.role !== "admin") return;
  const [usersData, devicesData] = await Promise.all([
    api("/api/admin/users"),
    api("/api/admin/devices")
  ]);
  $("#admin-users").innerHTML = usersData.users.map((user) => `
    <div class="admin-row">
      <div class="row">
        <strong>${escapeHtml(user.name)}</strong>
        <span class="pill">${user.role}</span>
      </div>
      <small class="muted">${escapeHtml(user.email)} / устройств: ${user.devicesCount}</small>
      <div class="admin-actions">
        <select data-user-plan="${user.id}">
          <option value="free" ${user.plan === "free" ? "selected" : ""}>Free / 4</option>
          <option value="plus" ${user.plan === "plus" ? "selected" : ""}>Plus / 8</option>
          <option value="pro" ${user.plan === "pro" ? "selected" : ""}>Pro / 16</option>
          <option value="founder" ${user.plan === "founder" ? "selected" : ""}>Founder / 16</option>
        </select>
        <button class="primary" data-grant="${user.id}">Выдать</button>
      </div>
    </div>
  `).join("");

  $("#admin-devices").innerHTML = devicesData.devices.length
    ? devicesData.devices.map((device) => `
      <div class="admin-row">
        <div class="row">
          <strong>${escapeHtml(device.name)}</strong>
          <span class="pill ${device.status === "online" ? "green" : "orange"}">${device.status}</span>
        </div>
        <small class="muted">${escapeHtml(device.localDeviceId)} / зон ${device.zoneLimit}/${device.maxZones}</small>
      </div>
    `).join("")
    : `<div class="admin-row"><strong>Устройств нет</strong></div>`;

  $$("[data-grant]").forEach((button) => {
    button.addEventListener("click", async () => {
      const userId = button.dataset.grant;
      const plan = $(`[data-user-plan="${userId}"]`).value;
      await api(`/api/admin/users/${userId}/grant`, {
        method: "POST",
        body: JSON.stringify({ plan, note: "manual admin grant" })
      });
      await loadAdmin();
      if (state.user.id === userId) await loadMe();
    });
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

$$("[data-view]").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

$$("[data-auth-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    state.authMode = button.dataset.authMode;
    $$("[data-auth-mode]").forEach((item) => item.classList.toggle("active", item === button));
    $$(".register-field").forEach((field) => field.classList.toggle("hidden", state.authMode !== "register"));
  });
});

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  $("#auth-message").textContent = "";
  try {
    const endpoint = state.authMode === "register" ? "/api/auth/register" : "/api/auth/login";
    const data = await api(endpoint, {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        email: form.get("email"),
        password: form.get("password")
      })
    });
    state.token = data.token;
    localStorage.setItem("zaya_token", state.token);
    await loadMe();
  } catch (error) {
    $("#auth-message").textContent = `Ошибка: ${error.message}`;
  }
});

$("#claim-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  $("#claim-message").textContent = "";
  try {
    await api("/api/devices/claim", {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        pairingCode: form.get("pairingCode"),
        localDeviceId: form.get("localDeviceId")
      })
    });
    $("#claim-message").textContent = "Устройство добавлено.";
    event.currentTarget.reset();
    await loadMe();
  } catch (error) {
    $("#claim-message").textContent = `Ошибка: ${error.message}`;
  }
});

$("#refresh-devices").addEventListener("click", loadMe);
$("#refresh-admin").addEventListener("click", loadAdmin);
$("#logout-button").addEventListener("click", () => {
  localStorage.removeItem("zaya_token");
  state.token = "";
  state.user = null;
  showAuth(true);
});

loadMe();
