/* 問道長生 · ORPG 伺服器（零依賴，只需 Node 16+）
 * 啟動：node server.js   → 開啟 http://localhost:3000
 * 資料存於 Supabase 雲端資料庫（使用內建 https 模組）。
 * 遊戲規則與資料在 shared/game-rules.js（前端與伺服器共用）。伺服器是唯一計算與保存數值的地方。
 */
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), crypto = require('crypto')
const PORT = process.env.PORT || 3000
// 【第二、三階段】遊戲規則與資料全部來自共用檔 shared/game-rules.js（前端載入同一份）。
// 伺服器是唯一計算與保存數值的地方：前端只送出「我要做什麼」，結果由這裡算好、存檔，再傳回前端顯示。
const R = require('./shared/game-rules.js')
const ITEM_DEFS = R.ITEMS

// ===== GM 帳號 =====
// GM 道號（小寫比對）與密碼。強烈建議在部署環境用環境變數 GM_PASSWORD 設定密碼，不要把真密碼寫進程式碼。
// 一般玩家無法註冊或登入 GM 道號；只有密碼正確才會被視為 GM。
const GM_NAMES = ['gm']
const GM_PASSWORD = process.env.GM_PASSWORD || ''
const isGMKey = (k) => GM_NAMES.includes(k)

// ===== Supabase 雲端資料庫設定 =====
// 【第一階段】金鑰不再寫死在程式碼，一律從環境變數讀（Render → Environment）：
//   SUPABASE_HOST  例：xxxx.supabase.co（或改填 SUPABASE_URL：https://xxxx.supabase.co，兩者擇一）
//   SUPABASE_KEY   請用「secret key」（sb_secret_...），它只放在伺服器，不會給玩家看到
// 缺少任一個就拒絕啟動，避免伺服器在「連不上資料庫」的狀態下運作。
const SUPABASE_HOST = String(process.env.SUPABASE_HOST || process.env.SUPABASE_URL || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
const SUPABASE_KEY = String(process.env.SUPABASE_KEY || '').trim()
if (!SUPABASE_HOST || !SUPABASE_KEY) {
  console.error('【啟動失敗】缺少環境變數 SUPABASE_HOST（或 SUPABASE_URL）與 SUPABASE_KEY，請到 Render 的 Environment 設定。')
  process.exit(1)
}
if (SUPABASE_KEY.startsWith('sb_publishable_')) console.warn('【警告】SUPABASE_KEY 目前是 publishable key，建議改用 secret key（sb_secret_...），並開啟資料表的 RLS。')

let db = { players: {}, nextId: 1, auctions: [] }

// 封裝一個用來跟 Supabase 溝通的標準 HTTPS 請求函式
function supabaseRequest(method, endpoint, data = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = data ? JSON.stringify(data) : ''
    const options = {
      hostname: SUPABASE_HOST,
      path: endpoint,
      method: method,
      headers: {
        'apikey': SUPABASE_KEY,
        // 新版金鑰（sb_publishable_ / sb_secret_）不是 JWT，只能放在 apikey；舊版 JWT 金鑰（eyJ 開頭）才另外放 Authorization
        ...(SUPABASE_KEY.startsWith('eyJ') ? { 'Authorization': `Bearer ${SUPABASE_KEY}` } : {}),
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        'Prefer': 'return=minimal'
      }
    }

    const req = https.request(options, (res) => {
      let rawData = ''
      res.on('data', (chunk) => { rawData += chunk })
      res.on('end', () => {
        try {
          const json = rawData ? JSON.parse(rawData) : null
          resolve({ status: res.statusCode, data: json })
        } catch (e) {
          resolve({ status: res.statusCode, data: rawData })
        }
      })
    })

    req.on('error', (e) => { reject(e) })
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

// 從 Supabase 雲端載入資料
// 【第一階段】回傳是否「確實讀到雲端」。讀不到（網路錯誤、金鑰錯誤、權限不足）時回傳 false，
// 伺服器就不會啟動，也絕不會把空白資料寫回雲端（舊版在這種情況會把全部玩家資料洗掉）。
let cloudReady = false
async function loadFromCloud() {
  try {
    const result = await supabaseRequest('GET', '/rest/v1/game_store?id=eq.main_db&select=data')
    if (result.status >= 200 && result.status < 300 && Array.isArray(result.data)) {
      const rows = result.data
      if (!rows.length) console.warn('【警告】資料表 game_store 找不到 id = main_db 的資料列，存檔會寫不進去，請先在 Supabase 建立這一列。')
      if (rows.length > 0 && rows[0].data && Object.keys(rows[0].data).length > 0) {
        db = Object.assign(db, rows[0].data)
        console.log('成功從雲端載入遊戲資料！')
      } else {
        console.log('雲端目前資料為空，使用初始空資料')
      }
      cloudReady = true
      return true
    }
    console.error('從雲端載入失敗，HTTP 狀態碼：', result.status, result.data)
  } catch (e) {
    console.error('從雲端載入發生例外錯誤：', e.message)
  }
  return false
}

// 寫入資料到 Supabase 雲端
let dirty = false
const persist = () => { dirty = true }
async function persistToCloud() {
  if (!cloudReady) return   // 還沒成功讀過雲端，就不准寫，避免空資料覆蓋
  if (!dirty) return
  dirty = false
  try {
    const result = await supabaseRequest('PATCH', '/rest/v1/game_store?id=eq.main_db', { data: db })
    if (result.status < 200 || result.status >= 300) {
      console.error('雲端存檔失敗，HTTP 狀態碼：', result.status, result.data)
      dirty = true // 失敗時保留變更，下次重試
    }
  } catch (e) {
    console.error('雲端存檔發生例外錯誤：', e.message)
    dirty = true
  }
}
setInterval(persistToCloud, 5000)
// 【第一階段】Render 重新部署／重啟時送的是 SIGTERM（本機按 Ctrl+C 是 SIGINT），兩種都要先存檔再關
let shuttingDown = false
async function shutdown(sig) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`收到 ${sig}，存檔後關閉…`)
  if (cloudReady) { dirty = true; await persistToCloud() }
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

const sessions = new Map()   // token -> name key
const clients = new Map()    // token -> { res, key }
const chatHistory = []
const lastAct = {}           // rate limit: key+action -> ts
const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a
const now = () => Date.now()
const limited = (key, act, ms) => { const k = key + act, t = now(); if (lastAct[k] && t - lastAct[k] < ms) return true; lastAct[k] = t; return false }
// 【第一階段】限流紀錄每 10 分鐘清掉舊的，避免記憶體越長越大
setInterval(() => { const t = now(); for (const k of Object.keys(lastAct)) if (t - lastAct[k] > 600000) delete lastAct[k] }, 600000)

// 【第一階段】取得玩家真實 IP：Render 前面有代理，req.socket.remoteAddress 只會拿到代理的 IP（全服共用同一個）
function clientIp(req) {
  const h = req.headers
  const xff = String(h['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean)
  return String(h['cf-connecting-ip'] || h['true-client-ip'] || xff[xff.length - 1] || req.socket.remoteAddress || '')
}
// 【第一階段】同一個道號連續輸錯密碼 5 次 → 鎖 5 分鐘（防止別人一直猜密碼）
const LOGIN_MAX_FAIL = 5, LOGIN_LOCK_MS = 5 * 60000
const loginFails = new Map()   // 道號小寫 -> { n, until }

/* ---------- 聊天管理 ----------
 * 所有玩家聊天（含密語）都記錄在 db.chatLog（保留最近 CHAT_LOG_MAX 則，隨資料庫一起存雲端），GM 分頁可查詢。
 * 禁言：db.mutes = { 道號小寫: 解除時間(毫秒) }；被禁言的玩家無法發言（世界頻道與密語都不行）。
 * 關鍵字過濾：命中 BAD_WORDS 的字會被換成 ***；GM 紀錄裡仍保留原文（raw），方便舉證。清單請自行增減。 */
const CHAT_LOG_MAX = 500
const BAD_WORDS = ['幹你娘', '操你媽', '操你妈', '去死', '幹你', '三字經', 'fuck', 'bitch', 'shit']
const filterText = (t) => BAD_WORDS.reduce((s, w) => s.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => '*'.repeat(m.length)), t)
const muteLeft = (key) => { const u = (db.mutes || {})[key]; if (!u) return 0; if (u <= Date.now()) { delete db.mutes[key]; dirty = true; return 0 } return u - Date.now() }
const muteList = () => Object.keys(db.mutes || {}).map((k) => ({ name: nameOf(k), left: Math.ceil(muteLeft(k) / 60000) })).filter((m) => m.left > 0)

/* ---------- 工具 ---------- */
function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString('hex') }
function onlineKeys() { return [...new Set([...clients.values()].map((c) => c.key))] }
function presence() {
  return onlineKeys().map((k) => { const p = db.players[k], s = (p && p.save) || {}; return { name: p.name, realm: s.realm || 0, layer: s.layer || 1, sect: s.sect || '' } })
}
function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
function broadcast(event, data) { for (const c of clients.values()) send(c.res, event, data) }
function sendTo(key, event, data) { for (const c of clients.values()) if (c.key === key) send(c.res, event, data) }
function chat(msg) {
  msg.t = now(); chatHistory.push(msg); if (chatHistory.length > 60) chatHistory.shift()
  if (!msg.sys) {   // 記錄到資料庫（含密語），供 GM 查詢
    db.chatLog = db.chatLog || []
    db.chatLog.push({ t: msg.t, from: msg.from, to: msg.to || null, text: msg.text, raw: msg.raw && msg.raw !== msg.text ? msg.raw : undefined })
    if (db.chatLog.length > CHAT_LOG_MAX) db.chatLog.splice(0, db.chatLog.length - CHAT_LOG_MAX)
    dirty = true
  }
  if (msg.to) { sendTo(msg.toKey, 'chat', stripKeys(msg)); sendTo(msg.fromKey, 'chat', stripKeys(msg)) } else broadcast('chat', stripKeys(msg))
}
const stripKeys = (m) => ({ t: m.t, from: m.from, to: m.to, text: m.text, sys: m.sys })
function sysChat(text) { const m = { from: '天道', text, sys: true, t: now() }; chatHistory.push(m); if (chatHistory.length > 60) chatHistory.shift(); broadcast('chat', m) }
// 傳書：伺服器發給玩家的東西（拍賣所得、退款、GM 贈送、魔蛟獎勵、切磋輸贏…）。
// 【第二階段】在這裡「直接入帳」到伺服器存檔，再通知前端顯示訊息；前端不再自己加減數值。
// pl.mail 只保留通知文字（玩家離線時，下次登入會看到），最多 50 則。
function mail(key, m) {
  const p = db.players[key]; if (!p) return
  const s = getSave(key)
  if (m.kind === 'stones') s.stones = Math.max(0, s.stones + (Number(m.amount) || 0))
  else if (m.kind === 'item' && R.ITEMS[m.item]) s.inventory[m.item] = (s.inventory[m.item] || 0) + (Number(m.qty) || 1)
  else if (m.kind === 'xp') s.xp = Math.min(R.required(s), s.xp + R.xpGain(s, Number(m.amount) || 0))
  s.v = (s.v || 0) + 1
  m.id = db.nextId++; p.mail = p.mail || []; p.mail.push(m); if (p.mail.length > 50) p.mail.splice(0, p.mail.length - 50)
  dirty = true
  sendTo(key, 'mail', { mail: [m], state: R.publicSave(s) })
}
// 取得玩家存檔（必要時建立新存檔，或把舊格式轉成新格式）
function getSave(key) {
  const p = db.players[key]
  if (!p.save || p.save.fmt !== R.SAVE_FMT) { p.save = R.migrate(p.save); dirty = true }
  p.save.gm = isGMKey(key)
  return p.save
}
const NPC_PREFIX = 'npc_'
const isNpc = (k) => typeof k === 'string' && k.startsWith(NPC_PREFIX)
const nameOf = (k) => (db.players[k] || {}).name || (isNpc(k) ? k.slice(NPC_PREFIX.length) : k)
const pubAuctions = () => db.auctions.map((a) => ({ id: a.id, seller: nameOf(a.seller), item: a.item, qty: a.qty, start: a.start, current: a.current, bidder: a.bidder ? nameOf(a.bidder) : null, inc: a.inc, endsAt: a.endsAt }))
const pubBoss = () => ({ name: boss.name, maxHp: boss.maxHp, hp: boss.hp, alive: boss.alive, respawnAt: boss.respawnAt, top: topDamage(5) })

/* ---------- 世界 Boss ---------- */
const boss = { name: '九幽魔蛟', maxHp: 50000, hp: 50000, alive: true, respawnAt: 0, damage: {}, lastHit: null }
// 世界王掉落由伺服器判定（客戶端不再自己擲）：每次出手各擲一次，境界須達 BOSS_LOOT_MIN_REALM（0 煉氣…3 元嬰）才有機會
const BOSS_LOOT_MIN_REALM = R.BOSS_LOOT_MIN_REALM, BOSS_PET_LOOT = R.BOSS_PET_LOOT   // 機率在 shared/game-rules.js
const bossMaxHpNow = () => Math.min(500000, 30000 + 20000 * Math.max(1, onlineKeys().length))   // 重生時依在線人數調整血量
function topDamage(n) { return Object.entries(boss.damage).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, d]) => ({ name: (db.players[k] || {}).name || k, dmg: d })) }
function atkRange(s) { const base = 8 + (s.realm || 0) * 10 + (s.layer || 1) * 2, v = Math.round(base * 0.3); return [Math.max(1, base - v), base + v] }
function killBoss() {
  boss.alive = false; boss.respawnAt = now() + 120000
  const total = Object.values(boss.damage).reduce((a, b) => a + b, 0) || 1
  const top = topDamage(1)[0]
  for (const [k, d] of Object.entries(boss.damage)) {
    const share = d / total
    mail(k, { kind: 'stones', amount: 200 + Math.floor(share * 3000), text: `討伐「${boss.name}」有功（傷害占比 ${Math.round(share * 100)}%），獲得靈石。` })
    mail(k, { kind: 'xp', amount: 50 + Math.floor(share * 300), text: '魔蛟精元入體，修為增加。' })
  }
  if (boss.lastHit) mail(boss.lastHit, { kind: 'item', item: 'thunderCrystal', qty: 1, text: '你給予魔蛟最後一擊，獲得雷晶。' })
  if (top) {
    const key = Object.keys(db.players).find((k) => db.players[k].name === top.name)
    if (key) {
      mail(key, { kind: 'item', item: 'jadeSlip', qty: 1, text: '你是傷害第一，獲得破損玉簡。' })
      mail(key, { kind: 'item', item: 'divineFeed', qty: 1, text: '你是傷害第一，另獲神級寵物飼料。' })
    }
  }
  sysChat(`「${boss.name}」被眾修士合力擊殺！最後一擊：${(db.players[boss.lastHit] || {}).name || '?'}，傷害第一：${top ? top.name : '?'}。`)
  broadcast('boss', pubBoss())
}
setInterval(() => {
  if (!boss.alive && now() >= boss.respawnAt) { boss.maxHp = bossMaxHpNow(); Object.assign(boss, { hp: boss.maxHp, alive: true, damage: {}, lastHit: null, respawnAt: 0 }); sysChat(`「${boss.name}」再次現世，速往魔蛟頁籤討伐！`); broadcast('boss', pubBoss()) }
}, 1000)

