/* 問道長生 · ORPG 伺服器（零依賴，只需 Node 16+）
 * 啟動：node server.js   → 開啟 http://localhost:3000
 * 資料存於 Supabase 雲端資料庫（使用內建 https 模組）。
 */
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), crypto = require('crypto')
const PORT = process.env.PORT || 3000
// 氣血／靈力上限隨修為成長（須與 index.html 的 hpAt／mpAt 公式一致）
const BASE_HP = 260, BASE_MP = 120, HP_PER_LV = 20, MP_PER_LV = 4
const lvIdx = (s) => (s.realm || 0) * 9 + (s.layer || 1) - 1
// 根骨屬性丹：每點 +1% 氣血上限（最多 30 點），點數存在背包欄位 zqstatroot（須與 index.html 的 STAT_META／STAT_CAP 一致）
const rootPts = (s) => Math.min(30, Math.max(0, Number(((s && s.inventory) || {}).zqstatroot) || 0))
// 已穿戴裝備提供的氣血上限%：背包欄位 zqeqp + 裝備 id（須與 index.html 的 EQUIP_KEY／ITEMS.equip 一致）；每個部位只計一件
let ITEM_DEFS = {}
const gearHpPct = (s) => {
  let sum = 0; const slots = new Set()
  for (const [k, v] of Object.entries((s && s.inventory) || {})) {
    if (!k.startsWith('zqeqp') || !(Number(v) > 0)) continue
    const e = (ITEM_DEFS[k.slice(5)] || {}).equip
    if (!e || slots.has(e.slot)) continue
    slots.add(e.slot)
    sum += (e.bonuses || []).filter((b) => b.type === 'hp').reduce((a, b) => a + (Number(b.value) || 0), 0)
  }
  return sum
}
const hpOf = (s) => Math.round((BASE_HP + lvIdx(s) * HP_PER_LV) * (1 + rootPts(s) * 0.01 + gearHpPct(s)))
const mpOf = (s) => BASE_MP + lvIdx(s) * MP_PER_LV

// ===== GM 帳號 =====
// GM 道號（小寫比對）與密碼。強烈建議在部署環境用環境變數 GM_PASSWORD 設定密碼，不要把真密碼寫進程式碼。
// 一般玩家無法註冊或登入 GM 道號；只有密碼正確才會被視為 GM。
const GM_NAMES = ['gm']
const GM_PASSWORD = process.env.GM_PASSWORD || ''
const isGMKey = (k) => GM_NAMES.includes(k)

// ===== Supabase 雲端資料庫設定 =====
const SUPABASE_HOST = 'iedoalfukazgzzpbgdzu.supabase.co'
const SUPABASE_KEY = 'sb_publishable_AzWFfTrZKE4UDBUPfICxHg_xlcsPvz7'

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
        'Authorization': `Bearer ${SUPABASE_KEY}`,
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
async function loadFromCloud() {
  try {
    const result = await supabaseRequest('GET', '/rest/v1/game_store?id=eq.main_db&select=data')
    if (result.status >= 200 && result.status < 300) {
      const rows = result.data
      if (rows && rows.length > 0 && rows[0].data && Object.keys(rows[0].data).length > 0) {
        db = Object.assign(db, rows[0].data)
        console.log('成功從雲端載入遊戲資料！')
      } else {
        console.log('雲端目前資料為空，使用初始空資料')
      }
    } else {
      console.error('從雲端載入失敗，HTTP 狀態碼：', result.status, result.data)
    }
  } catch (e) {
    console.error('從雲端載入發生例外錯誤：', e.message)
  }
}

