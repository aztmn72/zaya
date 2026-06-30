import { createHmac, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(rootDir, "public");
const dataDir = process.env.ZAYA_DATA_DIR || join(rootDir, "data");
const dbPath = join(dataDir, "zaya-db.json");
const port = Number(process.env.PORT || 8787);
const sessionSecret = process.env.ZAYA_SESSION_SECRET || "zaya-dev-secret-change-before-production";
const databaseUrl = (process.env.DATABASE_URL || "").trim();
let pgPool = null;

const plans = {
  free: { name: "Free", zoneLimit: 4 },
  plus: { name: "Plus", zoneLimit: 8 },
  pro: { name: "Pro", zoneLimit: 16 },
  founder: { name: "Founder", zoneLimit: 16 }
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  return safeEqual(hashPassword(password, salt).split(":")[1], hash);
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", sessionSecret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readSession(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", sessionSecret).update(body).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (payload.expiresAt && Date.parse(payload.expiresAt) < Date.now()) return null;
  return payload;
}

async function loadDb() {
  if (databaseUrl) return loadPostgresDb();

  await mkdir(dataDir, { recursive: true });
  try {
    return JSON.parse(await readFile(dbPath, "utf8"));
  } catch {
    const db = {
      users: [],
      devices: [],
      commands: [],
      events: [],
      createdAt: nowIso()
    };
    await saveDb(db);
    return db;
  }
}