/* ---------- 拍賣 ---------- */
setInterval(() => {
  const t = now(); let changed = false
  db.auctions = db.auctions.filter((a) => {
    if (a.endsAt > t) return true
    changed = true; dirty = true
    if (a.bidder) {
      mail(a.seller, { kind: 'stones', amount: a.current, text: `你上架的物品被「${nameOf(a.bidder)}」以 ${a.current} 靈石標走。` })
      mail(a.bidder, { kind: 'item', item: a.item, qty: a.qty, text: `你以 ${a.current} 靈石標得拍賣品。` })
    } else mail(a.seller, { kind: 'item', item: a.item, qty: a.qty, text: '你上架的物品流拍，已退回。' })
    return false
  })
  if (changed) broadcast('auctions', pubAuctions())
}, 1000)

/* ---------- 全服拍賣 NPC 隨機上架 ----------
 * 每隔 1～5 分鐘（隨機）會有一位 NPC 上架一件物品；物品越高級，被選中的機率越低。
 * 物品清單來自 shared/game-rules.js 的 ITEMS（交易所販售的 SHOP_ITEMS 除外），之後新增道具會自動納入。
 * 調整頻率改 NPC_LIST_MIN／NPC_LIST_MAX（秒）；調整稀有度機率改 NPC_RARITY_WEIGHT。 */
