const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =============================================
// ENV
// =============================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const VK_TOKEN = process.env.VK_TOKEN;
const VK_GROUP_ID = process.env.VK_GROUP_ID;
const VK_USER_ID = process.env.VK_USER_ID;
const VK_CONFIRMATION = process.env.VK_CONFIRMATION || 'ok';

// =============================================
// SQLite Database
// =============================================
const DB_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, 'zaya.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id TEXT UNIQUE NOT NULL,
    name TEXT,
    phone TEXT,
    email TEXT,
    topic TEXT,
    message TEXT,
    source TEXT,
    ip TEXT,
    geo_json TEXT,
    device_json TEXT,
    marketing_json TEXT,
    behavior_json TEXT,
    purchase_score INTEGER DEFAULT 0,
    browser_tz TEXT,
    _tg_text TEXT,
    _vk_text TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS statuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id TEXT NOT NULL,
    status TEXT NOT NULL,
    manager TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(lead_id)
  );

  CREATE TABLE IF NOT EXISTS message_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id TEXT UNIQUE NOT NULL,
    telegram_chat_id TEXT,
    telegram_message_id INTEGER,
    vk_peer_id INTEGER,
    vk_message_id INTEGER,
    FOREIGN KEY (lead_id) REFERENCES leads(lead_id)
  );
`);

// Prepared statements
const stmts = {
  insertLead: db.prepare(`INSERT INTO leads (lead_id, name, phone, email, topic, message, source, ip, geo_json, device_json, marketing_json, behavior_json, purchase_score, browser_tz) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getLead: db.prepare(`SELECT * FROM leads WHERE lead_id = ?`),
  insertStatus: db.prepare(`INSERT INTO statuses (lead_id, status, manager) VALUES (?, ?, ?)`),
  getStatus: db.prepare(`SELECT * FROM statuses WHERE lead_id = ? ORDER BY id DESC LIMIT 1`),
  getAllStatuses: db.prepare(`SELECT * FROM statuses WHERE lead_id = ? ORDER BY id`),
  upsertMessageLink: db.prepare(`INSERT OR REPLACE INTO message_links (lead_id, telegram_chat_id, telegram_message_id, vk_peer_id, vk_message_id) VALUES (?, ?, ?, ?, ?)`),
  getMessageLink: db.prepare(`SELECT * FROM message_links WHERE lead_id = ?`),
  updateTGMsgId: db.prepare(`UPDATE message_links SET telegram_message_id = ? WHERE lead_id = ?`),
  updateVKMsgId: db.prepare(`UPDATE message_links SET vk_message_id = ? WHERE lead_id = ?`),
  getNextLeadNum: db.prepare(`SELECT MAX(id) as max_id FROM leads`),
};

// =============================================
// Migrate existing JSON data
// =============================================
function migrateJSONData() {
  try {
    const leadsFile = path.join(__dirname, 'logs', 'leads.json');
    if (!fs.existsSync(leadsFile)) return;

    const leads = JSON.parse(fs.readFileSync(leadsFile, 'utf-8'));
    const count = db.prepare('SELECT COUNT(*) as c FROM leads').get().c;
    if (count > 0) {
      console.log(`📦 SQLite already has ${count} leads, skipping migration`);
      return;
    }

    console.log(`📦 Migrating ${leads.length} leads from JSON to SQLite...`);
    const insertMany = db.transaction((items) => {
      for (const item of items) {
        try {
          stmts.insertLead.run(
            item.lead_id, item.name, item.phone, item.email, item.topic,
            item.message, item.source, item.ip,
            JSON.stringify(item.geo || {}), JSON.stringify(item.device || {}),
            JSON.stringify(item.marketing || {}), JSON.stringify(item.behavior || {}),
            (item.purchase_probability && item.purchase_probability.score) || 0,
            item.browser_tz || ''
          );
          stmts.insertStatus.run(item.lead_id, 'new', '—');
        } catch (e) {}
      }
    });
    insertMany(leads);
    console.log(`✅ Migrated ${leads.length} leads`);
  } catch (e) {
    console.error('Migration error:', e.message);
  }
}

// =============================================
// Sequential Lead Number
// =============================================
function getNextLeadNumber() {
  const row = stmts.getNextLeadNum.get();
  return (row.max_id || 0) + 1;
}