// 寫入資料到 Supabase 雲端
let dirty = false
const persist = () => { dirty = true }
async function persistToCloud() {
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
process.on('SIGINT', async () => { 
  dirty = true
  await persistToCloud()
  process.exit(0) 
})

const sessions = new Map()   // token -> name key
const clients = new Map()    // token -> { res, key }
const chatHistory = []
const lastAct = {}           // rate limit: key+action -> ts
const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a
const now = () => Date.now()
const limited = (key, act, ms) => { const k = key + act, t = now(); if (lastAct[k] && t - lastAct[k] < ms) return true; lastAct[k] = t; return false }

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
function mail(key, m) {
  const p = db.players[key]; if (!p) return
  m.id = db.nextId++; p.mail = p.mail || []; p.mail.push(m); dirty = true
  sendTo(key, 'mail', { mail: [m] })
}
const NPC_PREFIX = 'npc_'
const isNpc = (k) => typeof k === 'string' && k.startsWith(NPC_PREFIX)
const nameOf = (k) => (db.players[k] || {}).name || (isNpc(k) ? k.slice(NPC_PREFIX.length) : k)
const pubAuctions = () => db.auctions.map((a) => ({ id: a.id, seller: nameOf(a.seller), item: a.item, qty: a.qty, start: a.start, current: a.current, bidder: a.bidder ? nameOf(a.bidder) : null, inc: a.inc, endsAt: a.endsAt }))
const pubBoss = () => ({ name: boss.name, maxHp: boss.maxHp, hp: boss.hp, alive: boss.alive, respawnAt: boss.respawnAt, top: topDamage(5) })

/* ---------- 世界 Boss ---------- */
const boss = { name: '九幽魔蛟', maxHp: 50000, hp: 50000, alive: true, respawnAt: 0, damage: {}, lastHit: null }
// 世界王掉落由伺服器判定（客戶端不再自己擲）：每次出手各擲一次，境界須達 BOSS_LOOT_MIN_REALM（0 煉氣…3 元嬰）才有機會
// 須與 index.html 的 BOSS_PET_LOOT／BOSS_LOOT_MIN_REALM 一致（那邊只用來顯示說明文字）
const BOSS_LOOT_MIN_REALM = 3
const BOSS_PET_LOOT = [{ item: 'divineEgg', chance: 0.001 }, { item: 'divineFeed', chance: 0.005 }, { item: 'wuxingDan', chance: 0.0005 }]
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
 * 物品清單直接從 index.html 的 ITEMS 讀取（交易所販售的 SHOP_ITEMS 除外），之後在 index.html 新增道具會自動納入。
 * 調整頻率改 NPC_LIST_MIN／NPC_LIST_MAX（秒）；調整稀有度機率改 NPC_RARITY_WEIGHT。 */
const NPC_NAMES = ['天機子', '素衣仙子', '赤霄道人', '青鸞上仙']
const NPC_LIST_MIN = 60, NPC_LIST_MAX = 300
const NPC_RARITY_WEIGHT = { '普通': 60, '精良': 25, '稀有': 10, '史詩': 3 }   // 相對權重：越高級越低
const NPC_RARITY_QTY = { '普通': [1, 6], '精良': [1, 4], '稀有': [1, 2], '史詩': [1, 1] }  // 上架數量範圍
const NPC_MAX_LISTINGS = 6                                                      // NPC 同時上架的上限
let NPC_POOL = []
function loadNpcPool() {
  try {
    const src = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
    const start = src.indexOf('const ITEMS = {')
    if (start < 0) throw new Error('找不到 ITEMS')
    // 逐字掃描找出 ITEMS 物件結尾的大括號（略過字串內容）
    let i = src.indexOf('{', start), depth = 0, quote = null, end = -1
    for (; i < src.length; i++) {
      const c = src[i]
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue }
      if (c === "'" || c === '"' || c === '`') { quote = c; continue }
      if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue }
      if (c === '{') depth++
      else if (c === '}' && --depth === 0) { end = i; break }
    }
    if (end < 0) throw new Error('ITEMS 結尾不明')
    const items = require('vm').runInNewContext('(' + src.slice(src.indexOf('{', start), end + 1) + ')')
    ITEM_DEFS = items   // 裝備加成（氣血上限）計算也要用
    const shop = (/const SHOP_ITEMS = \[([^\]]*)\]/.exec(src) || [, ''])[1].match(/[A-Za-z]+/g) || []
    NPC_POOL = Object.entries(items)
      .filter(([id, d]) => /^[A-Za-z]{1,24}$/.test(id) && !shop.includes(id) && NPC_RARITY_WEIGHT[d.rarity] && d.sell > 0)
      .map(([id, d]) => ({ id, name: d.name || id, icon: d.icon || '', rarity: d.rarity, sell: d.sell, w: NPC_RARITY_WEIGHT[d.rarity] }))
    // 以「稀有度」為單位分配機率（普通約 60%、史詩約 3%…），同稀有度內平均分配，不受該稀有度道具種類多寡影響
    const cnt = {}; NPC_POOL.forEach((x) => { cnt[x.rarity] = (cnt[x.rarity] || 0) + 1 })
    NPC_POOL.forEach((x) => { x.w = NPC_RARITY_WEIGHT[x.rarity] / cnt[x.rarity] })
    console.log(`拍賣 NPC 物品池：${NPC_POOL.length} 種`)
  } catch (e) { console.error('載入 NPC 拍賣物品池失敗，NPC 不會上架：', e.message) }
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
  let ha = hpOf(a), hb = hpOf(b)
  const ra = atkRange(a), rb = atkRange(b)
  for (let i = 0; i < 40; i++) {
    hb -= rnd(ra[0], ra[1]); if (hb <= 0) return true
    ha -= rnd(rb[0], rb[1]); if (ha <= 0) return false
  }
  return ha / hpOf(a) >= hb / hpOf(b)
}

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
function body(req) {
  return new Promise((resolve) => {
    let s = ''; req.on('data', (c) => { s += c; if (s.length > 30000) { req.destroy(); resolve({}) } })
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')) } catch (e) { resolve({}) } })
  })
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }
const cleanName = (n) => String(n || '').trim().replace(/[<>&"'\s]/g, '').slice(0, 12)
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(v) || 0)))