const NPC_NAMES = ['天機子', '素衣仙子', '赤霄道人', '青鸞上仙']
const NPC_LIST_MIN = 60, NPC_LIST_MAX = 300
const NPC_RARITY_WEIGHT = { '普通': 60, '精良': 25, '稀有': 10, '史詩': 3 }   // 相對權重：越高級越低
const NPC_RARITY_QTY = { '普通': [1, 6], '精良': [1, 4], '稀有': [1, 2], '史詩': [1, 1] }  // 上架數量範圍
const NPC_MAX_LISTINGS = 6                                                      // NPC 同時上架的上限
let NPC_POOL = []
function loadNpcPool() {
  NPC_POOL = Object.entries(R.ITEMS)
    .filter(([id, d]) => !R.SHOP_ITEMS.includes(id) && NPC_RARITY_WEIGHT[d.rarity] && d.sell > 0)
    .map(([id, d]) => ({ id, name: d.name || id, icon: d.icon || '', rarity: d.rarity, sell: d.sell, w: NPC_RARITY_WEIGHT[d.rarity] }))
  // 以「稀有度」為單位分配機率（普通約 60%、史詩約 3%…），同稀有度內平均分配，不受該稀有度道具種類多寡影響
  const cnt = {}; NPC_POOL.forEach((x) => { cnt[x.rarity] = (cnt[x.rarity] || 0) + 1 })
  NPC_POOL.forEach((x) => { x.w = NPC_RARITY_WEIGHT[x.rarity] / cnt[x.rarity] })
  console.log(`拍賣 NPC 物品池：${NPC_POOL.length} 種`)
}
loadNpcPool()
let nextNpcListAt = now() + rnd(NPC_LIST_MIN, NPC_LIST_MAX) * 1000
setInterval(() => {
  const t = now()
  if (t < nextNpcListAt) return
  nextNpcListAt = t + rnd(NPC_LIST_MIN, NPC_LIST_MAX) * 1000
  if (!NPC_POOL.length || !clients.size) return                                  // 沒人在線就不上架，避免無人理會
  if (db.auctions.filter((a) => isNpc(a.seller)).length >= NPC_MAX_LISTINGS) return
  let roll = Math.random() * NPC_POOL.reduce((n, x) => n + x.w, 0)
  const pick = NPC_POOL.find((x) => (roll -= x.w) < 0) || NPC_POOL[0]
  const [qlo, qhi] = NPC_RARITY_QTY[pick.rarity]
  const qty = rnd(qlo, qhi)
  const unit = Math.max(1, Math.round(pick.sell * (1.1 + Math.random() * 0.7)))  // 每件約為出售價的 1.1～1.8 倍（下限高於商店收購價，避免套利）
  const price = unit * qty
  const npc = NPC_PREFIX + NPC_NAMES[rnd(0, NPC_NAMES.length - 1)]
  db.auctions.push({ id: 'a' + db.nextId++, seller: npc, item: pick.id, qty, start: price, current: price, bidder: null, inc: Math.max(3, Math.round(price * 0.1)), endsAt: t + 180000 })
  dirty = true
  broadcast('auctions', pubAuctions())
  sysChat(`「${nameOf(npc)}」在拍賣場上架了 ${pick.icon}「${pick.name}」× ${qty}，起標 ${price} 靈石。`)
}, 1000)

/* ---------- 全服拍賣 NPC 隨機競標（降低頻率）---------- */
setInterval(() => {
  const t = now();
  db.auctions.forEach(a => {
    if (a.endsAt > t && !a.bidder && !isNpc(a.seller) && Math.random() < 0.01) {
      const randomNpc = NPC_NAMES[Math.floor(Math.random() * NPC_NAMES.length)];
      const rate = Math.random() < 0.7 ? 0.1 : 0.3;
      const inc = Math.ceil(a.current * rate);
      a.current += inc;
      a.bidder = NPC_PREFIX + randomNpc; 
      dirty = true;
      broadcast('auctions', pubAuctions());
    }
  });
}, 5000);

/* ---------- PvP ---------- */
function duel(a, b) {
  let ha = R.maxHp(a), hb = R.maxHp(b)
  const ra = atkRange(a), rb = atkRange(b)
  for (let i = 0; i < 40; i++) {
    hb -= rnd(ra[0], ra[1]); if (hb <= 0) return true
    ha -= rnd(rb[0], rb[1]); if (ha <= 0) return false
  }
  return ha / R.maxHp(a) >= hb / R.maxHp(b)
}

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.gif': 'image/gif' }
function body(req) {
  return new Promise((resolve) => {
    let s = ''; req.on('data', (c) => { s += c; if (s.length > 30000) { req.destroy(); resolve({}) } })
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')) } catch (e) { resolve({}) } })
  })
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }
const cleanName = (n) => String(n || '').trim().replace(/[<>&"'\s]/g, '').slice(0, 12)
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(v) || 0)))

/* ---------- 地圖與即時戰鬥 ----------
 * 地圖資料以伺服器為準（MAPS），進入時傳給客戶端。座標單位為「格」（浮點數）。
 * 圖例：. 草地  , 石板地坪  = 道路  H 橋  # 樹（不可走）  ~ 水（不可走）  B 建築（不可走）  R 岩石（不可走）  W 城牆（不可走）  F 圍籬（不可走）
 * 主城（town）是安全區；每個秘境（LOCATIONS）各有一張野外地圖，妖獸由伺服器生成、移動、攻擊。
 * 【第三階段】全部由伺服器計算：妖獸氣血/位置/AI、玩家攻擊距離與冷卻、傷害（境界、宗門、增益、神識、靈寵）、
 * 功法靈力與冷卻、妖獸對玩家的傷害與重傷撤退、擊殺的修為／掉落／任務進度。前端只負責畫面。 */
const MOVE_SPEED = 5.5, MOVE_R = 0.3
const TOWN_NPCS = [
  { id: 'character', name: '修煉導師', x: 21.5, y: 16.5, panel: 'character', color: '#5f8f5a' },   // 西北：修煉殿門前
  { id: 'market', name: '交易所掌櫃', x: 7.5, y: 14.5, panel: 'market', color: '#c9a24a' },        // 西北：坊市攤棚前
  { id: 'techniques', name: '藏經閣執事', x: 36.5, y: 22.5, panel: 'techniques', color: '#8a6bd1' }, // 北：二層樓閣門前
  { id: 'world', name: '傳訊童子', x: 63.5, y: 20.5, panel: 'world', color: '#5aa5b5' },           // 東北：掛匾正廳前
  { id: 'realm', name: '秘境引路人', x: 31.5, y: 32.5, panel: 'realm', color: '#6a4ab5' },         // 中央廣場：傳送陣旁
  { id: 'auction', name: '拍賣官', x: 44.5, y: 45.5, panel: 'auction', color: '#b35a3c' },          // 中南：大樓門口
  { id: 'pets', name: '靈寵司', x: 6.5, y: 37.5, panel: 'pets', color: '#3a9a6a' },               // 西：魚池邊沙地
  { id: 'sect', name: '宗門長老', x: 21.5, y: 51.5, panel: 'sect', color: '#4a7fb5' },            // 西南：宗門大殿台階下
  { id: 'boss', name: '鎮魔使', x: 63.5, y: 43.5, panel: 'boss', color: '#a33' },                // 東南：殿前廣場
]
const TOWN_SPAWN = { x: 36.5, y: 33.5 }   // 中央噴泉南側
/* 天玄城：整張背景圖 img/new.jpg（1200×896）切成 75×56 格，每格對應原圖 16px（畫面上放大成 32px）。
 * .可走  B建築／樹叢／圍籬（不可走）  ~水（不可走）。碰撞一律以 rows 為準，前端直接貼整張圖。 */