// =============================================
// Tyumen timezone
// =============================================
const TYUMEN_TZ = 'Asia/Yekaterinburg';
const TYUMEN_OFFSET = 5;

function getTyumenDate() {
  return new Date().toLocaleString('ru-RU', {
    timeZone: TYUMEN_TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function getTyumenDateShort() {
  return new Date().toLocaleDateString('ru-RU', { timeZone: TYUMEN_TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
}

// =============================================
// Anti-spam
// =============================================
const rateLimitMap = new Map();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.connection.remoteAddress || req.ip || '127.0.0.1';
}

function checkRateLimit(ip) {
  const now = Date.now();
  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
  const timestamps = rateLimitMap.get(ip).filter(t => now - t < RATE_WINDOW_MS);
  rateLimitMap.set(ip, timestamps);
  if (timestamps.length >= RATE_MAX) return false;
  timestamps.push(now);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateLimitMap) {
    const valid = timestamps.filter(t => now - t < RATE_WINDOW_MS);
    if (valid.length === 0) rateLimitMap.delete(ip);
    else rateLimitMap.set(ip, valid);
  }
}, 60000);

// =============================================
// Phone
// =============================================
function normalizePhone(phone) {
  if (!phone) return '';
  let d = phone.replace(/\D/g, '');
  if (d.startsWith('8') && d.length === 11) d = '7' + d.slice(1);
  if (d.length === 10 && d[0] !== '7') d = '7' + d;
  if (d.length === 11 && d[0] === '7') return `+7 ${d.slice(1,4)} ${d.slice(4,7)}-${d.slice(7,9)}-${d.slice(9,11)}`;
  return phone;
}

function getPhoneDigits(phone) {
  if (!phone) return '';
  let d = phone.replace(/\D/g, '');
  if (d.startsWith('8') && d.length === 11) d = '7' + d.slice(1);
  if (d.length === 10 && d[0] !== '7') d = '7' + d;
  return d;
}

function formatPhoneTg(phone) {
  if (!phone) return '—';
  let d = phone.replace(/\D/g, '');
  if (d.startsWith('8') && d.length === 11) d = '7' + d.slice(1);
  if (d.length === 10 && d[0] !== '7') d = '7' + d;
  if (d.length === 11 && d[0] === '7') return `+7 ${d.slice(1,4)} ${d.slice(4,7)}-${d.slice(7,9)}-${d.slice(9,11)}`;
  return phone;
}

// =============================================
// Geolocation
// =============================================
const COUNTRY_RU = { 'Russia': 'Россия', 'Ukraine': 'Украина', 'Belarus': 'Беларусь', 'Kazakhstan': 'Казахстан', 'Germany': 'Германия', 'France': 'Франция', 'United Kingdom': 'Великобритания', 'USA': 'США', 'China': 'Китай', 'Japan': 'Япония' };
const REGION_RU = { 'Moscow Oblast': 'Московская область', 'Sverdlovsk Oblast': 'Свердловская область', 'Tyumen Oblast': 'Тюменская область', 'Tumen Oblast': 'Тюменская область', 'Omsk Oblast': 'Омская область', 'Chelyabinsk Oblast': 'Челябинская область' };
const CITY_RU = { 'Moscow': 'Москва', 'Saint Petersburg': 'Санкт-Петербург', 'Novosibirsk': 'Новосибирск', 'Yekaterinburg': 'Екатеринбург', 'Tyumen': 'Тюмень', 'Omsk': 'Омск', 'Chelyabinsk': 'Челябинск', 'Kazan': 'Казань', 'Ufa': 'Уфа', 'Samara': 'Самара' };

function translateCountry(en) { return COUNTRY_RU[en] || en; }
function translateRegion(en) { return REGION_RU[en] || en; }
function translateCity(en) { return CITY_RU[en] || en; }

async function getGeoData(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return { country: '', regionName: '', city: '', timezone: '', proxy: false };
  }
  try {
    const r = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city,timezone,proxy`, { timeout: 5000 });
    const d = await r.json();
    if (d.status === 'success') return { country: translateCountry(d.country||''), regionName: translateRegion(d.regionName||''), city: translateCity(d.city||''), timezone: d.timezone||'', proxy: d.proxy||false };
    return null;
  } catch (e) { return null; }
}

// =============================================
// Timezone
// =============================================
function getTimezoneOffset(tz) {
  if (!tz) return null;
  const tzMap = { 'Asia/Yekaterinburg':5,'Asia/Omsk':6,'Asia/Novosibirsk':7,'Asia/Krasnoyarsk':7,'Asia/Irkutsk':8,'Europe/Moscow':3,'Europe/Samara':4,'Asia/Tomsk':7,'Asia/Kemerovo':7,'Asia/Barnaul':7,'Asia/Tashkent':5,'Asia/Bishkek':6,'Asia/Almaty':6,'Europe/Minsk':3,'Europe/Kiev':2,'Europe/Kyiv':2,'Asia/Tbilisi':4,'Asia/Baku':4,'Asia/Yerevan':4,'Europe/Istanbul':3,'Asia/Jerusalem':2,'Asia/Dubai':4,'Asia/Bangkok':7,'Asia/Shanghai':8,'Asia/Seoul':9,'Asia/Tokyo':9,'Europe/London':1,'Europe/Paris':2,'Europe/Berlin':2,'America/New_York':-4,'America/Los_Angeles':-7 };
  let offset = tzMap[tz];
  if (offset === undefined) { const m = tz.match(/UTC([+-])(\d{1,2}):?(\d{2})?/); if (m) { const s = m[1]==='+'?1:-1; offset = s*(parseInt(m[2])+(m[3]?parseInt(m[3])/60:0)); } }
  if (offset === undefined) return null;
  const diff = offset - TYUMEN_OFFSET;
  if (diff === 0) return 'Совпадает с Тюменью';
  const abs = Math.abs(diff);
  return `${diff>0?'+':''}${diff} ${abs===1?'час':(abs<5?'часа':'часов')} от Тюмени`;
}

// =============================================
// Purchase Probability
// =============================================
function calculatePurchaseProbability(data) {
  let score = 0; const reasons = [];
  if (data.visit_count > 1) { score += 20; reasons.push('✅ Повторный визит'); }
  if (data.time_on_page > 300) { score += 20; reasons.push('✅ Долго на сайте'); }
  if (data.viewed_controller4) { score += 10; reasons.push('✅ Просмотрел Controller 4'); }
  if (data.email && data.email.trim()) { score += 10; reasons.push('✅ Указан Email'); }
  if (data.message && data.message.trim()) { score += 10; reasons.push('✅ Есть сообщение'); }
  if (data.phone) { let d = data.phone.replace(/\D/g,''); if (d.startsWith('8')&&d.length===11) d='7'+d.slice(1); if (d.length===11&&d.startsWith('7')) { score+=10; reasons.push('✅ Российский номер'); } }
  if (data.utm_source && data.utm_source.trim()) { score += 10; reasons.push('✅ Пришёл по рекламе'); }
  return { score: Math.min(score, 100), reasons };
}

// =============================================
// Telegram helpers
// =============================================
function escapeMarkdown(t) { return String(t).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&'); }
function formatTime(s) { if (!s||s<60) return `${s||0} сек`; return `${Math.floor(s/60)} мин ${s%60} сек`; }
const SEP = '────────────────';

const STATUS_LABELS = { 'new':'🆕 Новая заявка','in_work':'✅ Взял в работу','contacted':'☎️ Связался','cp_sent':'📄 КП отправлено','contract_sent':'🤝 Договор отправлен','sold':'💰 Продано','lost':'💀 Потеряна','spam':'🚫 Спам' };

function formatMessage(data, geo, purchaseProb, behavior) {
  const date = getTyumenDate();
  let m = `🔥 НОВАЯ ЗАЯВКА\n\n№ ${data.lead_id}\n\n👤 ${escapeMarkdown(data.name||'Не указано')}\n📱 ${formatPhoneTg(data.phone)}\n📧 ${data.email||'Не указан'}\n\n📋 Интерес:\n${escapeMarkdown(data.topic||'Не указана')}\n\n💬 Сообщение:\n${escapeMarkdown(data.message||'Без сообщения')}`;
  m += `\n\n${SEP}\n\n🔥 Вероятность покупки: ${purchaseProb.score}%\n`;
  for (const r of purchaseProb.reasons) m += `${r}\n`;
  if (geo && geo.country) {
    m += `\n${SEP}\n\n🌍 ${geo.country}\n`;
    const rc = [geo.regionName, geo.city].filter(Boolean).join(', ');
    if (rc) m += `📍 ${rc}\n`;
    const tz = getTimezoneOffset(data.browser_tz || geo.timezone);
    m += `🕐 Часовой пояс: ${tz||'Неизвестно'}\n`;
  }
  m += `\n${SEP}\n\n📱 ${escapeMarkdown(data.device_type||'—')}\n💻 ${escapeMarkdown(data.os||'—')}\n🌐 ${escapeMarkdown(data.browser||'—')}`;
  const tv = behavior ? behavior.visit_count : (data.visit_count||1);
  m += `\n\n${SEP}\n\n⏱ На сайте: ${formatTime(data.time_on_page||0)}\n🔄 Визитов за 30 дней: ${tv}`;
  if (behavior) { m += `\n\n📅 Первый визит: ${behavior.first_visit}\n📅 Последний визит: ${behavior.last_visit}`; }
  m += `\n\n${SEP}\n\n🔐 VPN: ${(geo&&geo.proxy)?'Да':'Нет'}`;
  if (data.referer||data.current_url) { m += `\n\n${SEP}\n`; if (data.referer) m += `\n🔗 Источник:\n${data.referer}\n`; if (data.current_url) m += `\n📍 ${data.current_url}\n`; }
  const hasUtm = data.utm_source||data.utm_medium||data.utm_campaign||data.utm_content||data.utm_term;
  if (hasUtm) { m += `\n${SEP}\n`; if(data.utm_source) m+=`\n📢 UTM Source: ${escapeMarkdown(data.utm_source)}\n`; if(data.utm_medium) m+=`📢 UTM Medium: ${escapeMarkdown(data.utm_medium)}\n`; if(data.utm_campaign) m+=`📢 UTM Campaign: ${escapeMarkdown(data.utm_campaign)}\n`; if(data.utm_content) m+=`📢 UTM Content: ${escapeMarkdown(data.utm_content)}\n`; if(data.utm_term) m+=`📢 UTM Term: ${escapeMarkdown(data.utm_term)}\n`; }
  m += `\n${SEP}\n\n📅 ${date}`;
  return m;
}

function formatStatusBlock(status, manager, date) {
  return `\n${SEP}\n\n📌 Статус:\n${STATUS_LABELS[status]||status}\n\n👤 Ответственный:\n${manager||'—'}\n\n🕒 Время:\n${date||getTyumenDate()}\n\n${SEP}`;
}

// =============================================
// Telegram API
// =============================================
async function tgApi(method, body) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const resp = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  const result = await resp.json();
  if (!result.ok && result.description && result.description.includes('migrate_to_chat_id')) {
    const newId = result.parameters && result.parameters.migrate_to_chat_id;
    if (newId) { body.chat_id = newId; const r2 = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); return await r2.json(); }
  }
  return result;
}

const TG_CHAT_ID_FILE = path.join(__dirname, 'logs', 'chat_id.txt');
function getEffectiveChatId() {
  try { if (fs.existsSync(TG_CHAT_ID_FILE)) { const s = fs.readFileSync(TG_CHAT_ID_FILE,'utf-8').trim(); if (s) return s; } } catch(e) {}
  return TELEGRAM_CHAT_ID;
}
function saveChatId(id) {
  try { const d = path.join(__dirname,'logs'); if (!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); fs.writeFileSync(TG_CHAT_ID_FILE, String(id)); } catch(e) {}
}

async function sendToTelegram(message, leadId) {
  if (!TELEGRAM_BOT_TOKEN) return { success:false, reason:'not_configured' };
  const chatId = getEffectiveChatId();
  if (!chatId) return { success:false, reason:'no_chat_id' };
  try {
    const result = await tgApi('sendMessage', { chat_id:chatId, text:message });
    if (result.ok) { console.log('✅ Telegram sent'); return { success:true, message_id:result.result.message_id, chat_id:result.result.chat.id }; }
    else { console.error('❌ Telegram:', result.description); return { success:false, reason:result.description }; }
  } catch(e) { console.error('❌ Telegram:', e.message); return { success:false, reason:e.message }; }
}

async function editTelegramMessage(chatId, messageId, newText) {
  try {
    const r = await tgApi('editMessageText', { chat_id:chatId, message_id:messageId, text:newText });
    if (r.ok) { console.log('✅ Telegram edited'); return true; }
    else { console.error('❌ TG edit:', r.description); return false; }
  } catch(e) { console.error('❌ TG edit:', e.message); return false; }
}

// =============================================
// VK API
// =============================================
async function vkApi(method, params) {
  const url = `https://api.vk.com/method/${method}`;
  const body = new URLSearchParams({ access_token:VK_TOKEN, v:'5.199', ...params });
  const resp = await fetch(url, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:body.toString() });
  return await resp.json();
}

function getVKKeyboard(leadId) {
  return JSON.stringify({
    one_time: false,
    inline: true,
    buttons: [
      [{ action:{type:'text',label:'✅ Взял в работу',payload:JSON.stringify({command:'status_in_work',lead_id:leadId})},color:'positive'},{ action:{type:'text',label:'☎️ Связался',payload:JSON.stringify({command:'status_contacted',lead_id:leadId})},color:'primary' }],
      [{ action:{type:'text',label:'📄 КП отправлено',payload:JSON.stringify({command:'status_cp_sent',lead_id:leadId})},color:'primary'},{ action:{type:'text',label:'🤝 Договор',payload:JSON.stringify({command:'status_contract_sent',lead_id:leadId})},color:'primary' }],
      [{ action:{type:'text',label:'💰 Продано',payload:JSON.stringify({command:'status_sold',lead_id:leadId})},color:'positive'},{ action:{type:'text',label:'💀 Потеряна',payload:JSON.stringify({command:'status_lost',lead_id:leadId})},color:'negative' },{ action:{type:'text',label:'🚫 Спам',payload:JSON.stringify({command:'status_spam',lead_id:leadId})},color:'secondary' }]
    ]
  });
}

async function sendToVK(message, leadId) {
  if (!VK_TOKEN || !VK_USER_ID) return { success:false, reason:'not_configured' };
  try {
    const keyboard = getVKKeyboard(leadId);
    const result = await vkApi('messages.send', { user_id:VK_USER_ID, message, random_id:String(Date.now()), keyboard });
    if (result.response) { console.log('✅ VK sent'); return { success:true, message_id:result.response }; }
    else { console.error('❌ VK:', result.error?.error_msg); return { success:false, reason:result.error?.error_msg }; }
  } catch(e) { console.error('❌ VK:', e.message); return { success:false, reason:e.message }; }
}

async function editVKMessage(peerId, messageId, newText, leadId) {
  try {
    const keyboard = getVKKeyboard(leadId);
    const result = await vkApi('messages.edit', { peer_id:peerId, message_id:messageId, message:newText, keyboard });
    if (result.response === 1) { console.log('✅ VK edited'); return true; }
    else { console.error('❌ VK edit:', result.error?.error_msg); return false; }
  } catch(e) { console.error('❌ VK edit:', e.message); return false; }
}

// =============================================
// Status update (single source of truth)
// =============================================
async function updateStatus(leadId, newStatus, manager, source) {
  // 1. Save to SQLite
  stmts.insertStatus.run(leadId, newStatus, manager);
  console.log(`💾 Status saved: ${leadId} → ${newStatus} by ${manager} (from ${source})`);

  // 2. Update Telegram
  const link = stmts.getMessageLink.get(leadId);
  if (link && link.telegram_message_id && link.telegram_chat_id) {
    const lead = stmts.getLead.get(leadId);
    const statusBlock = formatStatusBlock(newStatus, manager);
    const cleanText = (lead._tg_text || '').replace(/\n\n📌 Статус:[\s\S]*?\n\n────────────────\s*$/, '');
    const newText = (cleanText || `Заявка ${leadId}`) + statusBlock;
    await editTelegramMessage(link.telegram_chat_id, link.telegram_message_id, newText);
  }

  // 3. Update VK
  if (link && link.vk_message_id && link.vk_peer_id) {
    const lead = stmts.getLead.get(leadId);
    const statusBlock = formatStatusBlock(newStatus, manager);
    const cleanText = (lead._vk_text || '').replace(/\n\n📌 Статус:[\s\S]*?\n\n────────────────\s*$/, '');
    const newText = (cleanText || `Заявка ${leadId}`) + statusBlock;
    await editVKMessage(link.vk_peer_id, link.vk_message_id, newText, leadId);
  }
}

// =============================================
// API: POST /api/lead
// =============================================
app.post('/api/lead', async (req, res) => {
  try {
    const clientIp = getClientIp(req);

    if (req.body.website && req.body.website.trim() !== '') return res.json({ success:true });
    if (!checkRateLimit(clientIp)) return res.status(429).json({ success:false, error:'Слишком много заявок' });
    if (req.body.form_ts) { const ts = parseInt(req.body.form_ts); if (!isNaN(ts)&&(Date.now()-ts)<3000) return res.json({ success:true }); }

    const { name, phone, email, topic, message, source, device_type, os, browser, user_agent, utm_source, utm_medium, utm_campaign, utm_content, utm_term, referer, current_url, time_on_page, viewed_controller4, browser_tz, visit_count, pages_viewed } = req.body;

    if (!name || !phone) return res.status(400).json({ success:false, error:'Имя и телефон обязательны' });

    const normalizedPhone = normalizePhone(phone);
    const phoneDigits = getPhoneDigits(phone);
    const leadNumber = getNextLeadNumber();
    const lead_id = `ZAYA-${String(leadNumber).padStart(6,'0')}`;

    console.log(`📥 New lead: #${leadNumber} ${name} (${normalizedPhone})`);

    // Visitor history (simple in-memory for now, could move to SQLite later)
    const today = getTyumenDateShort();
    const behavior = { visit_count: visit_count||1, first_visit: today, last_visit: today };

    const geoData = await getGeoData(clientIp);
    const purchaseProb = calculatePurchaseProbability({ email, message, phone, utm_source, visit_count: behavior.visit_count, time_on_page, viewed_controller4 });

    // Save to SQLite
    stmts.insertLead.run(
      lead_id, name, normalizedPhone, email, topic, message, source, clientIp,
      JSON.stringify(geoData||{}), JSON.stringify({type:device_type,os,browser,user_agent}),
      JSON.stringify({utm_source,utm_medium,utm_campaign,utm_content,utm_term,referer,current_url}),
      JSON.stringify(behavior), purchaseProb.score, browser_tz||''
    );
    stmts.insertStatus.run(lead_id, 'new', '—');

    // Build message
    const msgData = { lead_id, name, phone:normalizedPhone, email, topic, message, source, device_type, os, browser, utm_source, utm_medium, utm_campaign, utm_content, utm_term, referer, current_url, time_on_page, viewed_controller4, browser_tz, visit_count:behavior.visit_count };
    const tgMessage = formatMessage(msgData, geoData, purchaseProb, behavior);

    // Send to Telegram
    let tgResult = { success:false };
    try { tgResult = await sendToTelegram(tgMessage, lead_id); } catch(e) { console.error('⚠️ TG failed:', e.message); }

    // Send to VK
    let vkResult = { success:false };
    try { vkResult = await sendToVK(tgMessage, lead_id); } catch(e) { console.error('⚠️ VK failed:', e.message); }

    // Save message links
    stmts.upsertMessageLink.run(
      lead_id,
      tgResult.chat_id ? String(tgResult.chat_id) : null,
      tgResult.message_id || null,
      VK_USER_ID ? parseInt(VK_USER_ID) : null,
      vkResult.message_id || null
    );

    // Store text for future edits
    db.prepare('UPDATE leads SET _tg_text = ?, _vk_text = ? WHERE lead_id = ?').run(tgMessage, tgMessage, lead_id);

    res.json({
      success: true, lead_id,
      purchase_probability: purchaseProb.score,
      telegram: tgResult.success ? 'sent' : 'skipped',
      vk: vkResult.success ? 'sent' : 'skipped'
    });
  } catch(e) {
    console.error('❌ Lead error:', e);
    res.status(500).json({ success:false, error:'Ошибка сервера' });
  }
});

// =============================================
// Telegram Webhook
// =============================================
app.post('/api/telegram/webhook', async (req, res) => {
  res.json({ ok: true });
  try {
    const update = req.body;

    // Chat discovery
    if (update.message) {
      const chat = update.message.chat;
      const from = update.message.from;
      console.log(`\n🟢 NEW CHAT DETECTED\n   chat.id: ${chat.id}\n   chat.title: ${chat.title||chat.first_name||'—'}\n   chat.type: ${chat.type}\n   message.text: "${update.message.text||''}"\n   from.username: @${from?.username||from?.first_name||'—'}\n`);
    }

    if (!update.callback_query) return;
    const cb = update.callback_query;
    const data = cb.data;
    const messageId = cb.message?.message_id;
    const chatId = cb.message?.chat?.id;
    const username = cb.from ? (cb.from.username ? `@${cb.from.username}` : cb.from.first_name||'—') : '—';

    console.log(`🔘 TG callback: ${data} from ${username}`);
    if (!data || !messageId || !chatId) return;

    const parts = data.split(':');
    const statusKey = parts[0];
    const leadId = parts[1];

    const validStatuses = ['in_work','contacted','cp_sent','contract_sent','sold','lost','spam'];
    if (!validStatuses.includes(statusKey)) return;

    const current = stmts.getStatus.get(leadId);
    if (current && current.status === statusKey) {
      await tgApi('answerCallbackQuery', { callback_query_id:cb.id, text:'Статус уже установлен' });
      return;
    }

    await tgApi('answerCallbackQuery', { callback_query_id:cb.id, text:STATUS_LABELS[statusKey]||'OK' });
    await updateStatus(leadId, statusKey, username, 'telegram');

  } catch(e) { console.error('❌ TG webhook error:', e); }
});

// =============================================
// VK Callback API
// =============================================
app.post('/api/vk/callback', async (req, res) => {
  const body = req.body;

  // Confirmation
  if (body.type === 'confirmation') {
    return res.send(VK_CONFIRMATION);
  }

  // Message event (inline button press)
  if (body.type === 'message_event') {
    const event = body.object;
    const payload = JSON.parse(event.payload || '{}');
    const command = payload.command;
    const leadId = payload.lead_id;
    const userId = event.user_id;
    const peerId = event.peer_id;
    const cmId = event.conversation_message_id;

    console.log(`🔘 VK callback: ${command} lead=${leadId} from user=${userId}`);

    const validStatuses = ['in_work','contacted','cp_sent','contract_sent','sold','lost','spam'];
    if (validStatuses.includes(command) && leadId) {
      const current = stmts.getStatus.get(leadId);
      if (current && current.status === command) {
        await vkApi('messages.sendMessageEventAnswer', { event_id:event.event_id, user_id:userId, peer_id:peerId, event_data:JSON.stringify({type:'show_snackbar',text:'Статус уже установлен'}) });
        return res.send('ok');
      }

      await vkApi('messages.sendMessageEventAnswer', { event_id:event.event_id, user_id:userId, peer_id:peerId, event_data:JSON.stringify({type:'show_snackbar',text:STATUS_LABELS[command]||command}) });
      await updateStatus(leadId, command, `user_${userId}`, 'vk');
    }

    return res.send('ok');
  }

  // New message — also log as discovered chat
  if (body.type === 'message_new') {
    const msg = body.object?.message;
    if (msg && msg.from_id && msg.peer_id) {
      console.log(`\n🟢 VK MESSAGE\n   peer_id: ${msg.peer_id}\n   from_id: ${msg.from_id}\n   text: "${msg.text||''}"\n`);
    }
  }

  res.send('ok');
});

// =============================================
// Health + Debug endpoints
// =============================================
app.get('/api/health', (req, res) => {
  const leadCount = db.prepare('SELECT COUNT(*) as c FROM leads').get().c;
  res.json({ status:'ok', telegram:!!(TELEGRAM_BOT_TOKEN&&getEffectiveChatId()), vk:!!(VK_TOKEN&&VK_USER_ID), chat_id:getEffectiveChatId(), leads:leadCount, timestamp:new Date().toISOString() });
});

app.get('/api/telegram/debug', async (req, res) => {
  const debug = { env_chat_id:TELEGRAM_CHAT_ID, effective_chat_id:getEffectiveChatId() };
  if (!TELEGRAM_BOT_TOKEN) { debug.error = 'no token'; return res.json(debug); }
  try { debug.getMe = await tgApi('getMe',{}); } catch(e) { debug.getMe = {error:e.message}; }
  try { debug.getWebhookInfo = await tgApi('getWebhookInfo',{}); } catch(e) { debug.getWebhookInfo = {error:e.message}; }
  const chatId = getEffectiveChatId();
  if (chatId) { try { debug.getChat = await tgApi('getChat',{chat_id:chatId}); } catch(e) { debug.getChat = {error:e.message}; } }
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.send(JSON.stringify(debug,null,2));
});

app.get('/api/telegram/chat-info', async (req, res) => {
  if (!TELEGRAM_BOT_TOKEN) return res.json({error:'no token'});
  const chatId = getEffectiveChatId();
  const result = { chat_id:chatId };
  try { result.getMe = await tgApi('getMe',{}); } catch(e) { result.getMe={error:e.message}; }
  try { result.getChat = await tgApi('getChat',{chat_id:chatId}); } catch(e) { result.getChat={error:e.message}; }
  if (result.getMe?.ok) { try { result.getChatMember = await tgApi('getChatMember',{chat_id:chatId,user_id:result.getMe.result.id}); } catch(e) { result.getChatMember={error:e.message}; } }
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.send(JSON.stringify(result,null,2));
});

app.get('/api/telegram/test-send', async (req, res) => {
  if (!TELEGRAM_BOT_TOKEN) return res.json({status:'error',error:'no token'});
  const chatId = getEffectiveChatId();
  if (!chatId) return res.json({status:'error',error:'no chat_id'});
  const r = await tgApi('sendMessage',{chat_id:chatId,text:`🧪 ТЕСТ ZAYA\n📅 ${getTyumenDate()}\n✅ Telegram работает`});
  res.json({status:r.ok?'ok':'error',chat_id:chatId,result:r});
});

app.get('/api/vk/test', async (req, res) => {
  const r = await sendToVK(`🧪 ТЕСТ ZAYA\n📅 ${getTyumenDate()}\n✅ VK работает`, 'test');
  res.json({status:r.success?'ok':'error',vk:r.success});
});

// =============================================
// Leads list (for future CRM)
// =============================================
app.get('/api/leads', (req, res) => {
  const leads = db.prepare('SELECT l.*, s.status, s.manager, s.updated_at as status_updated FROM leads l LEFT JOIN statuses s ON l.lead_id = s.lead_id AND s.id = (SELECT MAX(id) FROM statuses WHERE lead_id = l.lead_id) ORDER BY l.id DESC LIMIT 50').all();
  res.json({ leads, count: leads.length });
});

app.get('/api/leads/:id', (req, res) => {
  const lead = stmts.getLead.get(req.params.id);
  if (!lead) return res.status(404).json({error:'not found'});
  const statuses = stmts.getAllStatuses.all(req.params.id);
  const link = stmts.getMessageLink.get(req.params.id);
  res.json({ lead, statuses, message_links: link });
});

// =============================================
// Serve static + startup
// =============================================
app.use(express.static('..'));

app.listen(PORT, async () => {
  console.log(`\n🚀 ZAYA API v2.0 running on port ${PORT}`);
  console.log(`📡 Health: http://localhost:${PORT}/api/health`);
  console.log(`📝 Leads: POST http://localhost:${PORT}/api/lead`);
  console.log(`📋 List: GET http://localhost:${PORT}/api/leads`);
  console.log(`🔗 TG Webhook: POST http://localhost:${PORT}/api/telegram/webhook`);
  console.log(`🔗 VK Callback: POST http://localhost:${PORT}/api/vk/callback`);
  console.log(`🔍 Debug: GET http://localhost:${PORT}/api/telegram/debug`);
  console.log(`💬 Chat Info: GET http://localhost:${PORT}/api/telegram/chat-info\n`);

  migrateJSONData();
});