function sanitizeSave(s) {
  if (!s || typeof s !== 'object') return null
  const inv = {}
  for (const [k, v] of Object.entries(s.inventory || {})) if (/^[A-Za-z]{1,24}$/.test(k)) inv[k] = num(v, 0, k.startsWith('zqqcd') ? 1e9 : 99999)   // zqqcd = 宗門任務冷卻（解除時間，分鐘），數值較大
  const realm = num(s.realm, 0, 6), layer = num(s.layer, 1, 9), cap = { realm, layer, inventory: inv }
  return {
    realm, layer, xp: num(s.xp, 0, 1e9), hp: num(s.hp, 0, hpOf(cap)), mp: num(s.mp, 0, mpOf(cap)),
    stones: num(s.stones, 0, 1e12), jade: num(s.jade, 0, 1e9), inventory: inv,
    sect: String(s.sect || '').slice(0, 16), contribution: num(s.contribution, 0, 1e9),
  }
}

/* ---------- 地圖與即時戰鬥 ----------
 * 地圖資料以伺服器為準（MAPS），進入時傳給客戶端。座標單位為「格」（浮點數）。
 * 圖例：. 草地  = 道路  # 樹/圍牆（不可走）  ~ 水（不可走）  B 建築（不可走）  R 岩石（不可走）
 * 主城（town）是安全區；每個秘境（LOCATIONS）各有一張野外地圖，妖獸由伺服器生成、移動、攻擊。
 * 玩家氣血由客戶端自己維護（與既有存檔一致）；伺服器負責：妖獸氣血/位置/AI、玩家攻擊距離與冷卻、
 * 基礎傷害（依存檔境界）、功法倍率與冷卻（依 index.html 的 SKILLS）、掉落與修為結算。 */