const TOWN_ZONES = []
const TOWN_BUILDINGS = []
const TOWN_PORTALS = [{ x: 32.5, y: 30.0, name: '秘境傳送陣' }]
const TOWN_ROWS = [
  '............BBB.......................BBB..B...BBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  '............BBB...............BBBBBBBBBBB..B...BBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'BBBBBBBBBBBBBBBBBBBBBBBBB.....BBBBBBBBBB...B...BBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'BBBBBBBBBBBBBBBBBBBBBBBBB.....BBBBBBBBBB...B...BB.BB.BBBBBBBBBBBBBBBBBBBBBB',
  'BBBBBBBBBBBBBBBBBBBBBBBBB.....BBBBBBBBBB...B...BB....BBBBBBBBBBBBBBBBBBBBBB',
  'BBBBBBBBBBBBBBBBBBBBBBBBB..................B...BB....BBBBBBBBBBBBBBBBBBBBBB',
  'BBBBBBBBBBBBBBBBBBBBBBBBB..................B..BBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'BBBBBBBBBBBBBBBBBBBBBBBBB.....................BBB...BBBBBBBBBB.BBBBB.BBBBBB',
  'BBBBBBBBBBBBBBBBBBBBBBBBBBBB...................BB....BB..BBBBB..BBBB.BBBBB.',
  'BBBBBBBBBBBBBBBBBBBBBBBBBB~~..BB...............................B...........',
  'BBBBBBBBBBBBBBBBBBBBBBBBBBBB.BBB..........BB................BBBBBBB........',
  'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB...BBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'BBB.BBB.BBB.BBBBBBBBBBBBBBBBBBBB....BB...BBB...BBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'BBB.BBB.BBB.BBBBBBBBBBBBBBBBBBB..BBBBBBB.BBB...B.....BBBBBB.BBBBBBB.BBBBB.B',
  '...............BB.BBBBBBBBBBBBBBBBBBBBBBBBBB...B..BB.BBBBBBBBBBBBBB.BBBBBBB',
  'BBBBBBB.........BBBBBBBBBBBBBBBBBBBBBBBBBBBB...B.....BBBBBBBBBBBBBBBBBBBBBB',
  'BBBBBBB............B...BBBBBBBBBBBBBBBBBBBBB...B.....BBBBBBBBBBBBBBBBBBBBBB',
  'BBBBBBB.........BB.....BBBBBBBBBBBBBBBBBBBBB...BBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'BBBB..B.BBB.....BBB....BBBBBBBBBBBBBBBBBBBBB........BBBBB.BBBBB.BBBBB.BBBBB',
  'BBBBBBBBBBB.....BBB....BBBBBBBBBBBBBBBBBBBBB........BBBBB.BBBBB.BBBBB..BBBB',
  'BBBBBBBBBBB.....BB.....BBBBBBBBBBBBBBBBBBBBB...............................',
  '.BBBB.BBBBB.....BBB....BBBBBBBBBBBBBBBBBBBBB...............................',
  'BBB.BBB...B.....BBB....BBBBBBBB....................BBBBBBBBBBBBBBBBBBBBBBBB',
  'BBBBBBBBB.BBB.....................................BBBBBBBBBBBBBBBBBBBBBBBBB',
  'BBBBBBBBBBBBBB......BBBBBBB.................BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  '..BBBBBBBBBBBB......BBBBBBB................BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  '...BBBBBBBBB........BBBBBBB.B.............BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'BBBBBBBBBBB......B..BBBBBBB.BBB...BB~~~B..BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'BBBBBBBBBBB....BBB.BBBBBBBBBBBBB..~~~BBB.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'BBBBBBBBBBBB....BB.BBBBBBBBB.BBB..~BB~~B.BBBBBBBBBBB~~~~~~~~~~~~~~~~~~~~~~~',
  'BBBBBBB.BBB.....BBBBBBBBBB...BB...BB~~BB..BBBBBBBBBB~~~~~~~~~~~~~~~~~~~~~~~',
  'BBBBBBB.BBB....BBBBBBBBBBB...BB....BB.B...BBBBBBBBBB~~~~~~~~~~~~~~~~~~~~~~~',
  '................BBBBBBBBBB...BB...................BB~~~~~~~~~~~~~~~~~~~~~~~',
  '...................B.........BB.............B.BB..BB~~~~~~~~~BBBBB~~~~~~~~~',
  '..........B........B.........BBBB......BBBBBBBBBBBBBB~~~~~~~BBBBBB~~~~~~~~~',
  'BBBB.....BBBBBBB...B.BBBBB...BBBB......BBBBBBBBBBBBBB~BBBBBBBBBBBBBBBB.B~~~',
  '~~~~B....BBBBBBBBBBBBBBBBBBB...........BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB~~~',
  '~~~~B...BBBB...............BBBBBBBB....BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB~~~',
  '~~~~B...BBBB....................BB......BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB.B~~~',
  'BBBB....BBBB..BBB...............BB...BBBBBBBBBBBBBBBBBBBBBB.BBBBBBBBBBBB~~~',
  '........BBBB.BBBB...............BB...BBBBBBBBBBBBBBBBBBBBBB.BBBBBBBBBBBB~~~',
  'BBBBBBBBBBBB.BBB.BBBBBBBBBBBB~~BBBB..BBBBBBBBBBBBBBBBB.BBBB.BBBBBBB..BBB~~~',
  'BBBBBBBBBBBB.....BBBBBBBBBBB~~~BBBB...BBBBBBBBBBBBBBBB.BBBB.BB.........B~~~',
  '~~~~~~~~~~BB.....BBBBBBBBBBB~~~BBBB.....BBBBBBBBBBBBBB.BBBB.B.........BB~~~',
  '~~~~~~~~~~BB.....BBBBBBBBBBB~~~BBB......BBBBBBBBBBBBBB................BBB~~',
  'BBBBBBBBBBBB.....BBBBBBBBBBB~~~BBB.......B.....BBBBBBB.....................',
  'BBBBBBBBBBBB.....BBBBBBBBBBB~~~BBB......BB.BB.BBBBBBBB................BBBBB',
  '~~~~~~~~~~BB....BBBBBBBBBBBB~~~BBBB.....BB....BBB~~~~B................BB~~~',
  '~~~~~~~~~~BB....BBBB...BBBBB~~~BBB............BBB~~~~BBBBBBBB....BBBBBBB~~~',
  '~~~~~~~~~~BB.....BBB...BBB.B~~~BBB...............................BBBBBBB~~~',
  '~~~~~~~~~~BB.....B.B.......B~~~BBB...............................B.....B~~~',
  '.B.B..B...BB.....BBB....BBBB~~~BBBB....BBB....BBBBBBBBBBBBBBB....BBBBBBB~~~',
  '.B.BB.B.B.BB.....BBB....BBB.BBB........BBBB...BBBBBBBBBBBBBBB....BBBBBBB~~~',
  'BBBBBBBBBBB.....................B......BB.B...B~~~~~~~~~~~~~~B...B~BBBBB~~~',
  'BBBBBBBBBBB..B..B.B..B..B.B..B..BB.....BBBB...B~~~~~~~~~~~~~~B...BBBBBBBBB~',
  'BBBBBB.BBBB..BBBB.BB.BBBBBB.BBBBBB.....BBBBB..B~~~~~~~~~~~~~~BB.BBBBBBBBB.B'
]
const mkTownRows = () => {
  const g = TOWN_ROWS.map((r) => r.split(''))
  // 保證出生點、NPC 與傳送陣落在可通行格
  for (const n of [...TOWN_NPCS, TOWN_SPAWN, ...TOWN_PORTALS]) {
    const tx = Math.floor(n.x), ty = Math.floor(n.y)
    if (g[ty] && g[ty][tx] && g[ty][tx] !== '.') g[ty][tx] = '.'
  }
  return g.map((r) => r.join(''))
}
const mkTownProps = () => []   // 燈籠、木桶等已畫在背景圖上，不再額外疊加
const MAPS = {}
MAPS.town = { id: 'town', name: '天玄城', rows: mkTownRows(), npcs: TOWN_NPCS, spawn: TOWN_SPAWN, theme: { g1: '#4f744d', g2: '#52784f' }, deco: { zones: TOWN_ZONES.map(({ name, x, y, w, h }) => ({ name, x, y, w, h })), buildings: TOWN_BUILDINGS, portals: TOWN_PORTALS } }
MAPS.town.deco.props = mkTownProps(MAPS.town.rows)
MAPS.town.theme = { g1: '#7cc24f', g2: '#79be4c' }

