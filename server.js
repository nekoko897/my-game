/* 問道長生 · ORPG 伺服器（零依賴，只需 Node 16+）
 * 啟動：node server.js   → 開啟 http://localhost:3000
 * 資料存於 data.json。
 */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto')
const PORT = process.env.PORT || 3000
const DB_FILE = path.join(__dirname, 'data.json')
const MAX_HP = 260

let db = { players: {}, nextId: 1, auctions: [] }
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))) } catch (e) {}
let dirty = false
const persist = () => { if (!dirty) return; dirty = false; try { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE) } catch (e) { console.error('存檔失敗', e.message) } }
setInterval(persist, 5000)
process.on('SIGINT', () => { dirty = true; persist(); process.exit(0) })

const sessions = new Map()   // token -> name key
const clients = new Map()    // token -> { res, key }
const chatHistory = []
const lastAct = {}           // rate limit: key+action -> ts
const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a
const now = () => Date.now()
const limited = (key, act, ms) => { const k = key + act, t = now(); if (lastAct[k] && t - lastAct[k] < ms) return true; lastAct[k] = t; return false }

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
  if (msg.to) { sendTo(msg.toKey, 'chat', stripKeys(msg)); sendTo(msg.fromKey, 'chat', stripKeys(msg)) } else broadcast('chat', stripKeys(msg))
}
const stripKeys = (m) => ({ t: m.t, from: m.from, to: m.to, text: m.text, sys: m.sys })
function sysChat(text) { const m = { from: '天道', text, sys: true, t: now() }; chatHistory.push(m); if (chatHistory.length > 60) chatHistory.shift(); broadcast('chat', m) }
function mail(key, m) {
  const p = db.players[key]; if (!p) return
  m.id = db.nextId++; p.mail = p.mail || []; p.mail.push(m); dirty = true
  sendTo(key, 'mail', { mail: [m] })
}
const nameOf = (k) => (db.players[k] || {}).name || k
const pubAuctions = () => db.auctions.map((a) => ({ id: a.id, seller: nameOf(a.seller), item: a.item, qty: a.qty, start: a.start, current: a.current, bidder: a.bidder ? nameOf(a.bidder) : null, inc: a.inc, endsAt: a.endsAt }))
const pubBoss = () => ({ name: boss.name, maxHp: boss.maxHp, hp: boss.hp, alive: boss.alive, respawnAt: boss.respawnAt, top: topDamage(5) })

/* ---------- 世界 Boss ---------- */
const boss = { name: '九幽魔蛟', maxHp: 30000, hp: 30000, alive: true, respawnAt: 0, damage: {}, lastHit: null }
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
  if (top) { const key = Object.keys(db.players).find((k) => db.players[k].name === top.name); if (key) mail(key, { kind: 'item', item: 'jadeSlip', qty: 1, text: '你是傷害第一，獲得破損玉簡。' }) }
  sysChat(`「${boss.name}」被眾修士合力擊殺！最後一擊：${(db.players[boss.lastHit] || {}).name || '?'}，傷害第一：${top ? top.name : '?'}。`)
  broadcast('boss', pubBoss())
}
setInterval(() => {
  if (!boss.alive && now() >= boss.respawnAt) { Object.assign(boss, { hp: boss.maxHp, alive: true, damage: {}, lastHit: null, respawnAt: 0 }); sysChat(`「${boss.name}」再次現世，速往魔蛟頁籤討伐！`); broadcast('boss', pubBoss()) }
}, 1000)

/* ---------- 拍賣 ---------- */
setInterval(() => {
  const t = now(); let changed = false
  db.auctions = db.auctions.filter((a) => {
    if (a.endsAt > t) return true
    changed = true; dirty = true
    if (a.bidder) {
      mail(a.seller, { kind: 'stones', amount: a.current, text: `你上架的物品被「${(db.players[a.bidder] || {}).name}」以 ${a.current} 靈石標走。` })
      mail(a.bidder, { kind: 'item', item: a.item, qty: a.qty, text: `你以 ${a.current} 靈石標得拍賣品。` })
    } else mail(a.seller, { kind: 'item', item: a.item, qty: a.qty, text: '你上架的物品流拍，已退回。' })
    return false
  })
  if (changed) broadcast('auctions', pubAuctions())
}, 1000)