const MOVE_SPEED = 5.5, MOVE_R = 0.3
const TOWN_NPCS = [
  { id: 'market', name: '交易所掌櫃', x: 14.5, y: 8.5, panel: 'market', color: '#c9a24a' },
  { id: 'auction', name: '拍賣官', x: 25.5, y: 8.5, panel: 'auction', color: '#b35a3c' },
  { id: 'sect', name: '宗門長老', x: 20.5, y: 5.5, panel: 'sect', color: '#4a7fb5' },
  { id: 'realm', name: '秘境引路人', x: 8.5, y: 15.5, panel: 'realm', color: '#6a4ab5' },
  { id: 'boss', name: '鎮魔使', x: 32.5, y: 15.5, panel: 'boss', color: '#a33' },
  { id: 'pets', name: '靈寵司', x: 14.5, y: 21.5, panel: 'pets', color: '#3a9a6a' },
  { id: 'world', name: '傳訊童子', x: 25.5, y: 21.5, panel: 'world', color: '#5aa5b5' },
]
const TOWN_SPAWN = { x: 20.5, y: 13.5 }
const mkTownRows = () => {
  const W = 40, H = 28
  const g = Array.from({ length: H }, () => Array(W).fill('.'))
  const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (g[y] && g[y][x] !== undefined) g[y][x] = c }
  for (let x = 0; x < W; x++) { g[0][x] = '#'; g[H - 1][x] = '#' }
  for (let y = 0; y < H; y++) { g[y][0] = '#'; g[y][W - 1] = '#' }
  rect(3, 12, 36, 14, '='); rect(19, 2, 21, 25, '='); rect(12, 6, 27, 7, '=')
  rect(8, 14, 9, 16, '='); rect(32, 14, 33, 16, '='); rect(12, 14, 15, 21, '='); rect(24, 14, 27, 21, '='); rect(12, 21, 27, 22, '=')
  rect(12, 2, 17, 5, 'B'); rect(23, 2, 28, 5, 'B'); rect(17, 1, 22, 3, 'B')
  rect(4, 17, 10, 20, 'B'); rect(30, 17, 36, 20, 'B'); rect(11, 23, 16, 26, 'B'); rect(23, 23, 28, 26, 'B')
  rect(30, 3, 36, 8, '~'); rect(32, 4, 35, 7, '~')
  for (const [x, y] of [[3,3],[4,5],[6,3],[7,8],[2,9],[5,10],[3,22],[5,24],[7,22],[33,23],[35,25],[31,22],[36,10],[2,16],[37,16],[16,10],[24,10]]) g[y][x] = '#'
  for (const n of TOWN_NPCS) { const tx = Math.floor(n.x), ty = Math.floor(n.y); if (g[ty][tx] !== '=') g[ty][tx] = '.' }
  g[Math.floor(TOWN_SPAWN.y)][Math.floor(TOWN_SPAWN.x)] = '='
  return g.map((r) => r.join(''))
}
const MAPS = {}
MAPS.town = { id: 'town', name: '主城', rows: mkTownRows(), npcs: TOWN_NPCS, spawn: TOWN_SPAWN, theme: { g1: '#3f6b3a', g2: '#447443' } }