let LOCS = []
function loadGameData() {
  LOCS = R.LOCATIONS
  LOCS.forEach((loc, idx) => { MAPS[loc.id] = genField(loc, idx) })
  console.log(`野外地圖：${LOCS.length} 張`)
}
const mkRng = (seed) => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
function genField(loc, idx) {
  const W = 56, H = 36, rnd = mkRng([...loc.id].reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7))
  const g = Array.from({ length: H }, () => Array(W).fill('.'))
  const px = 28, py = 33
  const near = (x, y, r) => Math.hypot(x - px, y - py) < r
  for (let x = 0; x < W; x++) { g[0][x] = '#'; g[H - 1][x] = '#' }
  for (let y = 0; y < H; y++) { g[y][0] = '#'; g[y][W - 1] = '#' }
  for (let i = 0; i < 12; i++) {   // 水塘
    const w = 3 + Math.floor(rnd() * 4), h = 2 + Math.floor(rnd() * 3), x0 = 2 + Math.floor(rnd() * (W - w - 4)), y0 = 2 + Math.floor(rnd() * (H - h - 8))
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) g[y][x] = '~'
  }
  for (let i = 0; i < 150; i++) { const x = 1 + Math.floor(rnd() * (W - 2)), y = 1 + Math.floor(rnd() * (H - 2)); if (g[y][x] === '.' && !near(x, y, 5)) g[y][x] = rnd() < 0.75 ? '#' : 'R' }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (near(x, y, 2.6) && g[y][x] === '.') g[y][x] = '='
  const sx = Math.floor(px), sy = Math.floor(py)
  // 由傳送陣向外淹水式搜尋可走區域，妖獸只生在連得到的地方
  const seen = new Set([sy * W + sx]), q = [[sx, sy]], reach = []
  while (q.length) {
    const [x, y] = q.shift(); reach.push([x, y])
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = ny * W + nx
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen.has(k) || '#~BR'.includes(g[ny][nx])) continue
      seen.add(k); q.push([nx, ny])
    }
  }
  const spots = reach.filter(([x, y]) => Math.hypot(x - px, y - py) > 9)
  const hue = (idx * 41 + 95) % 360
  return {
    id: loc.id, name: loc.name, loc, rows: g.map((r) => r.join('')),
    npcs: [{ id: 'exit', name: '傳送陣（返回主城）', x: px + 0.5, y: py + 0.5, panel: '__exit', color: '#8a6bd1' }],
    spawn: { x: px + 0.5, y: py - 1.5 }, spots,
    theme: { g1: `hsl(${hue} 28% 27%)`, g2: `hsl(${hue} 30% 30%)` },
    types: loc.monsters.map((m) => ({ id: m.id, name: m.name, icon: m.icon, hp: m.hp, atkMin: m.atkMin, atkMax: m.atkMax, exp: m.exp })),
  }
}
const mapInfo = (m) => ({ id: m.id, name: m.name, w: m.rows[0].length, h: m.rows.length, rows: m.rows, npcs: m.npcs, speed: MOVE_SPEED, r: MOVE_R, theme: m.theme, types: m.types || null, deco: m.deco || null })
const tileBlocked = (m, x, y) => {
  const tx = Math.floor(x), ty = Math.floor(y)
  if (tx < 0 || ty < 0 || ty >= m.rows.length || tx >= m.rows[0].length) return true
  return '#~BRWF'.includes(m.rows[ty][tx])
}
const mapCollide = (m, x, y, r = MOVE_R) => tileBlocked(m, x - r, y - r) || tileBlocked(m, x + r, y - r) || tileBlocked(m, x - r, y + r) || tileBlocked(m, x + r, y + r)

loadGameData()
const positions = new Map()   // key -> { x, y, f, t, m }（只存在記憶體，不寫入雲端）
let posDirty = false
const posList = () => [...positions.entries()].filter(([k]) => onlineKeys().includes(k)).map(([k, p]) => ({ n: db.players[k].name, x: +p.x.toFixed(2), y: +p.y.toFixed(2), f: p.f, m: p.m }))
const ensurePos = (key) => { if (!positions.has(key)) { positions.set(key, { x: TOWN_SPAWN.x, y: TOWN_SPAWN.y, f: 'd', t: Date.now(), m: 'town' }); posDirty = true } return positions.get(key) }
const townInfo = () => mapInfo(MAPS.town)
setInterval(() => { if (posDirty) { posDirty = false; broadcast('pos', posList()) } }, 150)

/* ---- 野外妖獸（每張地圖一個共享場景，沒人時釋放，下次進入重新生成）---- */
const fields = {}
const rint = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a
const MON_R = 0.35, AGGRO = 6.5, LEASH = 15, MON_SPAWN = 20
function makeField(map) {
  const mons = []
  const defs = map.loc.monsters
  for (let i = 0; i < MON_SPAWN && map.spots.length; i++) {
    const [tx, ty] = map.spots[Math.floor(Math.random() * map.spots.length)], t = Math.floor(Math.random() * defs.length)
    mons.push({ i, t, x: tx + 0.5, y: ty + 0.5, sx: tx + 0.5, sy: ty + 0.5, hp: defs[t].hp, st: 0, tg: null, cd: 1, wt: Math.random() * 3, wx: tx + 0.5, wy: ty + 0.5, rs: 0, dmg: {} })
  }
  return { mons, acc: 0 }
}
function stepMon(map, m, tx, ty, speed, dt) {
  const d = Math.hypot(tx - m.x, ty - m.y); if (d < 0.05) return
  const k = Math.min(d, speed * dt) / d, dx = (tx - m.x) * k, dy = (ty - m.y) * k
  if (!mapCollide(map, m.x + dx, m.y, MON_R)) m.x += dx
  if (!mapCollide(map, m.x, m.y + dy, MON_R)) m.y += dy
}
function killMon(map, f, m) {
  const def = map.loc.monsters[m.t]
  m.st = 2; m.rs = 10 + Math.random() * 6; m.tg = null
  const entries = Object.entries(m.dmg).filter(([k]) => onlineKeys().includes(k) && (positions.get(k) || {}).m === map.id)
  m.dmg = {}
  if (!entries.length) return
  const top = entries.sort((a, b) => b[1].d - a[1].d)[0][0]
  const lm = 1 + R.sectBonus(getSave(top), 'loot')   // 掉落加成依傷害第一者的存檔計算
  const loot = []
  for (const e of def.loot) if (Math.random() < e.chance * lm && R.ITEMS[e.item]) loot.push({ item: e.item, qty: rint(e.min, e.max) })
  for (const [k] of entries) {
    const s = getSave(k), out = []
    R.advance(s, now(), out)
    const mine = k === top ? loot : []
    const exp = R.fieldKill(s, def, mine, out)
    s.v++; dirty = true
    sendTo(k, 'kill', { name: def.name, exp, loot: mine, logs: out, state: R.publicSave(s) })
  }
}
// 妖獸打中玩家：伺服器扣氣血；氣血歸零就重傷、送回主城
function monHit(key, def, raw) {
  const s = getSave(key), out = []
  R.advance(s, now(), out)
  const r = R.fieldHit(s, raw)
  s.v++; dirty = true
  if (!r.dead) return sendTo(key, 'hit', { name: def.name, icon: def.icon, dmg: r.dmg, hp: s.hp, v: s.v, logs: out })
  R.fieldDefeat(s, out); s.v++
  const me = positions.get(key)
  if (me) { me.m = 'town'; me.x = TOWN_SPAWN.x; me.y = TOWN_SPAWN.y; me.t = Date.now(); me.f = 'd'; posDirty = true }
  sendTo(key, 'defeat', { dmg: r.dmg, logs: out, state: R.publicSave(s), map: townInfo(), x: TOWN_SPAWN.x, y: TOWN_SPAWN.y })
}
setInterval(() => {
  const dt = 0.1, byMap = {}
  for (const [k, p] of positions) if (p.m !== 'town' && onlineKeys().includes(k)) (byMap[p.m] = byMap[p.m] || []).push([k, p])
  for (const id of Object.keys(fields)) if (!byMap[id]) delete fields[id]
  for (const id of Object.keys(byMap)) {
    const map = MAPS[id]; if (!map || !map.loc) continue
    const f = fields[id] || (fields[id] = makeField(map)), defs = map.loc.monsters
    for (const m of f.mons) {
      const def = defs[m.t]
      if (m.st === 2) { m.rs -= dt; if (m.rs <= 0) { m.st = 0; m.hp = def.hp; m.x = m.sx; m.y = m.sy; m.dmg = {} } continue }
      m.cd -= dt
      // 目標：沿用現有目標，否則找範圍內最近的玩家
      let tgt = m.tg && byMap[id].find(([k]) => k === m.tg), best = tgt ? Math.hypot(tgt[1].x - m.x, tgt[1].y - m.y) : Infinity
      if (!tgt || best > AGGRO * 2) { tgt = null; best = AGGRO; for (const e of byMap[id]) { const d = Math.hypot(e[1].x - m.x, e[1].y - m.y); if (d < best) { best = d; tgt = e } } }
      if (tgt && Math.hypot(m.x - m.sx, m.y - m.sy) > LEASH) tgt = null
      if (tgt) {
        m.tg = tgt[0]; m.st = 1
        const d = Math.hypot(tgt[1].x - m.x, tgt[1].y - m.y)
        if (d > 1.0) stepMon(map, m, tgt[1].x, tgt[1].y, 2.6, dt)
        if (d < 1.25 && m.cd <= 0) { m.cd = 1.5 + Math.random() * 0.4; monHit(tgt[0], def, rint(def.atkMin, def.atkMax)) }
      } else {
        m.tg = null
        const away = Math.hypot(m.x - m.sx, m.y - m.sy)
        if (m.st === 1 || away > LEASH) { m.st = 1; stepMon(map, m, m.sx, m.sy, 4, dt); m.hp = Math.min(def.hp, m.hp + def.hp * 0.05 * dt); if (away < 0.6) { m.st = 0; m.hp = def.hp } }
        else { m.wt -= dt; if (m.wt <= 0) { m.wt = 2 + Math.random() * 3; m.wx = m.sx + (Math.random() - 0.5) * 6; m.wy = m.sy + (Math.random() - 0.5) * 6 }
          if (!mapCollide(map, m.wx, m.wy, MON_R)) stepMon(map, m, m.wx, m.wy, 0.9, dt) }
      }
    }
    f.acc += dt
    if (f.acc >= 0.2) {
      f.acc = 0
      const list = f.mons.map((m) => [m.i, m.t, +m.x.toFixed(2), +m.y.toFixed(2), Math.ceil(m.hp), m.st])
      for (const [k] of byMap[id]) sendTo(k, 'mon', { m: id, list })
    }
  }
}, 100)