async function saveDb(db) {
  if (databaseUrl) {
    await savePostgresDb(db);
    return;
  }

  await mkdir(dataDir, { recursive: true });
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

function emptyDb() {
  return {
    users: [],
    devices: [],
    commands: [],
    events: [],
    leads: [],
    createdAt: nowIso()
  };
}

async function getPgPool() {
  if (pgPool) return pgPool;
  validateDatabaseUrl();
  const { Pool } = await import("pg");
  pgPool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false }
  });
  await pgPool.query(`
    create table if not exists zaya_state (
      id text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);
  return pgPool;
}

function validateDatabaseUrl() {
  if (!databaseUrl) return;
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(
      "DATABASE_URL is invalid. It must look like postgresql://USER:PASSWORD@HOST:PORT/DATABASE"
    );
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
    throw new Error(
      "DATABASE_URL is invalid. Copy the full Supabase/Postgres URI, not only the password or project name."
    );
  }
}

async function databaseStatus() {
  if (!databaseUrl) return { configured: false, storage: "json" };
  try {
    validateDatabaseUrl();
    const pool = await getPgPool();
    await pool.query("select 1");
    return { configured: true, storage: "postgres", connected: true };
  } catch (error) {
    return {
      configured: true,
      storage: "postgres",
      connected: false,
      error: error.message
    };
  }
}

async function loadPostgresDb() {
  const pool = await getPgPool();
  const result = await pool.query("select data from zaya_state where id = $1", ["main"]);
  if (result.rows[0]?.data) return result.rows[0].data;
  const db = emptyDb();
  await savePostgresDb(db);
  return db;
}

async function savePostgresDb(db) {
  const pool = await getPgPool();
  await pool.query(
    `insert into zaya_state (id, data, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (id) do update set data = excluded.data, updated_at = now()`,
    ["main", JSON.stringify(db)]
  );
}

function send(res, status, body, headers = {}) {
  const data = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(data);
}

function sendError(res, status, message) {
  send(res, status, { ok: false, error: message });
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  return JSON.parse(raw);
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function userFromRequest(req, db) {
  const session = readSession(bearerToken(req));
  if (!session?.userId) return null;
  return db.users.find((user) => user.id === session.userId) || null;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    plan: user.plan,
    zoneLimit: user.zoneLimit,
    subscriptionExpiresAt: user.subscriptionExpiresAt || null
  };
}

function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    ownerUserId: device.ownerUserId,
    localDeviceId: device.localDeviceId,
    pairingCodeHint: device.pairingCodeHint,
    maxZones: device.maxZones,
    zoneLimit: device.zoneLimit,
    status: device.status,
    lastSeenAt: device.lastSeenAt || null,
    ip: device.ip || null,
    firmware: device.firmware || null,
    telemetry: device.telemetry || null,
    createdAt: device.createdAt
  };
}

function requireUser(req, res, db) {
  const user = userFromRequest(req, db);
  if (!user) sendError(res, 401, "auth_required");
  return user;
}

function requireAdmin(req, res, db) {
  const user = requireUser(req, res, db);
  if (!user) return null;
  if (user.role !== "admin") {
    sendError(res, 403, "admin_required");
    return null;
  }
  return user;
}

function routeKey(method, pathname) {
  return `${method.toUpperCase()} ${pathname}`;
}

async function api(req, res, pathname) {
  if (routeKey(req.method, pathname) === "GET /api/health") {
    const dbStatus = await databaseStatus();
    return send(res, 200, {
      ok: true,
      status: "online",
      database: dbStatus,
      time: nowIso()
    });
  }

  let db;
  try {
    db = await loadDb();
  } catch (error) {
    console.error(error);
    return send(res, 503, {
      ok: false,
      error: "database_unavailable",
      message: error.message
    });
  }

  if (routeKey(req.method, pathname) === "POST /api/auth/register") {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    const name = String(body.name || "").trim();
    if (!email || password.length < 6 || !name) return sendError(res, 400, "invalid_registration");
    if (db.users.some((user) => user.email === email)) return sendError(res, 409, "email_exists");

    const firstUser = db.users.length === 0;
    const user = {
      id: randomUUID(),
      name,
      email,
      passwordHash: hashPassword(password),
      role: firstUser ? "admin" : "owner",
      plan: firstUser ? "founder" : "free",
      zoneLimit: firstUser ? 16 : 4,
      subscriptionExpiresAt: null,
      createdAt: nowIso()
    };
    db.users.push(user);
    await saveDb(db);
    const token = signSession({ userId: user.id, expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString() });
    return send(res, 201, { ok: true, token, user: publicUser(user) });
  }

  if (routeKey(req.method, pathname) === "POST /api/auth/login") {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const user = db.users.find((item) => item.email === email);
    if (!user || !verifyPassword(body.password, user.passwordHash)) return sendError(res, 401, "invalid_credentials");
    const token = signSession({ userId: user.id, expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString() });
    return send(res, 200, { ok: true, token, user: publicUser(user) });
  }

  if (routeKey(req.method, pathname) === "GET /api/me") {
    const user = requireUser(req, res, db);
    if (!user) return;
    const devices = db.devices.filter((device) => device.ownerUserId === user.id).map(publicDevice);
    return send(res, 200, { ok: true, user: publicUser(user), devices, plans });
  }

  if (routeKey(req.method, pathname) === "GET /api/devices") {
    const user = requireUser(req, res, db);
    if (!user) return;
    return send(res, 200, {
      ok: true,
      devices: db.devices.filter((device) => device.ownerUserId === user.id).map(publicDevice)
    });
  }

  if (routeKey(req.method, pathname) === "POST /api/devices/claim") {
    const user = requireUser(req, res, db);
    if (!user) return;
    const body = await readJson(req);
    const pairingCode = String(body.pairingCode || "").trim().toUpperCase();
    const localDeviceId = String(body.localDeviceId || `zaya-${pairingCode.slice(-6)}`).trim();
    if (!pairingCode.startsWith("ZAYA-")) return sendError(res, 400, "invalid_pairing_code");

    let device = db.devices.find((item) => item.localDeviceId === localDeviceId || item.pairingCode === pairingCode);
    if (device && device.ownerUserId !== user.id) return sendError(res, 409, "device_already_claimed");
    if (!device) {
      device = {
        id: randomUUID(),
        name: String(body.name || "ZAYA ESP32").trim(),
        ownerUserId: user.id,
        localDeviceId,
        pairingCode,
        pairingCodeHint: `${pairingCode.slice(0, 5)}****`,
        cloudSecret: randomBytes(24).toString("hex"),
        maxZones: 16,
        zoneLimit: user.zoneLimit,
        status: "pending",
        telemetry: null,
        commandsEnabled: true,
        createdAt: nowIso()
      };
      db.devices.push(device);
    } else {
      device.name = String(body.name || device.name).trim();
      device.zoneLimit = user.zoneLimit;
    }
    await saveDb(db);
    return send(res, 200, {
      ok: true,
      device: publicDevice(device),
      cloudProvisioning: {
        deviceId: device.id,
        cloudSecret: device.cloudSecret,
        apiBaseUrl: body.apiBaseUrl || `http://localhost:${port}`
      }
    });
  }

  const deviceTelemetryMatch = pathname.match(/^\/api\/devices\/([^/]+)\/telemetry$/);
  if (req.method === "POST" && deviceTelemetryMatch) {
    const device = db.devices.find((item) => item.id === deviceTelemetryMatch[1]);
    if (!device) return sendError(res, 404, "device_not_found");
    const secret = req.headers["x-zaya-device-secret"];
    if (!secret || !safeEqual(secret, device.cloudSecret)) return sendError(res, 401, "device_auth_required");
    const body = await readJson(req);
    device.telemetry = body;
    device.status = "online";
    device.ip = req.socket.remoteAddress;
    device.firmware = body.firmware || device.firmware || null;
    device.lastSeenAt = nowIso();
    await saveDb(db);
    return send(res, 200, { ok: true });
  }

  const commandMatch = pathname.match(/^\/api\/devices\/([^/]+)\/commands$/);
  if (req.method === "POST" && commandMatch) {
    const user = requireUser(req, res, db);
    if (!user) return;
    const device = db.devices.find((item) => item.id === commandMatch[1] && item.ownerUserId === user.id);
    if (!device) return sendError(res, 404, "device_not_found");
    const body = await readJson(req);
    const zone = Number(body.zone || 0);
    if (zone > device.zoneLimit) return sendError(res, 402, "zone_locked_by_plan");
    const command = {
      id: randomUUID(),
      deviceId: device.id,
      userId: user.id,
      payload: body,
      status: "pending",
      createdAt: nowIso()
    };
    db.commands.push(command);
    await saveDb(db);
    return send(res, 201, { ok: true, command });
  }

  const pendingCommandsMatch = pathname.match(/^\/api\/devices\/([^/]+)\/commands\/pending$/);
  if (req.method === "GET" && pendingCommandsMatch) {
    const device = db.devices.find((item) => item.id === pendingCommandsMatch[1]);
    if (!device) return sendError(res, 404, "device_not_found");
    const secret = req.headers["x-zaya-device-secret"];
    if (!secret || !safeEqual(secret, device.cloudSecret)) return sendError(res, 401, "device_auth_required");
    const commands = db.commands.filter((command) => command.deviceId === device.id && command.status === "pending");
    return send(res, 200, { ok: true, commands });
  }

  const commandAckMatch = pathname.match(/^\/api\/devices\/([^/]+)\/commands\/([^/]+)\/ack$/);
  if (req.method === "POST" && commandAckMatch) {
    const device = db.devices.find((item) => item.id === commandAckMatch[1]);
    if (!device) return sendError(res, 404, "device_not_found");
    const secret = req.headers["x-zaya-device-secret"];
    if (!secret || !safeEqual(secret, device.cloudSecret)) return sendError(res, 401, "device_auth_required");
    const command = db.commands.find((item) => item.id === commandAckMatch[2] && item.deviceId === device.id);
    if (!command) return sendError(res, 404, "command_not_found");
    const body = await readJson(req);
    command.status = body.ok === false ? "failed" : "done";
    command.result = body;
    command.ackedAt = nowIso();
    await saveDb(db);
    return send(res, 200, { ok: true });
  }

  if (routeKey(req.method, pathname) === "GET /api/admin/users") {
    const admin = requireAdmin(req, res, db);
    if (!admin) return;
    return send(res, 200, {
      ok: true,
      users: db.users.map((user) => ({
        ...publicUser(user),
        devicesCount: db.devices.filter((device) => device.ownerUserId === user.id).length
      }))
    });
  }

  if (routeKey(req.method, pathname) === "GET /api/admin/devices") {
    const admin = requireAdmin(req, res, db);
    if (!admin) return;
    return send(res, 200, { ok: true, devices: db.devices.map(publicDevice) });
  }

  const grantMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/grant$/);
  if (req.method === "POST" && grantMatch) {
    const admin = requireAdmin(req, res, db);
    if (!admin) return;
    const user = db.users.find((item) => item.id === grantMatch[1]);
    if (!user) return sendError(res, 404, "user_not_found");
    const body = await readJson(req);
    const plan = String(body.plan || "free");
    const planInfo = plans[plan] || plans.free;
    user.plan = plan;
    user.zoneLimit = Number(body.zoneLimit || planInfo.zoneLimit);
    user.subscriptionExpiresAt = body.expiresAt || null;
    user.grantNote = body.note || "";
    for (const device of db.devices.filter((item) => item.ownerUserId === user.id)) {
      device.zoneLimit = user.zoneLimit;
    }
    await saveDb(db);
    return send(res, 200, { ok: true, user: publicUser(user) });
  }

  // =============================================
  // LEAD API
  // =============================================
  if (routeKey(req.method, pathname) === "POST /api/lead") {
    const body = await readJson(req);

    // Honeypot check
    if (body.website && body.website.trim() !== "") return send(res, 200, { success: true });

    // Honeypot: form submitted too fast (< 3 seconds) = bot
    if (body.form_ts) {
      const ts = parseInt(body.form_ts);
      if (!isNaN(ts) && (Date.now() - ts) < 3000) return send(res, 200, { success: true });
    }

    const { name, phone, email, topic, message, source, device_type, os, browser, user_agent, utm_source, utm_medium, utm_campaign, utm_content, utm_term, referer, current_url, time_on_page, viewed_controller4, browser_tz, visit_count, pages_viewed } = body;

    if (!name || !phone) return sendError(res, 400, "name_and_phone_required");

    // Normalize phone
    let normalizedPhone = String(phone || "").trim();
    let phoneDigits = normalizedPhone.replace(/\D/g, "");
    if (phoneDigits.startsWith("8") && phoneDigits.length <= 11) phoneDigits = "7" + phoneDigits.slice(1);
    if (phoneDigits.length === 11 && phoneDigits.startsWith("7")) normalizedPhone = "+7 " + phoneDigits.slice(1, 4) + " " + phoneDigits.slice(4, 7) + "-" + phoneDigits.slice(7, 9) + "-" + phoneDigits.slice(9, 11);

    // Lead number
    if (!db.leads) db.leads = [];
    const leadNumber = db.leads.length + 1;
    const lead_id = `ZAYA-${String(leadNumber).padStart(6, "0")}`;

    console.log(`📥 New lead: #${leadNumber} ${name} (${normalizedPhone})`);

    const lead = {
      lead_id, name, phone: normalizedPhone, email: email || "", topic: topic || "",
      message: message || "", source: source || "zaya-website",
      device_type: device_type || "", os: os || "", browser: browser || "",
      utm_source: utm_source || "", utm_medium: utm_medium || "", utm_campaign: utm_campaign || "",
      utm_content: utm_content || "", utm_term: utm_term || "",
      referer: referer || "", current_url: current_url || "",
      time_on_page: time_on_page || 0, viewed_controller4: viewed_controller4 || false,
      browser_tz: browser_tz || "", visit_count: visit_count || 1,
      created_at: nowIso()
    };
    db.leads.push(lead);
    await saveDb(db);

    // Send notifications BEFORE response (Render free tier may kill process after res.end)
    try {
      const SEP = "────────────────";
      let tgMsg = `НОВАЯ ЗАЯВКА\n\n№ ${lead_id}\n\n👤 ${name}\n📱 ${normalizedPhone}\n📧 ${email || "Не указан"}\n\n📋 Интерес:\n${topic || "Не указана"}\n\n💬 Сообщение:\n${message || "Без сообщения"}`;
      tgMsg += `\n\n${SEP}\n\n📱 ${device_type || "—"}\n💻 ${os || "—"}\n🌐 ${browser || "—"}`;
      tgMsg += `\n\n⏱ На сайте: ${time_on_page || 0} сек`;
      if (visit_count > 1) tgMsg += `\n🔄 Визитов: ${visit_count}`;
      if (utm_source) tgMsg += `\n\n📢 UTM: ${utm_source}`;
      tgMsg += `\n\n📅 ${new Date().toLocaleString("ru-RU", { timeZone: "Asia/Yekaterinburg" })}`;

      // Telegram
      const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
      const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
      console.log(`[TG] send start | token=${TG_TOKEN ? "SET(len=" + TG_TOKEN.length + ")" : "MISSING"} | chatId=${TG_CHAT || "MISSING"}`);
      if (TG_TOKEN && TG_CHAT) {
        const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: TG_CHAT, text: tgMsg })
        });
        const d = await r.json();
        if (d.ok) console.log(`[TG] SUCCESS message_id=${d.result?.message_id}`);
        else console.error(`[TG] API ERROR:`, JSON.stringify(d));
      } else { console.log(`[TG] SKIPPED — not configured`); }

      // VK
      const VK_T = process.env.VK_TOKEN;
      const VK_U = process.env.VK_USER_ID;
      let vkUid = VK_U || "";
      const urlM = vkUid.match(/club(\d+)/);
      if (urlM) vkUid = "-" + urlM[1];
      else if (!/^-?\d+$/.test(vkUid)) vkUid = "";
      console.log(`[VK] send start | token=${VK_T ? "SET(len=" + VK_T.length + ")" : "MISSING"} | userId=${vkUid || "MISSING"}`);
      if (VK_T && vkUid) {
        const vkBody = new URLSearchParams({ access_token: VK_T, v: "5.199", user_id: vkUid, message: tgMsg, random_id: String(Date.now()) });
        const r = await fetch("https://api.vk.com/method/messages.send", {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: vkBody.toString()
        });
        const d = await r.json();
        if (d.response) console.log(`[VK] SUCCESS message_id=${d.response}`);
        else console.error(`[VK] API ERROR:`, JSON.stringify(d));
      } else { console.log(`[VK] SKIPPED — not configured`); }
    } catch (e) { console.error("[NOTIFY ERROR]", e); }

    // Respond AFTER notifications
    send(res, 200, { success: true, lead_id });

  }

  // =============================================
  // Test notifications endpoint (temporary)
  // =============================================
  if (routeKey(req.method, pathname) === "GET /api/test-notifications") {
    const results = { telegram: null, vk: null };
    const testMsg = `TEST NOTIFICATION\n\nThis is a test from ZAYA Backend.\nTime: ${new Date().toLocaleString("ru-RU", { timeZone: "Asia/Yekaterinburg" })}`;

    // Test Telegram
    const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
    console.log(`[TEST] Telegram: token=${TG_TOKEN ? "SET(len=" + TG_TOKEN.length + ")" : "MISSING"} chatId=${TG_CHAT || "MISSING"}`);
    if (TG_TOKEN && TG_CHAT) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: TG_CHAT, text: testMsg })
        });
        const d = await r.json();
        results.telegram = d.ok ? { success: true, message_id: d.result?.message_id } : { success: false, error: d };
        console.log(`[TEST] Telegram result:`, JSON.stringify(results.telegram));
      } catch (e) {
        results.telegram = { success: false, error: e.message, stack: e.stack };
        console.error(`[TEST] Telegram error:`, e);
      }
    } else {
      results.telegram = { success: false, reason: "not_configured", token: !!TG_TOKEN, chatId: !!TG_CHAT };
      console.log(`[TEST] Telegram: not configured`);
    }

    // Test VK
    const VK_T = process.env.VK_TOKEN;
    const VK_U = process.env.VK_USER_ID;
    let vkUid = VK_U || "";
    const vkUrlMatch = vkUid.match(/club(\d+)/);
    if (vkUrlMatch) vkUid = "-" + vkUrlMatch[1];
    else if (!/^-?\d+$/.test(vkUid)) vkUid = "";
    console.log(`[TEST] VK: token=${VK_T ? "SET(len=" + VK_T.length + ")" : "MISSING"} userId=${vkUid || "MISSING"} raw=${VK_U || "MISSING"}`);
    if (VK_T && vkUid) {
      const vkBody = new URLSearchParams({ access_token: VK_T, v: "5.199", user_id: vkUid, message: testMsg, random_id: String(Date.now()) });
      const r = await fetch("https://api.vk.com/method/messages.send", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: vkBody.toString()
      });
      const d = await r.json();
      results.vk = d.response ? { success: true, message_id: d.response } : { success: false, error: d };
      console.log(`[TEST] VK result:`, JSON.stringify(results.vk));
    } else {
      results.vk = { success: false, reason: "not_configured", token: !!VK_T, userId: !!VK_U };
      console.log(`[TEST] VK: not configured`);
    }

    return send(res, 200, results);
  }

  // =============================================
  // Telegram Webhook
  // =============================================
  if (routeKey(req.method, pathname) === "POST /api/telegram/webhook") {
    const body = await readJson(req);
    console.log("📨 Telegram webhook received:", JSON.stringify(body).slice(0, 200));
    return send(res, 200, { ok: true });
  }

  // =============================================
  // VK Callback
  // =============================================
  if (routeKey(req.method, pathname) === "POST /api/vk/callback") {
    const body = await readJson(req);
    if (body.type === "confirmation") return res.send("ok");
    console.log("📨 VK callback received:", JSON.stringify(body).slice(0, 200));
    return send(res, 200, { ok: true });
  }

  sendError(res, 404, "not_found");
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const normalized = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, normalized);
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(data);
  } catch {
    const data = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  }
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || "";
  const allowedOrigins = [
    "https://zayahome.onrender.com",
    "https://aztmn72.github.io",
    "https://zaya-gitverse.site",
    "http://localhost:8787",
    "http://localhost:3000"
  ];
  const allowed = allowedOrigins.some(o => origin.startsWith(o)) ? origin : allowedOrigins[0];
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-ZAYA-Device-Secret");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Max-Age", "86400");
}

createServer(async (req, res) => {
  try {
    setCorsHeaders(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await api(req, res, url.pathname);
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (error) {
    console.error(error);
    sendError(res, 500, "server_error");
  }
}).listen(port, () => {
  console.log(`ZAYA backend running at http://localhost:${port}`);
  console.log("First registered user becomes admin.");
});