/* 從 index.html 取出秘境（LOCATIONS，已含成長換算與掉落表）與功法（SKILLS），讓客戶端與伺服器用同一份資料 */
let LOCS = [], SKILL_DEFS = {}
function loadGameData() {
  try {
    const src = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
    const line = (re) => { const m = re.exec(src); if (!m) throw new Error('找不到 ' + re); return m[0] }
    const prelude = [line(/const MAX_LAYER = [^\n]+/), line(/const BASE_HP = [^\n]+/), line(/const lvIdx = [^\n]+/), line(/const hpAt = [^\n]+/)].join('\n') + '\n'
    const a = src.indexOf('const LOCATIONS = ['), mk = 'LOCATIONS.forEach((loc) => loc.monsters.forEach((m) => m.loot.push('
    const b0 = src.indexOf(mk); if (a < 0 || b0 < 0) throw new Error('找不到 LOCATIONS')
    LOCS = require('vm').runInNewContext(prelude + src.slice(a, src.indexOf('\n', b0)) + '\n;LOCATIONS')
    const sa = src.indexOf('const fxDmg ='), ss = src.indexOf('const SKILLS = ['), lines = src.slice(ss).split('\n')
    const endRel = lines.findIndex((l, i) => i > 0 && /^\s*\]\s*$/.test(l))
    const skillSrc = src.slice(sa, ss) + lines.slice(0, endRel + 1).join('\n')
    const skills = require('vm').runInNewContext(skillSrc + '\n;SKILLS')
    skills.forEach((k) => { const d = (k.effects || []).find((e) => e.t === 'dmg'); if (d) SKILL_DEFS[k.id] = { mult: d.mult, cd: k.cooldown, req: k.req || 0 } })
    LOCS.forEach((loc, idx) => { MAPS[loc.id] = genField(loc, idx) })
    console.log(`野外地圖：${LOCS.length} 張，攻伐功法：${Object.keys(SKILL_DEFS).length} 種`)
  } catch (e) { console.log('野外資料載入失敗（即時戰鬥停用）：', e.message) }
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
const mapInfo = (m) => ({ id: m.id, name: m.name, w: m.rows[0].length, h: m.rows.length, rows: m.rows, npcs: m.npcs, speed: MOVE_SPEED, r: MOVE_R, theme: m.theme, types: m.types || null })
const tileBlocked = (m, x, y) => {
  const tx = Math.floor(x), ty = Math.floor(y)
  if (tx < 0 || ty < 0 || ty >= m.rows.length || tx >= m.rows[0].length) return true
  return '#~BR'.includes(m.rows[ty][tx])
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
  const lm = Math.min(1.6, Math.max(1, (entries.find(([k]) => k === top)[1].lm) || 1))
  const loot = []
  for (const e of def.loot) if (Math.random() < e.chance * lm && ITEM_DEFS && ITEM_DEFS[e.item]) loot.push({ item: e.item, qty: rint(e.min, e.max) })
  for (const [k] of entries) sendTo(k, 'kill', { id: def.id, name: def.name, icon: def.icon, exp: def.exp, loot: k === top ? loot : [] })
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
        if (d < 1.25 && m.cd <= 0) { m.cd = 1.5 + Math.random() * 0.4; sendTo(tgt[0], 'hit', { mi: m.i, name: def.name, icon: def.icon, dmg: rint(def.atkMin, def.atkMax) }) }
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


const server = http.createServer(async (req, res) => {
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
      if (limited(req.socket.remoteAddress || '', 'login', 500)) return json(res, 429, { error: '操作太頻繁' })
      const name = cleanName(b.name), pw = String(b.password || '')
      if (name.toLowerCase().startsWith(NPC_PREFIX)) return json(res, 400, { error: '道號不可使用此前綴' })
      if (name.length < 2) return json(res, 400, { error: '道號需 2–12 字' })
      if (pw.length < 4) return json(res, 400, { error: '密碼至少 4 字元' })
      const key = name.toLowerCase()
      let pl = db.players[key], created = false
      if (isGMKey(key)) {
        if (!GM_PASSWORD) return json(res, 403, { error: '伺服器尚未設定 GM_PASSWORD，GM 帳號停用' })
        if (pw !== GM_PASSWORD) return json(res, 403, { error: '密碼錯誤' })
        if (!pl) { const salt = crypto.randomBytes(16).toString('hex'); pl = db.players[key] = { name, salt, hash: hashPw(pw, salt), save: null, mail: [], created: now() }; created = true; dirty = true }
      } else if (!pl) {
        const salt = crypto.randomBytes(16).toString('hex')
        pl = db.players[key] = { name, salt, hash: hashPw(pw, salt), save: null, mail: [], created: now() }; created = true; dirty = true
      } else if (hashPw(pw, pl.salt) !== pl.hash) return json(res, 403, { error: '密碼錯誤' })
      const token = crypto.randomBytes(24).toString('hex'); sessions.set(token, key)
      return json(res, 200, { token, name: pl.name, created, gm: isGMKey(key), save: pl.save, mail: pl.mail || [] })
    }
    const key = sessions.get(b.token)
    if (!key) return json(res, 401, { error: '登入已失效，請重新登入' })
    const pl = db.players[key]

    if (p === '/api/save') {
      const s = sanitizeSave(b.save); if (!s) return json(res, 400, { error: '資料無效' })
      const old = pl.save || {}; pl.save = s; dirty = true
      if (old.realm !== s.realm || old.layer !== s.layer || old.sect !== s.sect) broadcast('presence', presence())
      return json(res, 200, { ok: true })
    }
    if (p === '/api/mail/ack') {
      const ids = new Set((b.ids || []).map(Number)); pl.mail = (pl.mail || []).filter((m) => !ids.has(m.id)); dirty = true
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
      if (map.loc && ((pl.save || {}).realm || 0) < map.loc.reqRealm) return json(res, 403, { error: '境界不足，無法進入' })
      const me = ensurePos(key)
      me.m = id; me.x = map.spawn.x; me.y = map.spawn.y; me.t = Date.now(); me.f = 'd'; posDirty = true
      return json(res, 200, { ok: true, map: mapInfo(map), x: me.x, y: me.y })
    }
    if (p === '/api/attack') {   // 即時攻擊：自動鎖定射程內最近的妖獸
      const me = positions.get(key), map = me && MAPS[me.m]
      if (!map || !map.loc || !fields[me.m]) return json(res, 200, { ok: false, miss: true })
      const sk = b.skill ? SKILL_DEFS[String(b.skill)] : null
      if (b.skill && !sk) return json(res, 400, { error: '功法無效' })
      const s = (pl.save || {}), realm = s.realm || 0, layer = s.layer || 1
      if (sk && sk.req > realm) return json(res, 403, { error: '境界不足以施展此功法' })
      if (limited(key, 'atk', 450)) return json(res, 200, { ok: false, cd: true })
      if (sk && limited(key, 'sk' + b.skill, Math.max(500, sk.cd * 1000 * 0.9))) return json(res, 200, { ok: false, cd: true })
      const range = sk ? 4.5 : 2.0
      let tm = null, bd = range
      for (const m of fields[me.m].mons) { if (m.st === 2) continue; const d = Math.hypot(m.x - me.x, m.y - me.y); if (d < bd) { bd = d; tm = m } }
      if (!tm) return json(res, 200, { ok: false, miss: true })
      const base = 8 + realm * 10 + layer * 2, bonus = Math.min(1.5, Math.max(0, Number(b.bonus) || 0)), lm = Math.min(1.6, Math.max(1, Number(b.lm) || 1))
      const pet = Math.min(base * 1.5, Math.max(0, Math.round(Number(b.pet) || 0)))
      const dmg = Math.max(1, Math.round(rint(Math.round(base * 0.7), Math.round(base * 1.3)) * (sk ? sk.mult : 1) * (1 + bonus))) + pet
      tm.hp -= dmg; tm.tg = key; tm.st = 1
      const rec = tm.dmg[key] || (tm.dmg[key] = { d: 0, lm }); rec.d += dmg; rec.lm = lm
      const def = map.loc.monsters[tm.t], hpLeft = Math.max(0, Math.ceil(tm.hp))
      if (tm.hp <= 0) killMon(map, fields[me.m], tm)
      return json(res, 200, { ok: true, mi: tm.i, dmg, hp: hpLeft, mx: tm.x, my: tm.y, name: def.name })
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
      // 以伺服器記錄的背包（Supabase 存檔）驗證持有數量，並先在伺服器端扣除
      const inv = (pl.save && pl.save.inventory) || {}
      if ((inv[item] || 0) < qty) return json(res, 400, { error: '背包中的物品數量不足' })
      inv[item] -= qty
      if (inv[item] <= 0) delete inv[item]
      pl.save.inventory = inv
      const a = { id: 'a' + db.nextId++, seller: key, item, qty, start: price, current: price, bidder: null, inc: Math.max(3, Math.round(price * 0.1)), endsAt: now() + 180000 }
      db.auctions.push(a); dirty = true
      broadcast('auctions', pubAuctions())
      return json(res, 200, { ok: true })
    }
    if (p === '/api/auction/bid') {
      const a = db.auctions.find((x) => x.id === b.id)
      if (!a || a.endsAt <= now()) return json(res, 404, { error: '拍賣已結束' })
      if (a.seller === key) return json(res, 400, { error: '不能競標自己的物品' })
      if (a.bidder === key) return json(res, 400, { error: '你已是最高出價者' })
      
      const basePrice = a.bidder ? a.current : a.start;
      const amount = b.amount ? num(b.amount, basePrice + 1, 1e12) : (a.bidder ? a.current + a.inc : a.start);

      if (amount <= basePrice) return json(res, 400, { error: '出價必須高於目前底價' })
      if (limited(key, 'bid', 400)) return json(res, 429, { error: '操作太快' })
      
      if (a.bidder) mail(a.bidder, { kind: 'stones', amount: a.current, text: `你在拍賣中被超越，退還 ${a.current} 靈石。` })
      a.current = amount; a.bidder = key; 
      if (a.endsAt - now() < 15000) a.endsAt += 15000; 
      dirty = true
      
      broadcast('auctions', pubAuctions())
      return json(res, 200, { ok: true, amount })
    }
    if (p === '/api/pvp') {
      const tk = String(b.target || '').toLowerCase(), tp = db.players[tk]
      if (!tp || tk === key || !onlineKeys().includes(tk)) return json(res, 400, { error: '對手不在線上' })
      if (limited(key, 'pvp', 30000)) return json(res, 429, { error: '切磋冷卻中（30 秒）' })
      const a = pl.save, c = tp.save
      if (!a || !c) return json(res, 400, { error: '對手尚未初始化' })
      const win = duel(a, c), winner = win ? key : tk, loser = win ? tk : key
      const loot = Math.min(300, Math.floor(((db.players[loser].save || {}).stones || 0) * 0.05))
      if (loot > 0) {
        mail(winner, { kind: 'stones', amount: loot, text: `切磋勝出，奪得 ${loot} 靈石。` })
        mail(loser, { kind: 'stones', amount: -loot, text: `切磋落敗，損失 ${loot} 靈石。` })
      }
      sysChat(`👤「${pl.name}」向「${tp.name}」發起切磋，勝者：${db.players[winner].name}${loot > 0 ? `（奪得 ${loot} 靈石）` : ''}。`)
      return json(res, 200, { ok: true, win, loot })
    }
    if (p === '/api/boss/attack') {
      if (!boss.alive) return json(res, 400, { error: '魔蛟尚未現世' })
      if (limited(key, 'boss', 1800)) return json(res, 429, { error: '出手太快' })
      const s = pl.save || {}, r = atkRange(s)
      // 攻伐功法出手時，客戶端帶上傷害倍率（神識加成後最高約 7.3，上限 8，防止亂報）
      const mult = Math.max(1, Math.min(8, Number(b.mult) || 1)), dmg = Math.round(rnd(r[0], r[1]) * 3 * mult)
      boss.hp = Math.max(0, boss.hp - dmg); boss.damage[key] = (boss.damage[key] || 0) + dmg; boss.lastHit = key
      if ((s.realm || 0) >= BOSS_LOOT_MIN_REALM) {
        for (const l of BOSS_PET_LOOT) if (Math.random() < l.chance) mail(key, { kind: 'item', item: l.item, qty: 1, text: `魔蛟鱗甲崩落之間，你眼明手快拾得 ${(ITEM_DEFS[l.item] || {}).icon || ''}「${(ITEM_DEFS[l.item] || {}).name || l.item}」！` })
      }
      if (boss.hp <= 0) killBoss(); else broadcast('boss', pubBoss())
      return json(res, 200, { ok: true, dmg })
    }
    return json(res, 404, { error: '未知的請求' })
  }

  // 靜態檔案
  let f = decodeURIComponent(p === '/' ? '/index.html' : p)
  const full = path.join(__dirname, f)
  if (!full.startsWith(__dirname + path.sep) || /(^|[\\/])(data\.json|server\.js)/.test(f)) { res.writeHead(403); return res.end('Forbidden') }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found') }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' }); res.end(buf)
  })
})

// 先從雲端載入資料後，再啟動伺服器
loadFromCloud().then(() => {
  server.listen(PORT, '0.0.0.0', () => console.log(`問道長生 ORPG 已啟動：http://localhost:${PORT}`))
})  