async function handle(req, res) {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname

  if (req.method === 'GET' && p === '/api/stream') {
    const token = url.searchParams.get('token'), key = sessions.get(token)
    if (!key) { res.writeHead(401); return res.end() }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    const wasOnline = onlineKeys().includes(key)
    clients.set(token + Math.random(), { res, key })
    const cid = [...clients.entries()].find(([, c]) => c.res === res)[0]
    { const me = ensurePos(key); me.m = 'town'; me.x = TOWN_SPAWN.x; me.y = TOWN_SPAWN.y; me.t = Date.now(); posDirty = true }
    send(res, 'hello', { town: townInfo(), pos: posList(), serverTime: now(), online: presence(), auctions: pubAuctions(), boss: pubBoss(), chat: chatHistory.filter((m) => !m.to || m.fromKey === key || m.toKey === key).map(stripKeys) })
    if (!wasOnline) { broadcast('presence', presence()); sysChat(`「${db.players[key].name}」進入了修仙界。`) }
    const hb = setInterval(() => res.write(': hb\n\n'), 20000)
    req.on('close', () => {
      clearInterval(hb); clients.delete(cid)
      if (!onlineKeys().includes(key)) { positions.delete(key); posDirty = true; broadcast('presence', presence()); sysChat(`「${db.players[key].name}」離開了修仙界。`) }
    })
    return
  }

  if (req.method === 'POST' && p.startsWith('/api/')) {
    const b = await body(req)
    if (p === '/api/login') {
      if (limited(clientIp(req), 'login', 500)) return json(res, 429, { error: '操作太頻繁' })
      const name = cleanName(b.name), pw = String(b.password || '')
      if (name.toLowerCase().startsWith(NPC_PREFIX)) return json(res, 400, { error: '道號不可使用此前綴' })
      if (name.length < 2) return json(res, 400, { error: '道號需 2–12 字' })
      if (pw.length < 4) return json(res, 400, { error: '密碼至少 4 字元' })
      const key = name.toLowerCase()
      const lf = loginFails.get(key)
      if (lf && lf.until > now()) return json(res, 429, { error: `密碼錯誤次數過多，請 ${Math.ceil((lf.until - now()) / 60000)} 分鐘後再試` })
      const failLogin = () => {
        const f = loginFails.get(key) || { n: 0, until: 0 }
        f.n++
        if (f.n >= LOGIN_MAX_FAIL) { f.n = 0; f.until = now() + LOGIN_LOCK_MS; console.log(`[登入] ${key} 密碼連錯 ${LOGIN_MAX_FAIL} 次，鎖定 5 分鐘（IP ${clientIp(req)}）`) }
        loginFails.set(key, f)
        return json(res, 403, { error: '密碼錯誤' })
      }
      let pl = db.players[key], created = false
      if (isGMKey(key)) {
        if (!GM_PASSWORD) return json(res, 403, { error: '伺服器尚未設定 GM_PASSWORD，GM 帳號停用' })
        if (pw !== GM_PASSWORD) return failLogin()
        if (!pl) { const salt = crypto.randomBytes(16).toString('hex'); pl = db.players[key] = { name, salt, hash: hashPw(pw, salt), save: null, mail: [], created: now() }; created = true; dirty = true }
      } else if (!pl) {
        if (pw.length < 6) return json(res, 400, { error: '建立新角色時，密碼至少 6 字元' })   // 舊帳號仍可用原本的 4 字密碼登入
        const salt = crypto.randomBytes(16).toString('hex')
        pl = db.players[key] = { name, salt, hash: hashPw(pw, salt), save: null, mail: [], created: now() }; created = true; dirty = true
      } else if (hashPw(pw, pl.salt) !== pl.hash) return failLogin()
      loginFails.delete(key)
      const token = crypto.randomBytes(24).toString('hex'); sessions.set(token, key)
      // 登入時不補算離線時間；戰鬥、門票、閉關狀態重設（與舊版重新整理頁面時的行為相同）
      const sv = getSave(key)
      sv.t = now(); sv.battle = null; sv.selectedLocation = null; sv.secluded = false
      R.advance(sv, now(), [])   // 不補算時間（t 剛設為現在），只套用 GM 全道具等即時設定
      sv.v = (sv.v || 0) + 1; dirty = true
      return json(res, 200, { token, name: pl.name, created, gm: isGMKey(key), save: R.publicSave(sv), mail: pl.mail || [] })
    }
    const key = sessions.get(b.token)
    if (!key) return json(res, 401, { error: '登入已失效，請重新登入' })
    const pl = db.players[key]

    if (p === '/api/save') {
      // 【第二、三階段】已停用：存檔完全由伺服器保存，前端上傳的存檔一律不收（舊版網頁快取請重新整理）
      return json(res, 410, { error: '遊戲已更新，請重新整理頁面。' })
    }
    if (p === '/api/act') {
      // 所有會改變數值的操作都走這裡：前端送 { type, p }，規則在 shared/game-rules.js 的 ACTIONS
      const type = String(b.type || '')
      if (type === 'sync' ? limited(key, 'sync', 900) : limited(key, 'act', 60)) return json(res, 429, { error: '操作太快' })
      const s = getSave(key), before = s.realm + '|' + s.layer + '|' + s.sect
      let logs, error = null
      try { logs = R.runAction(s, type, b.p && typeof b.p === 'object' ? b.p : {}, now()) }
      catch (e) { if (!e.game) throw e; logs = e.out || []; error = e.message }
      dirty = true
      if (before !== s.realm + '|' + s.layer + '|' + s.sect) broadcast('presence', presence())
      return json(res, 200, { ok: !error, error, logs, state: R.publicSave(s) })
    }
    if (p === '/api/mail/ack') {
      // 傳書在送出時已入帳，這裡只是清掉已讀的通知
      const ids = new Set((b.ids || []).map(Number))
      pl.mail = (pl.mail || []).filter((m) => !ids.has(m.id)); dirty = true
      return json(res, 200, { ok: true })
    }
    if (p === '/api/gm/send') {
      // GM 專用：發送靈石／道具給指定玩家（離線也可，下次登入時由傳書自動入帳）
      if (!isGMKey(key)) return json(res, 403, { error: '無權限' })
      if (limited(key, 'gmsend', 300)) return json(res, 429, { error: '操作太快' })
      const tk = cleanName(b.target).toLowerCase(), tp = db.players[tk]
      if (!tp || isNpc(tk)) return json(res, 404, { error: '找不到此道號的玩家' })
      const stones = num(b.stones, 0, 1e9)
      const item = String(b.item || ''), qty = num(b.qty || 1, 1, 99999)
      if (!stones && !item) return json(res, 400, { error: '請至少填寫靈石或選擇道具' })
      if (item && !(/^[A-Za-z]{1,24}$/.test(item) && ITEM_DEFS[item])) return json(res, 400, { error: '無此道具' })
      const reason = String(b.text || '').trim().replace(/[<>]/g, '').slice(0, 60), note = reason ? `（${reason}）` : ''
      if (stones) mail(tk, { kind: 'stones', amount: stones, text: `天道傳書：獲贈 ${stones} 靈石${note}` })
      if (item) mail(tk, { kind: 'item', item, qty, text: `天道傳書：獲贈 ${ITEM_DEFS[item].icon || ''}「${ITEM_DEFS[item].name || item}」× ${qty}${note}` })
      db.gmLog = db.gmLog || []
      db.gmLog.push({ t: now(), gm: key, to: tk, stones, item, qty: item ? qty : 0, text: reason })
      if (db.gmLog.length > 500) db.gmLog.shift()
      dirty = true
      console.log(`[GM] ${key} -> ${tk}: 靈石 ${stones}${item ? `, ${item} x${qty}` : ''} ${reason}`)
      return json(res, 200, { ok: true, to: tp.name, online: onlineKeys().includes(tk) })
    }
    if (p === '/api/report') {
      // 玩家回報 BUG／建議：存進 db.reports（保留最近 200 筆），並通知在線 GM
      if (limited(key, 'report', 30000)) return json(res, 429, { error: '回報太頻繁，請稍後再試（30 秒）' })
      const text = String(b.text || '').trim().slice(0, 500)
      if (text.length < 5) return json(res, 400, { error: '內容太短' })
      const type = ['BUG／錯誤', '建議', '其他'].includes(b.type) ? b.type : '其他'
      const c = b.ctx && typeof b.ctx === 'object' ? b.ctx : {}
      const ctx = { page: String(c.page || '').slice(0, 20), realm: num(c.realm, 0, 6), layer: num(c.layer, 1, 9), sect: String(c.sect || '').slice(0, 16), ua: String(c.ua || '').slice(0, 120) }
      db.reports = db.reports || []
      db.reports.push({ id: 'r' + db.nextId++, t: now(), key, from: pl.name, type, text, ctx, done: false })
      if (db.reports.length > 200) db.reports.shift()
      dirty = true
      console.log(`[回報] ${pl.name} (${type}): ${text.slice(0, 80)}`)
      for (const gk of GM_NAMES) sendTo(gk, 'chat', { t: now(), from: '天道', text: `📮 收到新回報：「${pl.name}」（${type}）`, sys: true })
      return json(res, 200, { ok: true })
    }
    if (p === '/api/gm/reports') {
      if (!isGMKey(key)) return json(res, 403, { error: '無權限' })
      return json(res, 200, { ok: true, reports: db.reports || [] })
    }
    if (p === '/api/gm/report') {
      if (!isGMKey(key)) return json(res, 403, { error: '無權限' })
      const list = db.reports || [], r = list.find((x) => x.id === b.id)
      if (!r) return json(res, 404, { error: '找不到這筆回報' })
      if (b.action === 'delete') db.reports = list.filter((x) => x !== r)
      else r.done = b.action === 'done'
      dirty = true
      return json(res, 200, { ok: true })
    }
    if (p === '/api/gm/chatlog') {
      // GM 專用：查詢聊天紀錄（含密語、含被過濾前的原文）與目前的禁言名單
      if (!isGMKey(key)) return json(res, 403, { error: '無權限' })
      const q = String(b.q || '').trim().toLowerCase().slice(0, 30)
      let log = db.chatLog || []
      if (q) log = log.filter((m) => [m.from, m.to, m.text, m.raw].some((x) => x && String(x).toLowerCase().includes(q)))
      return json(res, 200, { ok: true, log: log.slice(-200), mutes: muteList() })
    }
    if (p === '/api/gm/mute') {
      // GM 專用：禁言／解除禁言。minutes = 0 代表解除；上限 525600（一年，視為永久）
      if (!isGMKey(key)) return json(res, 403, { error: '無權限' })
      const tk = cleanName(b.target).toLowerCase(), tp = db.players[tk]
      if (!tp || isNpc(tk)) return json(res, 404, { error: '找不到此道號的玩家' })
      if (isGMKey(tk)) return json(res, 400, { error: '不能禁言 GM' })
      const minutes = num(b.minutes, 0, 525600)
      db.mutes = db.mutes || {}
      if (minutes <= 0) delete db.mutes[tk]; else db.mutes[tk] = now() + minutes * 60000
      db.gmLog = db.gmLog || []
      db.gmLog.push({ t: now(), gm: key, to: tk, mute: minutes })
      if (db.gmLog.length > 500) db.gmLog.shift()
      dirty = true
      sendTo(tk, 'chat', { t: now(), from: '天道', text: minutes > 0 ? `你已被管理員禁言 ${minutes >= 525600 ? '（永久）' : minutes + ' 分鐘'}。` : '你的禁言已被解除。', sys: true })
      console.log(`[GM] ${key} ${minutes > 0 ? '禁言' : '解除禁言'} ${tk}${minutes > 0 ? ` ${minutes} 分鐘` : ''}`)
      return json(res, 200, { ok: true, name: tp.name, mutes: muteList() })
    }
    if (p === '/api/move') {
      const me = ensurePos(key), map = MAPS[me.m] || MAPS.town, t = Date.now()
      if (limited(key, 'move', 80)) return json(res, 200, { ok: true, x: me.x, y: me.y })
      const nx = Number(b.x), ny = Number(b.y)
      if (!isFinite(nx) || !isFinite(ny)) return json(res, 400, { error: '座標無效' })
      const dt = Math.min(1000, Math.max(50, t - me.t)), maxD = MOVE_SPEED * dt / 1000 * 1.35 + 0.35
      const d = Math.hypot(nx - me.x, ny - me.y)
      if (d > maxD || mapCollide(map, nx, ny)) { me.t = t; return json(res, 200, { ok: false, x: me.x, y: me.y }) }   // 拉回伺服器位置
      if (d > 0.001) posDirty = true
      me.x = nx; me.y = ny; me.t = t
      if (['u', 'd', 'l', 'r'].includes(b.f)) me.f = b.f
      return json(res, 200, { ok: true, x: me.x, y: me.y })
    }
    if (p === '/api/enter') {   // 換地圖：主城 <-> 秘境野外
      const id = String(b.map || ''), map = MAPS[id]
      if (!map) return json(res, 400, { error: '地圖不存在' })
      if (limited(key, 'enter', 600)) return json(res, 429, { error: '操作太頻繁' })
      const s = getSave(key), me = ensurePos(key)
      if (map.loc) {
        if (s.realm < map.loc.reqRealm) return json(res, 403, { error: '境界不足，無法進入' })
        if (s.selectedLocation !== id) return json(res, 403, { error: '請先在「秘境」購買此地門票。' })
        s.battle = null
      } else if (me.m !== 'town') s.selectedLocation = null   // 離開野外：門票作廢
      s.v = (s.v || 0) + 1; dirty = true
      me.m = id; me.x = map.spawn.x; me.y = map.spawn.y; me.t = Date.now(); me.f = 'd'; posDirty = true
      return json(res, 200, { ok: true, map: mapInfo(map), x: me.x, y: me.y, state: R.publicSave(s) })
    }
    if (p === '/api/attack') {   // 即時攻擊：自動鎖定射程內最近的妖獸
      const me = positions.get(key), map = me && MAPS[me.m]
      if (!map || !map.loc || !fields[me.m]) return json(res, 200, { ok: false, miss: true })
      if (limited(key, 'atk', 450)) return json(res, 200, { ok: false, cd: true })
      const skillId = b.skill ? String(b.skill) : null
      const range = skillId ? 4.5 : 2.0
      let tm = null, bd = range
      for (const m of fields[me.m].mons) { if (m.st === 2) continue; const d = Math.hypot(m.x - me.x, m.y - me.y); if (d < bd) { bd = d; tm = m } }
      if (!tm) return json(res, 200, { ok: false, miss: true })
      const s = getSave(key), out = []
      R.advance(s, now(), out)
      let prm
      try { prm = R.fieldStrikeParams(s, skillId) }   // 檢查功法、扣靈力、上冷卻、算加成（攻擊、神識、靈寵）
      catch (e) { if (!e.game) throw e; s.v++; dirty = true; return json(res, 200, { ok: false, error: e.message, logs: out, state: R.publicSave(s) }) }
      s.v++; dirty = true
      const base = 8 + s.realm * 10 + s.layer * 2
      const dmg = Math.max(1, Math.round(rint(Math.round(base * 0.7), Math.round(base * 1.3)) * prm.mult * (1 + prm.bonus))) + prm.pet
      tm.hp -= dmg; tm.tg = key; tm.st = 1
      const rec = tm.dmg[key] || (tm.dmg[key] = { d: 0 }); rec.d += dmg
      const def = map.loc.monsters[tm.t], hpLeft = Math.max(0, Math.ceil(tm.hp))
      if (tm.hp <= 0) killMon(map, fields[me.m], tm)
      return json(res, 200, { ok: true, mi: tm.i, dmg, hp: hpLeft, mx: tm.x, my: tm.y, name: def.name, logs: out, state: R.publicSave(s) })
    }
    if (p === '/api/chat') {
      const raw = String(b.text || '').trim().slice(0, 100), text = filterText(raw)
      if (!raw) return json(res, 400, { error: '訊息為空' })
      const ml = muteLeft(key)
      if (ml > 0) return json(res, 403, { error: `你已被管理員禁言，剩餘約 ${Math.ceil(ml / 60000)} 分鐘。` })
      if (limited(key, 'chat', 1000)) return json(res, 429, { error: '說話太快了' })
      if (b.to) {
        const tk = String(b.to).toLowerCase()
        if (!db.players[tk] || !onlineKeys().includes(tk)) return json(res, 404, { error: '對方不在線上' })
        chat({ from: pl.name, fromKey: key, to: db.players[tk].name, toKey: tk, text, raw })
      } else chat({ from: pl.name, fromKey: key, text, raw })
      return json(res, 200, { ok: true })
    }
    if (p === '/api/auction/list') {
      // price 為整組起標總價（客戶端 = 每件單價 × 數量），qty 為上架數量
      const item = String(b.item || ''), qty = num(b.qty || 1, 1, 99999), price = num(b.price, 1, 1e12)
      if (!/^[A-Za-z]{1,24}$/.test(item) || price < 1 || qty < 1) return json(res, 400, { error: '參數錯誤' })
      if (db.auctions.filter((a) => a.seller === key).length >= 5) return json(res, 400, { error: '最多同時上架 5 件' })
      if (!R.ITEMS[item]) return json(res, 400, { error: '無此道具' })
      if (R.SHOP_ITEMS.includes(item)) return json(res, 400, { error: '交易所販售的道具無法上架拍賣場。' })
      // 以伺服器存檔驗證持有數量，並在伺服器端扣除（GM 物品無限）
      const s = getSave(key), inv = s.inventory
      if ((inv[item] || 0) < qty) return json(res, 400, { error: '背包中的物品數量不足' })
      if (!s.gm) { inv[item] -= qty; if (inv[item] <= 0) delete inv[item] }
      s.v = (s.v || 0) + 1
      const a = { id: 'a' + db.nextId++, seller: key, item, qty, start: price, current: price, bidder: null, inc: Math.max(3, Math.round(price * 0.1)), endsAt: now() + 180000 }
      db.auctions.push(a); dirty = true
      broadcast('auctions', pubAuctions())
      return json(res, 200, { ok: true, state: R.publicSave(s) })
    }
    if (p === '/api/auction/bid') {
      const a = db.auctions.find((x) => x.id === b.id)
      if (!a || a.endsAt <= now()) return json(res, 404, { error: '拍賣已結束' })
      if (a.seller === key) return json(res, 400, { error: '不能競標自己的物品' })
      if (a.bidder === key) return json(res, 400, { error: '你已是最高出價者' })
      
      const basePrice = a.bidder ? a.current : a.start;
      const amount = b.amount ? num(b.amount, basePrice + 1, 1e12) : (a.bidder ? a.current + a.inc : a.start);

      if (amount <= basePrice) return json(res, 400, { error: '出價必須高於目前底價' })
      // 【第一階段】伺服器自己檢查並扣款（舊版只有前端扣，直接呼叫 API 出價不用錢、被超價還會退錢 = 印鈔機）
      const ps = getSave(key)
      if (ps.stones < amount) return json(res, 400, { error: '靈石不足，無法出價' })
      if (limited(key, 'bid', 400)) return json(res, 429, { error: '操作太快' })
      ps.stones -= amount; ps.v = (ps.v || 0) + 1

      if (a.bidder) mail(a.bidder, { kind: 'stones', amount: a.current, text: `你在拍賣中被超越，退還 ${a.current} 靈石。` })
      a.current = amount; a.bidder = key; 
      if (a.endsAt - now() < 15000) a.endsAt += 15000; 
      dirty = true
      
      broadcast('auctions', pubAuctions())
      return json(res, 200, { ok: true, amount, state: R.publicSave(ps) })
    }
    if (p === '/api/pvp') {
      const tk = String(b.target || '').toLowerCase(), tp = db.players[tk]
      if (!tp || tk === key || !onlineKeys().includes(tk)) return json(res, 400, { error: '對手不在線上' })
      if (limited(key, 'pvp', 30000)) return json(res, 429, { error: '切磋冷卻中（30 秒）' })
      const a = getSave(key), c = getSave(tk)
      const win = duel(a, c), winner = win ? key : tk, loser = win ? tk : key
      const loot = Math.min(300, Math.floor(getSave(loser).stones * 0.05))
      if (loot > 0) {
        mail(winner, { kind: 'stones', amount: loot, text: `切磋勝出，奪得 ${loot} 靈石。` })
        mail(loser, { kind: 'stones', amount: -loot, text: `切磋落敗，損失 ${loot} 靈石。` })
      }
      sysChat(`👤「${pl.name}」向「${tp.name}」發起切磋，勝者：${db.players[winner].name}${loot > 0 ? `（奪得 ${loot} 靈石）` : ''}。`)
      return json(res, 200, { ok: true, win, loot, state: R.publicSave(getSave(key)) })
    }
    if (p === '/api/boss/attack') {
      if (!boss.alive) return json(res, 400, { error: '魔蛟尚未現世' })
      if (limited(key, 'boss', 1800)) return json(res, 429, { error: '出手太快' })
      const s = getSave(key), out = []
      R.advance(s, now(), out)
      let prm
      try { prm = R.bossStrikeParams(s, b.skill ? String(b.skill) : null) }   // 檢查氣血門檻、扣靈力或功法消耗、算倍率
      catch (e) { if (!e.game) throw e; s.v++; dirty = true; return json(res, 200, { ok: false, error: e.message, logs: out, state: R.publicSave(s) }) }
      s.v++; dirty = true
      const r = atkRange(s), dmg = Math.round(rnd(r[0], r[1]) * 3 * prm.mult)
      boss.hp = Math.max(0, boss.hp - dmg); boss.damage[key] = (boss.damage[key] || 0) + dmg; boss.lastHit = key
      out.push([prm.skill ? `你施展「${prm.skill.name}」轟向「${boss.name}」，造成 ${dmg} 點傷害。` : `你向「${boss.name}」發出一擊，造成 ${dmg} 點傷害。`, 'success'])
      const bossLog = [prm.skill ? `你施展「${prm.skill.name}」，造成 ${dmg} 點傷害。` : `你出手造成 ${dmg} 點傷害。`]
      if (s.realm >= BOSS_LOOT_MIN_REALM) {
        for (const l of BOSS_PET_LOOT) if (Math.random() < l.chance) mail(key, { kind: 'item', item: l.item, qty: 1, text: `魔蛟鱗甲崩落之間，你眼明手快拾得 ${(ITEM_DEFS[l.item] || {}).icon || ''}「${(ITEM_DEFS[l.item] || {}).name || l.item}」！` })
      }
      const killed = boss.hp <= 0
      if (killed) killBoss()
      else { bossLog.push(R.bossCounter(s, boss.name, boss.hp / boss.maxHp < 0.3, out)); broadcast('boss', pubBoss()) }
      return json(res, 200, { ok: true, dmg, killed, logs: out, bossLog, state: R.publicSave(s) })
    }
    return json(res, 404, { error: '未知的請求' })
  }

  // 靜態檔案
  // 【第一階段】改成白名單：只開放遊戲畫面用得到的檔案（index.html、style.css、根目錄圖片、img/ 底下的圖片）。
  // 舊版是黑名單，package.json、game.js、python/、node_modules 等全都能被下載。要開放新檔案就改 PUBLIC_FILE。
  // shared/game-rules.js 是前端也要載入的共用規則（沒有任何密碼或金鑰）。
  let f
  try { f = decodeURIComponent(p === '/' ? '/index.html' : p) } catch (e) { res.writeHead(400); return res.end('Bad request') }
  if (!PUBLIC_FILE.test(f) || f.split('/').some((seg) => seg.startsWith('.'))) { res.writeHead(404); return res.end('Not found') }
  const full = path.join(__dirname, f)
  if (!full.startsWith(__dirname + path.sep)) { res.writeHead(403); return res.end('Forbidden') }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found') }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' }); res.end(buf)
  })
}
const PUBLIC_FILE = /^\/(?:index\.html|style\.css|shared\/game-rules\.js|[^/]+\.(?:jpe?g|png|webp|gif|svg|ico)|img\/(?:[^/]+\/)*[^/]+\.(?:jpe?g|png|webp|gif|svg|ico))$/i
// 【第一階段】任何請求出錯都只回 500，不會讓整個伺服器當掉
// （舊版：瀏覽器打開 /%E0 這種壞網址，decodeURIComponent 會丟錯，Node 會直接結束程序 → 全服斷線）
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('請求處理錯誤：', req.method, req.url, e && e.stack || e)
    try { if (!res.headersSent) { res.writeHead(500); res.end('Server error') } else res.end() } catch (_) {}
  })
})

// 先從雲端載入資料後，再啟動伺服器
// 【第一階段】雲端讀取成功才開放連線；失敗就每 5 秒重試，期間玩家連不進來，但資料絕對不會被空白覆蓋
async function start() {
  for (let i = 1; !(await loadFromCloud()); i++) {
    console.error(`雲端資料讀取失敗（第 ${i} 次），5 秒後重試…（請檢查 SUPABASE_HOST／SUPABASE_KEY 與網路）`)
    await new Promise((r) => setTimeout(r, 5000))
  }
  server.listen(PORT, '0.0.0.0', () => console.log(`問道長生 ORPG 已啟動：http://localhost:${PORT}`))
}
start()