/* ---------- 全服拍賣 NPC 隨機競標（降低頻率）---------- */
setInterval(() => {
  const t = now();
  db.auctions.forEach(a => {
    // 確保拍賣還在進行中、且目前最高價不是玩家、且隨機機率調低（例如原本 0.05 改為 0.01 降低頻率）
    if (a.endsAt > t && !a.bidder && Math.random() < 0.01) {
      const npcNames = ['天機子', '素衣仙子', '赤霄道人', '青鸞上仙'];
      const randomNpc = npcNames[Math.floor(Math.random() * npcNames.length)];
      // 隨機以 10% 或 30% 加價
      const rate = Math.random() < 0.7 ? 0.1 : 0.3;
      const inc = Math.ceil(a.current * rate);
      a.current += inc;
      // 這裡可以用一個虛擬的 key 代表 NPC
      a.bidder = 'npc_' + randomNpc; 
      dirty = true;
      broadcast('auctions', pubAuctions());
    }
  });
}, 5000); // 每 5 秒檢查一次，且機率降低，大幅減少 NPC 出價頻率

/* ---------- PvP ---------- */
function duel(a, b) {
  let ha = MAX_HP + (a.realm || 0) * 40, hb = MAX_HP + (b.realm || 0) * 40
  const ra = atkRange(a), rb = atkRange(b)
  for (let i = 0; i < 40; i++) {
    hb -= rnd(ra[0], ra[1]); if (hb <= 0) return true
    ha -= rnd(rb[0], rb[1]); if (ha <= 0) return false
  }
  return ha / (MAX_HP + (a.realm || 0) * 40) >= hb / (MAX_HP + (b.realm || 0) * 40)
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
  for (const [k, v] of Object.entries(s.inventory || {})) if (/^[A-Za-z]{1,24}$/.test(k)) inv[k] = num(v, 0, 99999)
  return {
    realm: num(s.realm, 0, 6), layer: num(s.layer, 1, 9), xp: num(s.xp, 0, 1e9), hp: num(s.hp, 0, 1e5), mp: num(s.mp, 0, 1e5),
    stones: num(s.stones, 0, 1e12), jade: num(s.jade, 0, 1e9), inventory: inv,
    sect: String(s.sect || 'qingyun').slice(0, 16), contribution: num(s.contribution, 0, 1e9),
  }
}

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
    send(res, 'hello', { serverTime: now(), online: presence(), auctions: pubAuctions(), boss: pubBoss(), chat: chatHistory.filter((m) => !m.to || m.fromKey === key || m.toKey === key).map(stripKeys) })
    if (!wasOnline) { broadcast('presence', presence()); sysChat(`「${db.players[key].name}」進入了修仙界。`) }
    const hb = setInterval(() => res.write(': hb\n\n'), 20000)
    req.on('close', () => {
      clearInterval(hb); clients.delete(cid)
      if (!onlineKeys().includes(key)) { broadcast('presence', presence()); sysChat(`「${db.players[key].name}」離開了修仙界。`) }
    })
    return
  }

  if (req.method === 'POST' && p.startsWith('/api/')) {
    const b = await body(req)
    if (p === '/api/login') {
      if (limited(req.socket.remoteAddress || '', 'login', 500)) return json(res, 429, { error: '操作太頻繁' })
      const name = cleanName(b.name), pw = String(b.password || '')
      if (name.length < 2) return json(res, 400, { error: '道號需 2–12 字' })
      if (pw.length < 4) return json(res, 400, { error: '密碼至少 4 字元' })
      const key = name.toLowerCase()
      let pl = db.players[key], created = false
      if (!pl) {
        const salt = crypto.randomBytes(16).toString('hex')
        pl = db.players[key] = { name, salt, hash: hashPw(pw, salt), save: null, mail: [], created: now() }; created = true; dirty = true
      } else if (hashPw(pw, pl.salt) !== pl.hash) return json(res, 403, { error: '密碼錯誤' })
      const token = crypto.randomBytes(24).toString('hex'); sessions.set(token, key)
      return json(res, 200, { token, name: pl.name, created, save: pl.save, mail: pl.mail || [] })
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
    if (p === '/api/chat') {
      const text = String(b.text || '').trim().slice(0, 100)
      if (!text) return json(res, 400, { error: '訊息為空' })
      if (limited(key, 'chat', 1000)) return json(res, 429, { error: '說話太快了' })
      if (b.to) {
        const tk = String(b.to).toLowerCase()
        if (!db.players[tk] || !onlineKeys().includes(tk)) return json(res, 404, { error: '對方不在線上' })
        chat({ from: pl.name, fromKey: key, to: db.players[tk].name, toKey: tk, text })
      } else chat({ from: pl.name, fromKey: key, text })
      return json(res, 200, { ok: true })
    }
    if (p === '/api/auction/list') {
      const item = String(b.item || ''), price = num(b.price, 1, 1e7)
      if (!/^[A-Za-z]{1,24}$/.test(item) || price < 1) return json(res, 400, { error: '參數錯誤' })
      if (db.auctions.filter((a) => a.seller === key).length >= 5) return json(res, 400, { error: '最多同時上架 5 件' })
      const a = { id: 'a' + db.nextId++, seller: key, item, qty: 1, start: price, current: price, bidder: null, inc: Math.max(3, Math.round(price * 0.1)), endsAt: now() + 180000 }
      db.auctions.push(a); dirty = true
      broadcast('auctions', pubAuctions())
      return json(res, 200, { ok: true })
    }
    if (p === '/api/auction/bid') {
      const a = db.auctions.find((x) => x.id === b.id)
      if (!a || a.endsAt <= now()) return json(res, 404, { error: '拍賣已結束' })
      if (a.seller === key) return json(res, 400, { error: '不能競標自己的物品' })
      if (a.bidder === key) return json(res, 400, { error: '你已是最高出價者' })
      
      // 支援前端傳入指定的競標金額，若無則預設為原本邏輯
      const basePrice = a.bidder ? a.current : a.start;
      const amount = b.amount ? num(b.amount, basePrice + 1, 1e12) : (a.bidder ? a.current + a.inc : a.start);

      if (amount <= basePrice) return json(res, 400, { error: '出價必須高於目前底價' })
      if (limited(key, 'bid', 400)) return json(res, 429, { error: '操作太快' })
      
      if (a.bidder) mail(a.bidder, { kind: 'stones', amount: a.current, text: `你在拍賣中被超越，退還 ${a.current} 靈石。` })
      a.current = amount; a.bidder = key; 
      // 剩餘時間少於 15 秒（15000ms）時，有人出價自動延長 15 秒防搶標（可選）
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
      sysChat(`「${pl.name}」向「${tp.name}」發起切磋，勝者：${db.players[winner].name}${loot > 0 ? `（奪得 ${loot} 靈石）` : ''}。`)
      return json(res, 200, { ok: true, win, loot })
    }
    if (p === '/api/boss/attack') {
      if (!boss.alive) return json(res, 400, { error: '魔蛟尚未現世' })
      if (limited(key, 'boss', 1800)) return json(res, 429, { error: '出手太快' })
      const s = pl.save || {}, r = atkRange(s), dmg = rnd(r[0], r[1]) * 3
      boss.hp = Math.max(0, boss.hp - dmg); boss.damage[key] = (boss.damage[key] || 0) + dmg; boss.lastHit = key
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
server.listen(PORT, () => console.log(`問道長生 ORPG 已啟動：http://localhost:${PORT}`))
