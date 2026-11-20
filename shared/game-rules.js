/* 問道長生 · 共用遊戲規則（前端與伺服器載入同一份）
 *
 * 這個檔案同時被兩邊使用：
 *   - 瀏覽器：index.html 用 <script src="shared/game-rules.js"> 載入，只拿來「顯示」（例如氣血上限、道具說明）
 *   - 伺服器：server.js 用 require('./shared/game-rules.js') 載入，真正「計算並保存」所有結果
 * 要調整數值、新增道具／秘境／宗門，改這個檔案即可，兩邊自動一致（不用再改兩份）。
 * 修改後重新部署伺服器（Render 會自動重新部署），玩家重新整理頁面即可。
 */
(function (root) {
  'use strict'
  // ───── 基礎數值（原 index.html）─────
  const REALMS = ['煉氣', '築基', '金丹', '元嬰', '化神', '渡劫', '大乘']
  const NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九']
  const MAX_LAYER = 9, CULTIVATE_COST = 5
  /* 氣血／靈力上限：隨境界與層數成長（總層數 lv = 境界 × 9 + 層數 − 1，大乘九層時 lv = 62）
   *   氣血上限 = BASE_HP + lv × HP_PER_LV（煉氣一層 260 → 大乘九層 1500）
   *   靈力上限 = BASE_MP + lv × MP_PER_LV（煉氣一層 120 → 大乘九層 368）
   * 伺服器 server.js 有同一組公式，修改時兩邊要一起改。 */
  const BASE_HP = 260, BASE_MP = 120, HP_PER_LV = 20, MP_PER_LV = 4
  const lvIdx = (realm, layer) => realm * MAX_LAYER + layer - 1
  const hpAt = (realm, layer) => BASE_HP + lvIdx(realm, layer) * HP_PER_LV
  const mpAt = (realm, layer) => BASE_MP + lvIdx(realm, layer) * MP_PER_LV

  // ───── 功法（原 index.html）─────
  /* =========================================================
   * 功法系統
   * 功法分三個品階（grade）：
   *   basic     基礎功法：所有人（含散修）都會，永遠可用
   *   sect      宗門功法：拜入某宗門即自動習得，離開／改投後封存（回到原宗門又可使用）
   *   advanced  高階功法：需在「所屬宗門寶庫」用貢獻兌換（shopCost），兌換後永久習得，但只在該宗門門下才能施展
   * 欄位：
   *   id         唯一識別字串，只能是英文字母、最多 19 字（連線存檔會把已習得功法編碼進背包欄位）
   *   name、element（圖示裡的字）、description
   *   grade      品階（見上）
   *   sect       所屬宗門 id（grade 為 sect／advanced 時必填，須對應 SECTS 的 id）
   *   type       attack 攻伐｜heal 回復｜guard 護體｜buff 增益（僅用於顯示分類）
   *   cost       消耗靈力
   *   cooldown   冷卻（息）
   *   req        施展所需境界（REALMS 索引：0=煉氣期即可，1=築基期…）
   *   shopCost   寶庫兌換所需貢獻（grade 為 advanced 時必填）
   *   effects    效果清單，可組合：
   *                fxDmg(倍率)            戰鬥中對妖獸造成「普通攻擊 × 倍率」傷害（含此效果的功法只能在戰鬥中施展）
   *                fxHeal(比例)           回復氣血上限的 比例
   *                fxMp(比例)             回復靈力上限的 比例
   *                fxBuff(屬性, 數值, 息)  限時增益；屬性：atk 攻擊｜def 減傷｜petAtk 靈寵攻擊｜cultivate 修煉速度
   * ========================================================= */
  const SKILL_GRADES = {
    basic: { label: '基礎', color: 'var(--muted-fg)' },
    sect: { label: '宗門', color: 'var(--primary)' },
    advanced: { label: '高階', color: 'var(--destructive)' },
  }
  const SKILL_TYPES = { attack: '攻伐', heal: '回復', guard: '護體', buff: '增益' }
  const fxDmg = (mult) => ({ t: 'dmg', mult })
  const fxHeal = (pct) => ({ t: 'heal', pct })
  const fxMp = (pct) => ({ t: 'mp', pct })
  const fxBuff = (stat, value, sec) => ({ t: 'buff', stat, value, sec })
  const SKILLS = [
    // ── 基礎功法（散修也會） ──
    { id: 'flame', name: '赤焰訣', element: '火', grade: 'basic', type: 'attack', cost: 12, cooldown: 3, req: 0, description: '凝聚丹火，焚盡妖邪', effects: [fxDmg(1.6)] },
    { id: 'wind', name: '御風術', element: '風', grade: 'basic', type: 'guard', cost: 8, cooldown: 2, req: 0, description: '踏風而行，身輕如燕，閃避來襲之力', effects: [fxBuff('def', 0.25, 15)] },
    { id: 'thunder', name: '九霄雷引', element: '雷', grade: 'basic', type: 'attack', cost: 25, cooldown: 6, req: 0, description: '引動天雷，威震八方', effects: [fxDmg(2.6)] },
    { id: 'water', name: '玄水護體', element: '水', grade: 'basic', type: 'heal', cost: 15, cooldown: 5, req: 0, description: '玄水環身，療傷護體，萬法不侵', effects: [fxHeal(0.15), fxBuff('def', 0.3, 10)] },

    // ── 青雲劍宗 ──
    { id: 'qyJian', name: '青雲劍訣', element: '劍', grade: 'sect', sect: 'qingyun', type: 'attack', cost: 14, cooldown: 3, req: 0, description: '宗門入門劍訣，劍氣縱橫三尺', effects: [fxDmg(1.8)] },
    { id: 'qyGang', name: '劍罡訣', element: '罡', grade: 'sect', sect: 'qingyun', type: 'guard', cost: 12, cooldown: 8, req: 0, description: '以劍氣凝成罡罩護身', effects: [fxBuff('def', 0.3, 20)] },
    { id: 'qyWanjian', name: '萬劍歸宗', element: '劍', grade: 'advanced', sect: 'qingyun', type: 'attack', cost: 40, cooldown: 10, req: 1, shopCost: 1500, description: '萬道劍影同出，鎮宗絕學', effects: [fxDmg(3.6)] },
    { id: 'qyFeixian', name: '天外飛仙', element: '仙', grade: 'advanced', sect: 'qingyun', type: 'attack', cost: 70, cooldown: 18, req: 2, shopCost: 3500, description: '人劍合一，一劍破天，劍意加身', effects: [fxDmg(5.6), fxBuff('atk', 0.3, 15)] },

    // ── 玄天道宮 ──
    { id: 'xtTuna', name: '太清吐納', element: '清', grade: 'sect', sect: 'xuantian', type: 'heal', cost: 10, cooldown: 30, req: 0, description: '吐納天地清氣，小耗靈力換取更多回氣', effects: [fxMp(0.12)] },
    { id: 'xtLei', name: '紫霄神雷', element: '雷', grade: 'sect', sect: 'xuantian', type: 'attack', cost: 16, cooldown: 4, req: 0, description: '道門正宗雷法', effects: [fxDmg(2.0)] },
    { id: 'xtZhao', name: '玄天靈罩', element: '罩', grade: 'advanced', sect: 'xuantian', type: 'guard', cost: 45, cooldown: 14, req: 1, shopCost: 1500, description: '道宮護山靈罩縮影，療傷並大幅減傷', effects: [fxHeal(0.4), fxBuff('def', 0.4, 20)] },
    { id: 'xtSanhua', name: '三花聚頂', element: '花', grade: 'advanced', sect: 'xuantian', type: 'buff', cost: 30, cooldown: 25, req: 2, shopCost: 3500, description: '精氣神三花聚頂，回氣並大幅提升攻擊', effects: [fxMp(0.2), fxBuff('atk', 0.6, 30)] },

    // ── 丹鼎谷 ──
    { id: 'ddHui', name: '回春訣', element: '春', grade: 'sect', sect: 'danding', type: 'heal', cost: 14, cooldown: 6, req: 0, description: '丹道生機之術，催動草木精華療傷', effects: [fxHeal(0.25)] },
    { id: 'ddHuo', name: '丹火焚天', element: '火', grade: 'sect', sect: 'danding', type: 'attack', cost: 16, cooldown: 4, req: 0, description: '以煉丹地火焚敵', effects: [fxDmg(1.9)] },
    { id: 'ddHuan', name: '九轉還魂訣', element: '魂', grade: 'advanced', sect: 'danding', type: 'heal', cost: 40, cooldown: 16, req: 1, shopCost: 1500, description: '九轉丹道秘術，氣血靈力同回', effects: [fxHeal(0.6), fxMp(0.15)] },
    { id: 'ddZhen', name: '煉丹真火', element: '爐', grade: 'advanced', sect: 'danding', type: 'attack', cost: 60, cooldown: 14, req: 2, shopCost: 3500, description: '谷主所傳本命真火，焚敵並反哺自身', effects: [fxDmg(4.2), fxHeal(0.1)] },

    // ── 金剛寺 ──
    { id: 'jgShen', name: '金剛護體', element: '金', grade: 'sect', sect: 'jingang', type: 'guard', cost: 12, cooldown: 8, req: 0, description: '運轉金剛不壞神功', effects: [fxBuff('def', 0.35, 20)] },
    { id: 'jgQuan', name: '羅漢拳', element: '拳', grade: 'sect', sect: 'jingang', type: 'attack', cost: 14, cooldown: 3, req: 0, description: '剛猛樸實的佛門拳法', effects: [fxDmg(1.8)] },
    { id: 'jgBu', name: '不動明王身', element: '王', grade: 'advanced', sect: 'jingang', type: 'guard', cost: 45, cooldown: 18, req: 1, shopCost: 1500, description: '心如不動，金身巍然，並回復氣血', effects: [fxBuff('def', 0.5, 25), fxHeal(0.2)] },
    { id: 'jgZhang', name: '大力金剛掌', element: '掌', grade: 'advanced', sect: 'jingang', type: 'attack', cost: 65, cooldown: 14, req: 2, shopCost: 3500, description: '一掌開碑裂石，鎮寺神功', effects: [fxDmg(4.8)] },

    // ── 血煞宗 ──
    { id: 'xsYing', name: '血影斬', element: '血', grade: 'sect', sect: 'xuesha', type: 'attack', cost: 15, cooldown: 3, req: 0, description: '化作血影一斬，飲血回氣', effects: [fxDmg(1.9), fxHeal(0.05)] },
    { id: 'xsKuang', name: '嗜血狂化', element: '狂', grade: 'sect', sect: 'xuesha', type: 'buff', cost: 14, cooldown: 12, req: 0, description: '激發嗜血本能，攻擊大增', effects: [fxBuff('atk', 0.4, 20)] },
    { id: 'xsHai', name: '血海滔天', element: '海', grade: 'advanced', sect: 'xuesha', type: 'attack', cost: 45, cooldown: 10, req: 1, shopCost: 1500, description: '血海翻湧淹沒敵人，吸取其精血', effects: [fxDmg(3.8), fxHeal(0.15)] },
    { id: 'xsGui', name: '萬血歸元', element: '元', grade: 'advanced', sect: 'xuesha', type: 'buff', cost: 70, cooldown: 22, req: 2, shopCost: 3500, description: '萬千血魂歸體，攻擊暴漲並大幅療傷', effects: [fxBuff('atk', 0.8, 25), fxHeal(0.3)] },

    // ── 萬毒門 ──
    { id: 'wdYan', name: '蝕骨毒煙', element: '毒', grade: 'sect', sect: 'wandu', type: 'attack', cost: 14, cooldown: 3, req: 0, description: '釋放蝕骨毒煙', effects: [fxDmg(1.8)] },
    { id: 'wdGu', name: '蠱蟲護身', element: '蠱', grade: 'sect', sect: 'wandu', type: 'guard', cost: 14, cooldown: 10, req: 0, description: '驅蠱蟲環繞周身，兼具攻守', effects: [fxBuff('def', 0.25, 20), fxBuff('atk', 0.15, 20)] },
    { id: 'wdXin', name: '萬蠱噬心', element: '蠱', grade: 'advanced', sect: 'wandu', type: 'attack', cost: 42, cooldown: 10, req: 1, shopCost: 1500, description: '萬蠱齊出噬心奪魄', effects: [fxDmg(3.7)] },
    { id: 'wdBu', name: '百毒不侵身', element: '毒', grade: 'advanced', sect: 'wandu', type: 'guard', cost: 65, cooldown: 22, req: 2, shopCost: 3500, description: '以毒養身，毒功大成，攻守皆強', effects: [fxBuff('def', 0.5, 30), fxBuff('atk', 0.3, 30)] },

    // ── 幽冥殿 ──
    { id: 'ymZhua', name: '幽冥鬼爪', element: '冥', grade: 'sect', sect: 'youming', type: 'attack', cost: 15, cooldown: 3, req: 0, description: '鬼爪撕裂神魂', effects: [fxDmg(1.9)] },
    { id: 'ymShi', name: '噬魂訣', element: '魂', grade: 'sect', sect: 'youming', type: 'heal', cost: 8, cooldown: 30, req: 0, description: '吞噬殘魂以補自身，略耗靈力', effects: [fxMp(0.10), fxHeal(0.05)] },
    { id: 'ymYu', name: '九幽鬼域', element: '域', grade: 'advanced', sect: 'youming', type: 'attack', cost: 45, cooldown: 11, req: 1, shopCost: 1500, description: '展開九幽鬼域，萬鬼噬敵', effects: [fxDmg(3.9)] },
    { id: 'ymLun', name: '輪迴印', element: '印', grade: 'advanced', sect: 'youming', type: 'attack', cost: 70, cooldown: 18, req: 2, shopCost: 3500, description: '引生死輪迴之力轟擊，並汲取其生機', effects: [fxDmg(5.2), fxHeal(0.2)] },

    // ── 萬獸山莊 ──
    { id: 'ysYu', name: '馭獸訣', element: '獸', grade: 'sect', sect: 'yushou', type: 'buff', cost: 12, cooldown: 15, req: 0, description: '與靈寵心神相通，靈寵攻擊大增', effects: [fxBuff('petAtk', 0.4, 30)] },
    { id: 'ysHou', name: '獸王咆哮', element: '吼', grade: 'sect', sect: 'yushou', type: 'attack', cost: 16, cooldown: 4, req: 0, description: '一聲咆哮震敵膽，靈寵士氣大振', effects: [fxDmg(1.7), fxBuff('petAtk', 0.2, 15)] },
    { id: 'ysBen', name: '百獸奔騰', element: '奔', grade: 'advanced', sect: 'yushou', type: 'attack', cost: 45, cooldown: 12, req: 1, shopCost: 1500, description: '百獸奔騰踐踏，靈寵同受鼓舞', effects: [fxDmg(3.5), fxBuff('petAtk', 0.5, 20)] },
    { id: 'ysLong', name: '祖龍附體', element: '龍', grade: 'advanced', sect: 'yushou', type: 'buff', cost: 70, cooldown: 25, req: 2, shopCost: 3500, description: '祖龍之魂附體，人寵攻擊大增並療傷', effects: [fxBuff('atk', 0.6, 30), fxBuff('petAtk', 0.8, 30), fxHeal(0.2)] },

    // ── 萬寶商盟 ──
    { id: 'wbBiao', name: '金錢鏢', element: '鏢', grade: 'sect', sect: 'wanbao', type: 'attack', cost: 14, cooldown: 3, req: 0, description: '以金錢鏢暗器傷敵', effects: [fxDmg(1.7)] },
    { id: 'wbHu', name: '破財消災', element: '財', grade: 'sect', sect: 'wanbao', type: 'guard', cost: 12, cooldown: 9, req: 0, description: '財氣護體，消災解厄', effects: [fxBuff('def', 0.3, 20)] },
    { id: 'wbCai', name: '天降橫財', element: '財', grade: 'advanced', sect: 'wanbao', type: 'attack', cost: 42, cooldown: 10, req: 1, shopCost: 1500, description: '萬貫銅錢從天而降砸向敵人', effects: [fxDmg(3.6)] },
    { id: 'wbBao', name: '萬寶護體', element: '寶', grade: 'advanced', sect: 'wanbao', type: 'guard', cost: 65, cooldown: 22, req: 2, shopCost: 3500, description: '祭出萬寶護身，攻守兼備', effects: [fxBuff('def', 0.45, 30), fxBuff('atk', 0.4, 30)] },
  ]

  // ───── 屬性（原 index.html）─────
  /* 角色屬性（僅顯示用，value 建議填 0-100 之間） */
  const ATTRIBUTES = [
    { stat: 'root', label: '根骨', value: 78, hint: '影響氣血上限' },
    { stat: 'insight', label: '悟性', value: 91, hint: '影響修煉速度' },
    { stat: 'soul', label: '神識', value: 64, hint: '影響功法威力' },
    { stat: 'luck', label: '氣運', value: 52, hint: '影響突破機率' },
  ]
  /* 屬性丹藥：每項屬性靠丹藥最多提升 STAT_CAP 點（記在 state.attrs），每 1 點的實際效果見 per：
   *   根骨 +1%氣血上限｜悟性 +1%修煉速度｜神識 +1%功法傷害與回復｜氣運 +0.3%突破機率
   * 連線存檔把 state.attrs 編碼成背包欄位 'zqstat' + 屬性名（伺服器計算氣血上限時會讀 zqstatroot，要改根骨公式請兩邊一起改）。 */
  const STAT_CAP = 30
  const STAT_META = {
    root: { label: '根骨', per: 0.01, fx: (n) => `氣血上限 +${n}%` },
    insight: { label: '悟性', per: 0.01, fx: (n) => `修煉速度 +${n}%` },
    soul: { label: '神識', per: 0.01, fx: (n) => `功法傷害與回復 +${n}%` },
    luck: { label: '氣運', per: 0.003, fx: (n) => `突破機率 +${+(n * 0.3).toFixed(1)}%` },
  }

  // ───── 匯率（原 index.html）─────
  const JADE_RATE = 500 // 靈石兌換仙玉的匯率（幾靈石 = 1 仙玉）

  // ───── 道具（原 index.html）─────
  /* =========================================================
   * 道具總覽：背包／交易所／拍賣場共用這份清單
   * 新增道具只要在這個物件裡加一筆資料，key 就是道具 id。欄位：
   *   name     名稱
   *   icon     圖示（直接用一個 emoji）
   *   type     'pill' 丹藥 或 'material' 材料（目前只影響分類，非必填邏輯）
   *   rarity   稀有度：'普通' / '精良' / '稀有' / '史詩'（會決定文字顏色）
   *   sell     出售價格（靈石），背包、交易所出售都會用這個數字
   *   buy      購買價格（選填）：有填才會出現在「交易所」的仙品鋪
   *   currency 購買幣別（選填）：'jade' 用仙玉購買，不填預設用靈石
   *   effect   使用效果（選填）：沒有 effect 代表此道具不能使用、只能出售
   *            { type: 'restoreMp', value: 40 }        → 使用後恢復 40 點靈力
   *            { type: 'restoreHp', value: 80 }        → 恢復 80 點氣血（9999 = 補滿）
   *            { type: 'restoreAll' }                  → 氣血、靈力全滿
   *            { type: 'addXpPercent', value: 0.3 }    → 使用後增加目前層數 30% 修為
   *            { type: 'buff', stat, value, sec }      → 限時增益，stat：atk 攻擊／def 減傷／cultivate 修煉速度／petAtk 靈寵攻擊
   *            { type: 'breakBonus', value: 0.15 }     → 下一次突破機率 +15%（不疊加，取最高）
   *            { type: 'stones', min, max }            → 開出靈石；{ type: 'jade', min, max } 開出仙玉
   *            { type: 'lootbox', rolls }              → 從 LOOTBOX_POOL 抽 rolls 次
   *            { type: 'stat', stat, value }           → 永久提升屬性（stat：root 根骨／insight 悟性／soul 神識／luck 氣運，上限見 STAT_CAP）
   *   說明文字 desc 只寫風味描述，不要寫數值；「效果：…」那一行由 itemEffectText() 依 effect 自動產生（含實際數值），所以不會對不上。
   *            effect 也可以是陣列，一次套用多種效果
   *   sect     宗門專屬（選填）：填宗門 id，只能在該宗門寶庫用貢獻兌換
   *   desc     說明文字
   *   道具 id 只能用英文字母（連線伺服器只接受英文字母的道具 id）
   * 注意：SHOP_ITEMS 清單中的道具（可在交易所直接買到的）無法在拍賣場上架。
   * ========================================================= */
  const ITEMS = {
    qi: { name: '回氣丹', icon: '💊', type: 'pill', rarity: '普通', sell: 15, buy: 40, currency: 'stones', effect: { type: 'restoreMp', value: 40 }, desc: '以靈草煉成的基礎丹藥，服後靈力緩緩回流' },
    foundation: { name: '培元丹', icon: '🧪', type: 'pill', rarity: '精良', sell: 60, buy: 150, currency: 'stones', effect: { type: 'addXpPercent', value: 0.20 }, desc: '固本培元的丹藥，助修士穩固根基' },
    spiritGrass: { name: '靈草', icon: '🌿', type: 'material', rarity: '普通', sell: 8, desc: '生長於靈氣濃郁之地的草藥，煉丹常用材料' },
    beastHide: { name: '靈獸皮', icon: '🦴', type: 'material', rarity: '普通', sell: 12, desc: '堅韌的靈獸毛皮，可用於製作法袍' },
    demonCore: { name: '妖丹', icon: '🔴', type: 'material', rarity: '精良', sell: 35, desc: '妖獸體內凝結的靈力結晶，煉丹煉器皆可用' },
    jadeSlip: { name: '破損玉簡', icon: '📜', type: 'material', rarity: '稀有', sell: 80, desc: '殘缺的功法玉簡，或許藏有秘密' },
    thunderCrystal: { name: '雷晶', icon: '⚡', type: 'material', rarity: '史詩', sell: 220, desc: '蘊含天雷之力的罕見晶石' },
    // ── 靈寵相關道具 ──
    //   effect { type: 'hatch', grade }   → 孵化靈獸蛋，grade 對應 PET_GRADES 的 key
    //   effect { type: 'feedPet', value } → 餵食靈寵，增加靈寵修為 value 點（背包「使用」= 餵給出戰靈寵）
    commonEgg: { name: '普通靈獸蛋', icon: '🥚', type: 'egg', rarity: '精良', sell: 150, buy: 600, currency: 'stones', effect: { type: 'hatch', grade: 'common' }, desc: '凡品靈獸所產之蛋，隱隱有生機流動' },
    advancedEgg: { name: '高級靈獸蛋', icon: '🪺', type: 'egg', rarity: '稀有', sell: 400, effect: { type: 'hatch', grade: 'advanced' }, desc: '秘境妖獸遺落的靈獸蛋，靈氣氤氳' },
    divineEgg: { name: '神獸蛋', icon: '🌟', type: 'egg', rarity: '史詩', sell: 2000, effect: { type: 'hatch', grade: 'divine' }, desc: '世界王魔蛟守護的上古神獸蛋，通體流轉神光' },
    commonFeed: { name: '普通寵物飼料', icon: '🌾', type: 'feed', rarity: '普通', sell: 8, buy: 30, currency: 'stones', effect: { type: 'feedPet', value: 40 }, desc: '靈寵愛吃的基礎飼料' },
    advancedFeed: { name: '高級寵物飼料', icon: '🍖', type: 'feed', rarity: '精良', sell: 60, effect: { type: 'feedPet', value: 400 }, desc: '精選靈材調製的飼料，秘境妖獸機率掉落' },
    divineFeed: { name: '神級寵物飼料', icon: '🍑', type: 'feed', rarity: '史詩', sell: 400, effect: { type: 'feedPet', value: 3000 }, desc: '神獸亦為之垂涎的珍饈，討伐世界王機率掉落' },

    // ── 丹藥・符籙 ──
    hpPill: { name: '療傷丹', icon: '🩹', type: 'pill', rarity: '普通', sell: 12, buy: 35, currency: 'stones', effect: { type: 'restoreHp', value: 80 }, desc: '行走江湖必備的療傷良藥' },
    bigQi: { name: '聚靈丹', icon: '🔵', type: 'pill', rarity: '精良', sell: 30, buy: 90, currency: 'stones', effect: { type: 'restoreMp', value: 120 }, desc: '聚攏天地靈氣的丹藥，服後靈力充盈' },
    huichun: { name: '回春丹', icon: '🌸', type: 'pill', rarity: '精良', sell: 60, buy: 160, currency: 'stones', effect: { type: 'restoreAll' }, desc: '枯木逢春之效，傷勢與耗損一併消除' },
    bigHpPill: { name: '九轉還魂丹', icon: '💖', type: 'pill', rarity: '稀有', sell: 150, effect: { type: 'restoreHp', value: 9999 }, desc: '起死回生的至寶丹藥' },
    xisui: { name: '洗髓丹', icon: '💠', type: 'pill', rarity: '稀有', sell: 200, effect: { type: 'addXpPercent', value: 0.5 }, desc: '洗經伐髓，煥發修為' },
    ningyuan: { name: '凝元丹', icon: '🔮', type: 'pill', rarity: '史詩', sell: 500, effect: { type: 'addXpPercent', value: 1.0 }, desc: '凝聚元氣的珍稀丹藥' },
    pojing: { name: '破境丹', icon: '🌀', type: 'pill', rarity: '稀有', sell: 180, effect: { type: 'breakBonus', value: 0.15 }, desc: '輔助衝擊瓶頸的丹藥' },
    dujie: { name: '渡劫靈符', icon: '🧧', type: 'talisman', rarity: '史詩', sell: 600, effect: { type: 'breakBonus', value: 0.3 }, desc: '以雷符護持，助渡難關的靈符' },
    kuangbao: { name: '狂暴丹', icon: '😤', type: 'pill', rarity: '精良', sell: 50, effect: { type: 'buff', stat: 'atk', value: 0.3, sec: 120 }, desc: '激發血氣的猛藥，服後戰意高昂' },
    jinzhong: { name: '金鐘符', icon: '🔔', type: 'talisman', rarity: '精良', sell: 50, effect: { type: 'buff', stat: 'def', value: 0.3, sec: 120 }, desc: '符成金鐘罩體，抵禦外傷' },
    wudaoTea: { name: '悟道茶', icon: '🍵', type: 'pill', rarity: '稀有', sell: 120, effect: { type: 'buff', stat: 'cultivate', value: 0.5, sec: 300 }, desc: '悟道古樹所產茶葉，飲之神思清明' },
    lingzhi: { name: '千年靈芝', icon: '🍄', type: 'pill', rarity: '稀有', sell: 260, effect: [{ type: 'restoreAll' }, { type: 'addXpPercent', value: 0.2 }], desc: '千年靈芝，補益氣血與修為' },
    beastPill: { name: '獸元丹', icon: '🟤', type: 'feed', rarity: '精良', sell: 40, effect: { type: 'feedPet', value: 150 }, desc: '以妖獸內丹煉成，靈寵視若珍饈' },
    // ── 增加角色能力的丹藥（永久提升「角色」分頁的四項屬性，每項最多靠丹藥提升 STAT_CAP 點） ──
    //   effect { type: 'stat', stat: 'root'|'insight'|'soul'|'luck', value }  → 永久 +value 點；陣列可一次提升多項
    zhuanggu: { name: '壯骨丹', icon: '💪', type: 'pill', rarity: '精良', sell: 50, buy: 4, currency: 'jade', effect: { type: 'stat', stat: 'root', value: 1 }, desc: '強筋健骨的丹藥，藥力化入根基，永久有效' },
    kaiqiao: { name: '開竅丹', icon: '🧠', type: 'pill', rarity: '精良', sell: 50, buy: 4, currency: 'jade', effect: { type: 'stat', stat: 'insight', value: 1 }, desc: '開啟靈竅的丹藥，服後頓覺靈台清明，永久有效' },
    ningshen: { name: '凝神丹', icon: '👁️', type: 'pill', rarity: '精良', sell: 50, buy: 4, currency: 'jade', effect: { type: 'stat', stat: 'soul', value: 1 }, desc: '淬鍊神識的丹藥，服後神念更為凝練，永久有效' },
    zhuanyun: { name: '轉運丹', icon: '🍀', type: 'pill', rarity: '精良', sell: 50, buy: 4, currency: 'jade', effect: { type: 'stat', stat: 'luck', value: 1 }, desc: '逆轉氣數的丹藥，服後福緣漸豐，永久有效' },
    cuiguDan: { name: '淬骨靈丹', icon: '🏋️', type: 'pill', rarity: '稀有', sell: 220, effect: { type: 'stat', stat: 'root', value: 3 }, desc: '以妖獸精血與靈藥淬鍊筋骨的靈丹，永久有效' },
    tongmingDan: { name: '通明靈丹', icon: '💡', type: 'pill', rarity: '稀有', sell: 220, effect: { type: 'stat', stat: 'insight', value: 3 }, desc: '服後道心通明、觸類旁通的靈丹，永久有效' },
    tongshenDan: { name: '通神靈丹', icon: '🔭', type: 'pill', rarity: '稀有', sell: 220, effect: { type: 'stat', stat: 'soul', value: 3 }, desc: '拓展神識疆域的靈丹，永久有效' },
    tianmingDan: { name: '天命靈丹', icon: '🎲', type: 'pill', rarity: '稀有', sell: 220, effect: { type: 'stat', stat: 'luck', value: 3 }, desc: '竊取一線天機的靈丹，永久有效' },
    wuxingDan: { name: '五行造化丹', icon: '🌈', type: 'pill', rarity: '史詩', sell: 900, effect: [{ type: 'stat', stat: 'root', value: 2 }, { type: 'stat', stat: 'insight', value: 2 }, { type: 'stat', stat: 'soul', value: 2 }, { type: 'stat', stat: 'luck', value: 2 }], desc: '五行調和、奪天地造化的神丹，四項屬性同時精進，永久有效' },
    // ── 錦囊・寶箱 ──
    stonePouch: { name: '靈石袋', icon: '👝', type: 'bag', rarity: '精良', sell: 50, effect: { type: 'stones', min: 100, max: 500 }, desc: '內藏靈石的錦囊' },
    jadePouch: { name: '仙玉袋', icon: '👛', type: 'bag', rarity: '稀有', sell: 100, effect: { type: 'jade', min: 1, max: 5 }, desc: '內藏仙玉的錦囊' },
    treasureBox: { name: '秘境寶箱', icon: '🎁', type: 'bag', rarity: '稀有', sell: 120, effect: { type: 'lootbox', rolls: 2 }, desc: '秘境中的寶箱，內藏各式寶物' },
    // ── 材料（可出售，或上交宗門任務） ──
    wolfFang: { name: '狼牙', icon: '🦷', type: 'material', rarity: '普通', sell: 10, desc: '赤血狼的獠牙，鋒利異常' },
    batWing: { name: '蝠翼', icon: '🪽', type: 'material', rarity: '普通', sell: 10, desc: '夜魘蝠的翼膜，可入毒藥' },
    blackIron: { name: '玄鐵', icon: '⚙️', type: 'material', rarity: '精良', sell: 30, desc: '沉重的黑色礦石，鑄劍良材' },
    beastBlood: { name: '妖獸精血', icon: '🩸', type: 'material', rarity: '精良', sell: 35, desc: '妖獸心頭精血，蘊含旺盛生機' },
    tigerBone: { name: '虎骨', icon: '🦴', type: 'material', rarity: '精良', sell: 40, desc: '玄紋妖虎之骨，可煉強筋健骨之藥' },
    snakeGall: { name: '蛇膽', icon: '🟢', type: 'material', rarity: '精良', sell: 45, desc: '赤焰蛟的膽囊，至苦亦至補' },
    golemCore: { name: '傀儡核心', icon: '🔩', type: 'material', rarity: '稀有', sell: 70, desc: '驅動岩甲傀儡的陣法核心' },
    spiritJade: { name: '靈玉', icon: '🟩', type: 'material', rarity: '稀有', sell: 75, desc: '溫潤含靈的美玉，可用於佈陣' },
    fireLotus: { name: '火蓮', icon: '🪷', type: 'material', rarity: '稀有', sell: 90, desc: '生於地火之中的蓮花，煉丹聖品' },
    soulFire: { name: '幽魂火', icon: '👻', type: 'material', rarity: '稀有', sell: 85, desc: '飄忽不定的冥火，鬼道修士視為至寶' },
    iceSilk: { name: '冰蠶絲', icon: '🧵', type: 'material', rarity: '稀有', sell: 95, desc: '寒淵冰蠶所吐之絲，水火不侵' },
    ancientCoin: { name: '上古銅錢', icon: '🪙', type: 'material', rarity: '稀有', sell: 100, desc: '鑄有失傳文字的古錢，商盟高價收購' },
    inkPearl: { name: '墨珠', icon: '⚫', type: 'material', rarity: '稀有', sell: 140, desc: '深淵章鬼體內凝成的墨色寶珠' },
    starIron: { name: '星辰鐵', icon: '🌠', type: 'material', rarity: '史詩', sell: 200, desc: '天外隕鐵，煉製飛劍的無上材料' },
    phoenixFeather: { name: '鳳羽', icon: '🪶', type: 'material', rarity: '史詩', sell: 240, desc: '赤羽幻鳳的尾羽，餘溫不散' },
    dragonScale: { name: '蛟龍鱗', icon: '🐲', type: 'material', rarity: '史詩', sell: 260, desc: '赤焰蛟逆鱗，堅逾精鋼' },

    // ── 宗門專屬天材地寶（只能在所屬宗門寶庫用貢獻兌換） ──
    jianxinStone: { name: '劍心石', icon: '🗡️', type: 'treasure', rarity: '稀有', sell: 150, sect: 'qingyun', effect: { type: 'buff', stat: 'atk', value: 0.4, sec: 300 }, desc: '劍意凝石，持之劍意沛然' },
    qingmingPill: { name: '青冥劍丸', icon: '🟦', type: 'treasure', rarity: '稀有', sell: 250, sect: 'qingyun', effect: { type: 'addXpPercent', value: 0.6 }, desc: '以劍氣淬鍊的丹丸' },
    wanjianSlip: { name: '萬劍歸宗玉簡', icon: '📘', type: 'treasure', rarity: '史詩', sell: 400, sect: 'qingyun', effect: { type: 'breakBonus', value: 0.25 }, desc: '開山祖師劍意所留的玉簡' },
    taiqingDew: { name: '太清靈露', icon: '💧', type: 'treasure', rarity: '稀有', sell: 150, sect: 'xuantian', effect: { type: 'buff', stat: 'cultivate', value: 1.0, sec: 300 }, desc: '道宮靈露，飲之心神澄明' },
    xuantianFruit: { name: '玄天道果', icon: '🍐', type: 'treasure', rarity: '史詩', sell: 350, sect: 'xuantian', effect: { type: 'addXpPercent', value: 1.0 }, desc: '道宮古樹千年一結的道果' },
    zifuTalisman: { name: '紫府仙籙', icon: '📜', type: 'treasure', rarity: '史詩', sell: 450, sect: 'xuantian', effect: { type: 'breakBonus', value: 0.3 }, desc: '紫府仙籙，護持道心' },
    baicaoMarrow: { name: '百草靈髓', icon: '🌱', type: 'treasure', rarity: '稀有', sell: 150, sect: 'danding', effect: [{ type: 'restoreAll' }, { type: 'addXpPercent', value: 0.3 }], desc: '百草精華凝成的靈髓' },
    jiuzhuanPill: { name: '九轉金丹', icon: '🟡', type: 'treasure', rarity: '史詩', sell: 450, sect: 'danding', effect: { type: 'addXpPercent', value: 1.5 }, desc: '丹鼎谷鎮谷之丹' },
    zaohuaPill: { name: '造化丹', icon: '☯️', type: 'treasure', rarity: '史詩', sell: 400, sect: 'danding', effect: { type: 'breakBonus', value: 0.3 }, desc: '奪天地造化的丹藥' },
    sheli: { name: '舍利子', icon: '📿', type: 'treasure', rarity: '稀有', sell: 150, sect: 'jingang', effect: { type: 'buff', stat: 'def', value: 0.5, sec: 300 }, desc: '高僧坐化所留的舍利' },
    bodhiSeed: { name: '金剛菩提', icon: '🟠', type: 'treasure', rarity: '稀有', sell: 250, sect: 'jingang', effect: [{ type: 'restoreAll' }, { type: 'addXpPercent', value: 0.4 }], desc: '金剛菩提樹所結的種子' },
    budongTalisman: { name: '不動明王符', icon: '🛕', type: 'treasure', rarity: '史詩', sell: 400, sect: 'jingang', effect: { type: 'breakBonus', value: 0.25 }, desc: '心如不動，貼身護持的明王符' },
    bloodSoulBead: { name: '血魂珠', icon: '🔻', type: 'treasure', rarity: '稀有', sell: 150, sect: 'xuesha', effect: { type: 'buff', stat: 'atk', value: 0.5, sec: 180 }, desc: '凝聚萬千血魂的寶珠' },
    xueshaEssence: { name: '血煞精元', icon: '🫀', type: 'treasure', rarity: '史詩', sell: 280, sect: 'xuesha', effect: { type: 'addXpPercent', value: 0.8 }, desc: '血煞宗秘煉的血煞精元' },
    huaxuePill: { name: '化血神丹', icon: '💉', type: 'treasure', rarity: '稀有', sell: 200, sect: 'xuesha', effect: [{ type: 'restoreHp', value: 9999 }, { type: 'buff', stat: 'atk', value: 0.3, sec: 300 }], desc: '血煞宗化血療傷之丹' },
    guKing: { name: '萬毒蠱王', icon: '🦂', type: 'treasure', rarity: '稀有', sell: 200, sect: 'wandu', effect: { type: 'buff', stat: 'atk', value: 0.35, sec: 600 }, desc: '萬蠱相殘所剩之王' },
    biXuePill: { name: '碧血毒丹', icon: '🧫', type: 'treasure', rarity: '史詩', sell: 260, sect: 'wandu', effect: { type: 'addXpPercent', value: 0.7 }, desc: '以毒攻毒煉成的碧血毒丹' },
    wuduBead: { name: '五毒珠', icon: '🟣', type: 'treasure', rarity: '稀有', sell: 200, sect: 'wandu', effect: { type: 'buff', stat: 'def', value: 0.4, sec: 600 }, desc: '五毒凝珠，百毒不侵' },
    ghostFire: { name: '九幽鬼火', icon: '🔥', type: 'treasure', rarity: '史詩', sell: 450, sect: 'youming', effect: { type: 'breakBonus', value: 0.35 }, desc: '九幽之下的鬼火，燃燒心魔' },
    samsaraFruit: { name: '輪迴果', icon: '🍇', type: 'treasure', rarity: '史詩', sell: 400, sect: 'youming', effect: { type: 'addXpPercent', value: 1.2 }, desc: '生於忘川彼岸的果實' },
    soulBanner: { name: '噬魂幡', icon: '🏴', type: 'treasure', rarity: '稀有', sell: 180, sect: 'youming', effect: { type: 'buff', stat: 'atk', value: 0.4, sec: 300 }, desc: '招攬殘魂的幡旗' },
    beastSoul: { name: '獸王精魄', icon: '🦁', type: 'treasure', rarity: '稀有', sell: 120, sect: 'yushou', effect: { type: 'feedPet', value: 1500 }, desc: '獸王死後凝成的精魄' },
    dragonBlood: { name: '祖龍之血', icon: '🧪', type: 'treasure', rarity: '史詩', sell: 400, sect: 'yushou', effect: { type: 'feedPet', value: 6000 }, desc: '上古祖龍遺留的精血' },
    yushouRing: { name: '御獸金環', icon: '💫', type: 'treasure', rarity: '稀有', sell: 150, sect: 'yushou', effect: { type: 'buff', stat: 'petAtk', value: 0.5, sec: 600 }, desc: '御獸一脈的信物金環' },
    cornucopia: { name: '聚寶盆', icon: '🏺', type: 'treasure', rarity: '稀有', sell: 150, sect: 'wanbao', effect: { type: 'stones', min: 2000, max: 6000 }, desc: '取之不盡的聚寶盆' },
    goldToad: { name: '招財金蟾', icon: '🐸', type: 'treasure', rarity: '史詩', sell: 250, sect: 'wanbao', effect: { type: 'jade', min: 10, max: 30 }, desc: '口吐仙玉的招財金蟾' },
    wanbaoToken: { name: '萬寶令', icon: '🎫', type: 'treasure', rarity: '史詩', sell: 200, sect: 'wanbao', effect: { type: 'lootbox', rolls: 5 }, desc: '商盟秘庫的通行令' },
    // ── 新秘境材料 ──
    toadVenom: { name: '蟾毒囊', icon: '☠️', type: 'material', rarity: '普通', sell: 14, desc: '毒瘴蟾腹中的毒囊，煉毒藥的基礎材料' },
    crocScale: { name: '鱷鱗', icon: '🐊', type: 'material', rarity: '普通', sell: 18, desc: '沼澤鱷妖背上的厚鱗，刀劍難傷' },
    boneShard: { name: '白骨碎', icon: '💀', type: 'material', rarity: '精良', sell: 42, desc: '白骨衛士身上剝落的骨片，浸染陰氣' },
    ghostJade: { name: '鬼玉', icon: '🪬', type: 'material', rarity: '稀有', sell: 80, desc: '冥氣凝結的幽綠玉石，鬼修爭相搶購' },
    lavaCore: { name: '熔岩之心', icon: '🌋', type: 'material', rarity: '稀有', sell: 110, desc: '熔岩蜥體內不熄的地火核心' },
    lionMane: { name: '烈焰獅鬃', icon: '🦁', type: 'material', rarity: '精良', sell: 60, desc: '烈焰獅頸間燃燒的鬃毛，觸手生溫' },
    frostCrystal: { name: '寒魄晶', icon: '🧊', type: 'material', rarity: '史詩', sell: 230, desc: '九幽冰原千年不化的玄冰精華' },
    thunderEssence: { name: '雷霆精魄', icon: '🌩️', type: 'material', rarity: '史詩', sell: 320, desc: '九天雷澤妖獸體內凝聚的雷霆本源' },
    chaosShard: { name: '混沌碎片', icon: '🌑', type: 'material', rarity: '史詩', sell: 480, desc: '混沌虛空中崩落的世界殘片' },
    voidPearl: { name: '虛空珠', icon: '🫧', type: 'material', rarity: '史詩', sell: 520, desc: '虛空之眼凝成的寶珠，映照萬象' },
    ancientRelic: { name: '太古神器殘片', icon: '🗝️', type: 'material', rarity: '史詩', sell: 800, desc: '上古神墟中遺落的神器碎片，價值連城' },
    // ── 煉器材料（秘境妖獸掉落，宗門「煉器工坊」煉製裝備用） ──
    forgeCoal: { name: '赤炭', icon: '🪨', type: 'material', rarity: '普通', sell: 9, desc: '地火餘燼壓成的炭塊，煉器起爐必備的燃料' },
    pigIron: { name: '生鐵', icon: '⛓️', type: 'material', rarity: '普通', sell: 14, desc: '尚未淬鍊的粗鐵，是鑄造器胚的基底' },
    steelIngot: { name: '百煉精鋼', icon: '🔩', type: 'material', rarity: '精良', sell: 48, desc: '千錘百煉後的精鋼錠，中階法器的骨架' },
    spiritSand: { name: '靈砂', icon: '✨', type: 'material', rarity: '精良', sell: 40, desc: '蘊含靈氣的細砂，煉器時摻入可穩固靈紋' },
    fireCrystal: { name: '離火晶', icon: '🔥', type: 'material', rarity: '稀有', sell: 125, desc: '離火精華凝成的赤紅晶石，灼手生煙' },
    iceIronEssence: { name: '玄冰鐵精', icon: '🧊', type: 'material', rarity: '稀有', sell: 135, desc: '寒鐵千年提煉出的精華，觸之刺骨' },
    thunderWood: { name: '雷擊木', icon: '🪵', type: 'material', rarity: '稀有', sell: 150, desc: '遭天雷劈過仍不死的靈木，木心蘊藏雷意' },
    skyGold: { name: '九天玄金', icon: '🟨', type: 'material', rarity: '史詩', sell: 420, desc: '九天罡風淬鍊的神金，輕如鴻毛、堅不可摧' },
    divineForgeStone: { name: '神鑄石', icon: '💎', type: 'material', rarity: '史詩', sell: 700, desc: '上古神匠遺留的鑄器靈石，能令凡鐵蛻變為道器' },
    // ── 裝備模板（type: 'equip'） ──
    //   equip { slot, req, bonuses }：slot 部位（見 EQUIP_SLOTS）｜req 佩戴所需境界（REALMS 索引）
    //   bonuses 為 [{ type, value }]，type 與宗門特色相同（見 BONUS_TYPES；另有 hp 氣血上限%），穿上後直接加進角色
    //   要新增裝備：在這裡加一筆，再到 FORGE_RECIPES（通用）或 SECT_FORGE（宗門專屬）加一筆煉製配方
    //   裝備 id 只能用英文字母且最多 19 字（連線存檔會把已穿戴的裝備編成背包欄位）
    // 法器（築基前可用）
    ironSword: { name: '玄鐵劍', icon: '⚔️', type: 'equip', rarity: '精良', sell: 90, equip: { slot: 'weapon', req: 0, bonuses: [{ type: 'atk', value: 0.05 }] }, desc: '以玄鐵鍛成的入門飛劍，鋒口樸實無華' },
    hideRobe: { name: '靈皮法袍', icon: '🥋', type: 'equip', rarity: '精良', sell: 80, equip: { slot: 'armor', req: 0, bonuses: [{ type: 'def', value: 0.04 }] }, desc: '以靈獸皮縫製的法袍，能卸去幾分衝擊' },
    ironCrown: { name: '精鐵道冠', icon: '👑', type: 'equip', rarity: '精良', sell: 80, equip: { slot: 'head', req: 0, bonuses: [{ type: 'hp', value: 0.05 }] }, desc: '束髮護頂的鐵冠，內刻簡易聚氣紋' },
    wolfBoots: { name: '狼筋靴', icon: '👢', type: 'equip', rarity: '精良', sell: 70, equip: { slot: 'boots', req: 0, bonuses: [{ type: 'hpRegen', value: 1 }] }, desc: '縫入狼筋的長靴，行走間氣血自然流轉' },
    boneCharm: { name: '護身骨符', icon: '📿', type: 'equip', rarity: '精良', sell: 85, equip: { slot: 'charm', req: 0, bonuses: [{ type: 'cultivate', value: 0.04 }] }, desc: '妖丹磨粉混入骨符，佩之心神略定' },
    // 靈器（金丹期可用）
    fireBlade: { name: '赤焰飛劍', icon: '🔥', type: 'equip', rarity: '稀有', sell: 300, equip: { slot: 'weapon', req: 2, bonuses: [{ type: 'atk', value: 0.12 }] }, desc: '劍身繞離火，出鞘如赤虹貫日' },
    scaleArmor: { name: '玄鱗護甲', icon: '🛡️', type: 'equip', rarity: '稀有', sell: 260, equip: { slot: 'armor', req: 2, bonuses: [{ type: 'def', value: 0.09 }] }, desc: '層層玄鱗疊成的護甲，刀劍難入' },
    spiritCrown: { name: '凝神玉冠', icon: '👑', type: 'equip', rarity: '稀有', sell: 260, equip: { slot: 'head', req: 2, bonuses: [{ type: 'hp', value: 0.12 }] }, desc: '靈玉嵌冠，戴上後精氣神自然充盈' },
    windBoots: { name: '御風靴', icon: '👢', type: 'equip', rarity: '稀有', sell: 230, equip: { slot: 'boots', req: 2, bonuses: [{ type: 'hpRegen', value: 2 }] }, desc: '冰蠶絲織就的輕靴，步步生風' },
    jadePendant: { name: '靜心玉佩', icon: '📿', type: 'equip', rarity: '稀有', sell: 280, equip: { slot: 'charm', req: 2, bonuses: [{ type: 'cultivate', value: 0.09 }] }, desc: '溫玉佩於胸前，雜念不生' },
    // 寶器（化神期可用）
    thunderSword: { name: '九霄雷劍', icon: '⚡', type: 'equip', rarity: '史詩', sell: 900, equip: { slot: 'weapon', req: 4, bonuses: [{ type: 'atk', value: 0.22 }] }, desc: '雷擊木為柄、雷晶為刃，揮動時雷鳴隱隱' },
    dragonArmor: { name: '蛟龍鎧', icon: '🐲', type: 'equip', rarity: '史詩', sell: 800, equip: { slot: 'armor', req: 4, bonuses: [{ type: 'def', value: 0.16 }] }, desc: '以蛟龍逆鱗鍛成的重鎧，龍威護體' },
    phoenixCrown: { name: '鳳羽冠', icon: '🪶', type: 'equip', rarity: '史詩', sell: 800, equip: { slot: 'head', req: 4, bonuses: [{ type: 'hp', value: 0.22 }] }, desc: '鳳羽織冠，浴火不滅的生機盡納其中' },
    frostBoots: { name: '寒霜履', icon: '👢', type: 'equip', rarity: '史詩', sell: 700, equip: { slot: 'boots', req: 4, bonuses: [{ type: 'hpRegen', value: 4 }] }, desc: '寒魄晶為底的戰靴，踏過之處凝霜成冰' },
    voidCharm: { name: '虛空靈佩', icon: '🫧', type: 'equip', rarity: '史詩', sell: 950, equip: { slot: 'charm', req: 4, bonuses: [{ type: 'cultivate', value: 0.15 }] }, desc: '佩中似有星河流轉，修行事半功倍' },
    // 道器（大乘期可用）
    chaosSword: { name: '混沌開天劍', icon: '🗡️', type: 'equip', rarity: '史詩', sell: 3000, equip: { slot: 'weapon', req: 6, bonuses: [{ type: 'atk', value: 0.35 }] }, desc: '混沌碎片與神金合鑄，一劍可開天闢地' },
    ancientArmor: { name: '太古神甲', icon: '🏛️', type: 'equip', rarity: '史詩', sell: 2800, equip: { slot: 'armor', req: 6, bonuses: [{ type: 'def', value: 0.25 }] }, desc: '上古神魔大戰遺留的戰甲，萬法不侵' },
    godCrown: { name: '神墟帝冠', icon: '👑', type: 'equip', rarity: '史詩', sell: 2800, equip: { slot: 'head', req: 6, bonuses: [{ type: 'hp', value: 0.35 }] }, desc: '神墟帝王的冠冕，戴之氣血如海' },
    voidBoots: { name: '踏虛靴', icon: '👢', type: 'equip', rarity: '史詩', sell: 2400, equip: { slot: 'boots', req: 6, bonuses: [{ type: 'hpRegen', value: 7 }] }, desc: '虛空珠為飾的戰靴，一步踏碎虛空' },
    chaosCharm: { name: '混沌道佩', icon: '☯️', type: 'equip', rarity: '史詩', sell: 3200, equip: { slot: 'charm', req: 6, bonuses: [{ type: 'cultivate', value: 0.24 }] }, desc: '混沌初開時的一縷道韻，悟道之寶' },
    // 宗門專屬裝備（只能在對應宗門的煉器工坊煉製）
    qingshuangSword: { name: '青霜劍', icon: '🗡️', type: 'equip', rarity: '稀有', sell: 400, sect: 'qingyun', equip: { slot: 'weapon', req: 1, bonuses: [{ type: 'atk', value: 0.10 }, { type: 'breakthrough', value: 0.02 }] }, desc: '青雲劍宗鑄劍閣的名劍，劍氣森寒，可斬妖邪' },
    wanjianRobe: { name: '萬劍法袍', icon: '🥋', type: 'equip', rarity: '史詩', sell: 1100, sect: 'qingyun', equip: { slot: 'armor', req: 4, bonuses: [{ type: 'atk', value: 0.12 }, { type: 'def', value: 0.10 }] }, desc: '袍上暗繡萬道劍紋，劍意護身' },
    taiqingCrown: { name: '太清道冠', icon: '🎓', type: 'equip', rarity: '稀有', sell: 400, sect: 'xuantian', equip: { slot: 'head', req: 1, bonuses: [{ type: 'cultivate', value: 0.08 }, { type: 'mpRegen', value: 1 }] }, desc: '玄天道宮弟子所戴的道冠，清靜無為' },
    zifuCharm: { name: '紫府靈符佩', icon: '📜', type: 'equip', rarity: '史詩', sell: 1100, sect: 'xuantian', equip: { slot: 'charm', req: 4, bonuses: [{ type: 'cultivate', value: 0.18 }, { type: 'breakthrough', value: 0.04 }] }, desc: '紫府仙籙化作的佩飾，護持道心' },
    yaowangGourd: { name: '藥王葫蘆', icon: '🏺', type: 'equip', rarity: '稀有', sell: 400, sect: 'danding', equip: { slot: 'charm', req: 1, bonuses: [{ type: 'pill', value: 0.15 }, { type: 'hpRegen', value: 1 }] }, desc: '丹鼎谷藥王親煉的葫蘆，內藏藥香不散' },
    danhuoRobe: { name: '丹火法衣', icon: '🧥', type: 'equip', rarity: '史詩', sell: 1100, sect: 'danding', equip: { slot: 'armor', req: 4, bonuses: [{ type: 'def', value: 0.10 }, { type: 'pill', value: 0.20 }, { type: 'hpRegen', value: 3 }] }, desc: '以煉丹地火淬過的法衣，火氣養身' },
    jingangHelm: { name: '金剛護首', icon: '⛑️', type: 'equip', rarity: '稀有', sell: 400, sect: 'jingang', equip: { slot: 'head', req: 1, bonuses: [{ type: 'def', value: 0.06 }, { type: 'hp', value: 0.08 }] }, desc: '金剛寺武僧所戴的銅首盔，剛猛厚重' },
    arhatCassock: { name: '羅漢金身衣', icon: '🧘', type: 'equip', rarity: '史詩', sell: 1100, sect: 'jingang', equip: { slot: 'armor', req: 4, bonuses: [{ type: 'def', value: 0.20 }, { type: 'hpRegen', value: 3 }] }, desc: '羅漢金身的外相，披之如入不動之境' },
    xuehunBlade: { name: '噬血刀', icon: '🔪', type: 'equip', rarity: '稀有', sell: 400, sect: 'xuesha', equip: { slot: 'weapon', req: 1, bonuses: [{ type: 'atk', value: 0.12 }, { type: 'lifesteal', value: 0.03 }] }, desc: '血煞宗血煉坊的魔刀，見血則鳴' },
    xuehaiArmor: { name: '血海魔甲', icon: '🩸', type: 'equip', rarity: '史詩', sell: 1100, sect: 'xuesha', equip: { slot: 'armor', req: 4, bonuses: [{ type: 'atk', value: 0.10 }, { type: 'def', value: 0.06 }, { type: 'lifesteal', value: 0.05 }] }, desc: '浸過血海的魔甲，越戰越是兇悍' },
    wanduRing: { name: '蝕骨毒環', icon: '💍', type: 'equip', rarity: '稀有', sell: 400, sect: 'wandu', equip: { slot: 'charm', req: 1, bonuses: [{ type: 'atk', value: 0.06 }, { type: 'loot', value: 0.10 }] }, desc: '萬毒門的毒環，環內藏針、見血封喉' },
    duwuMask: { name: '五毒面具', icon: '🎭', type: 'equip', rarity: '史詩', sell: 1100, sect: 'wandu', equip: { slot: 'head', req: 4, bonuses: [{ type: 'loot', value: 0.15 }, { type: 'def', value: 0.08 }] }, desc: '五毒凝成的面具，百毒不侵，連妖獸遺落之物都逃不過它的嗅覺' },
    zhaohunCharm: { name: '招魂靈佩', icon: '🪬', type: 'equip', rarity: '稀有', sell: 400, sect: 'youming', equip: { slot: 'charm', req: 1, bonuses: [{ type: 'exp', value: 0.10 }, { type: 'breakthrough', value: 0.02 }] }, desc: '幽冥殿的招魂佩，吞噬殘魂化為修為' },
    guiwangBoots: { name: '鬼王靴', icon: '👢', type: 'equip', rarity: '史詩', sell: 1100, sect: 'youming', equip: { slot: 'boots', req: 4, bonuses: [{ type: 'exp', value: 0.15 }, { type: 'breakthrough', value: 0.03 }, { type: 'hpRegen', value: 3 }] }, desc: '鬼帝賜下的戰靴，行走間陰風相隨' },
    yushouArmor: { name: '馭獸皮甲', icon: '🦬', type: 'equip', rarity: '稀有', sell: 400, sect: 'yushou', equip: { slot: 'armor', req: 1, bonuses: [{ type: 'petAtk', value: 0.15 }, { type: 'def', value: 0.05 }] }, desc: '萬獸山莊獸器坊的皮甲，靈獸嗅到氣息便格外親近' },
    yushouWhip: { name: '馭獸鞭', icon: '🪢', type: 'equip', rarity: '史詩', sell: 1100, sect: 'yushou', equip: { slot: 'weapon', req: 4, bonuses: [{ type: 'petAtk', value: 0.25 }, { type: 'petXp', value: 0.20 }, { type: 'atk', value: 0.08 }] }, desc: '以蛟龍筋與雷擊木編成的長鞭，揮舞間百獸臣服' },
    jinsuanPan: { name: '金算盤', icon: '🧮', type: 'equip', rarity: '稀有', sell: 400, sect: 'wanbao', equip: { slot: 'charm', req: 1, bonuses: [{ type: 'sell', value: 0.12 }, { type: 'discount', value: 0.08 }] }, desc: '萬寶商盟的招牌法寶，一撥珠子萬貫入帳' },
    caishenBoots: { name: '招財靴', icon: '👞', type: 'equip', rarity: '史詩', sell: 1100, sect: 'wanbao', equip: { slot: 'boots', req: 4, bonuses: [{ type: 'sell', value: 0.18 }, { type: 'discount', value: 0.12 }, { type: 'loot', value: 0.10 }] }, desc: '鞋底鑄有銅錢紋，行至哪裡財運跟到哪裡' },
    // ↑ 在這裡繼續加新道具，例如：
    // newItem: { name: '新道具', icon: '✨', type: 'material', rarity: '稀有', sell: 50, desc: '描述文字' },
  }

  // ───── 商店（原 index.html）─────
  /* 交易所「仙品鋪」要賣什麼，就把 ITEMS 裡有設定 buy 價格的道具 id 填進這個陣列 */
  const SHOP_ITEMS = ['qi', 'bigQi', 'hpPill', 'huichun', 'foundation', 'commonEgg', 'commonFeed', 'zhuanggu', 'kaiqiao', 'ningshen', 'zhuanyun']

  // ───── 裝備煉器寶箱（原 index.html）─────
  /* =========================================================
   * 裝備系統
   * EQUIP_SLOTS：裝備部位，每個部位同時只能穿一件（背包裡按「裝備」，已穿戴的在背包頂端可「卸下」）
   * 裝備本身是 ITEMS 裡 type: 'equip' 的道具，加成透過 gearBonus() 併入 sectBonus()，所以攻擊、減傷、修煉、掉落…全部自動生效
   * FORGE_RECIPES：通用煉器配方，所有宗門的「煉器工坊」都能煉
   *   { item: 裝備 id, mats: { 材料 id: 數量 }, stones: 靈石 }
   * SECT_FORGE：各宗門專屬煉器工坊（key = 宗門 id）：
   *   { name 工坊名, desc 說明, recipes: [{ item, mats, stones, fee: 貢獻 }] }
   *   專屬配方只有該宗門弟子能煉，除了材料與靈石，還要消耗宗門貢獻
   * 散修沒有工坊可用，拜入任一宗門即可使用該宗的煉器工坊
   * ========================================================= */
  const EQUIP_SLOTS = {
    weapon: { label: '兵器', icon: '⚔️' },
    armor: { label: '護甲', icon: '🥋' },
    head: { label: '頭冠', icon: '👑' },
    boots: { label: '靴履', icon: '👢' },
    charm: { label: '佩飾', icon: '📿' },
  }
  const EQUIP_KEY = 'zqeqp'
  /* 煉製失敗率：依裝備佩戴境界 req（品階）決定，品階越高越容易失敗；配方也可自行加 fail 欄位（0~1）覆蓋
   * 失敗時：靈石全數損失、材料損失一半（無條件進位），宗門貢獻不扣 */
  const FORGE_FAIL = { 0: 0.05, 1: 0.15, 2: 0.20, 4: 0.35, 6: 0.50 }
  const forgeFailRate = (r) => (r.fail != null ? r.fail : (FORGE_FAIL[ITEMS[r.item].equip.req] || 0))
  const FORGE_RECIPES = [
    // 法器
    { item: 'ironSword', mats: { blackIron: 3, forgeCoal: 4, wolfFang: 2 }, stones: 150 },
    { item: 'hideRobe', mats: { beastHide: 6, forgeCoal: 3 }, stones: 120 },
    { item: 'ironCrown', mats: { pigIron: 4, forgeCoal: 3 }, stones: 120 },
    { item: 'wolfBoots', mats: { beastHide: 4, wolfFang: 3, forgeCoal: 2 }, stones: 100 },
    { item: 'boneCharm', mats: { demonCore: 2, spiritGrass: 3, forgeCoal: 2 }, stones: 130 },
    // 靈器
    { item: 'fireBlade', mats: { steelIngot: 4, fireCrystal: 1, forgeCoal: 4 }, stones: 800 },
    { item: 'scaleArmor', mats: { steelIngot: 3, crocScale: 6, spiritSand: 2 }, stones: 700 },
    { item: 'spiritCrown', mats: { spiritJade: 2, steelIngot: 3, spiritSand: 2 }, stones: 700 },
    { item: 'windBoots', mats: { iceSilk: 2, beastHide: 6, spiritSand: 2 }, stones: 600 },
    { item: 'jadePendant', mats: { spiritJade: 2, soulFire: 2, spiritSand: 3 }, stones: 750 },
    // 寶器
    { item: 'thunderSword', mats: { thunderWood: 3, steelIngot: 6, thunderCrystal: 3 }, stones: 4000 },
    { item: 'dragonArmor', mats: { dragonScale: 4, steelIngot: 6, iceIronEssence: 2 }, stones: 3500 },
    { item: 'phoenixCrown', mats: { phoenixFeather: 3, fireCrystal: 3, steelIngot: 4 }, stones: 3500 },
    { item: 'frostBoots', mats: { frostCrystal: 2, iceIronEssence: 2, iceSilk: 4 }, stones: 3000 },
    { item: 'voidCharm', mats: { thunderEssence: 2, inkPearl: 2, skyGold: 1 }, stones: 3800 },
    // 道器
    { item: 'chaosSword', mats: { skyGold: 5, chaosShard: 3, divineForgeStone: 2 }, stones: 12000 },
    { item: 'ancientArmor', mats: { skyGold: 5, dragonScale: 6, ancientRelic: 2 }, stones: 11000 },
    { item: 'godCrown', mats: { voidPearl: 3, skyGold: 4, ancientRelic: 1 }, stones: 11000 },
    { item: 'voidBoots', mats: { voidPearl: 2, chaosShard: 2, skyGold: 3 }, stones: 9000 },
    { item: 'chaosCharm', mats: { chaosShard: 4, voidPearl: 2, divineForgeStone: 2 }, stones: 12000 },
  ]
  const SECT_FORGE = {
    qingyun: { name: '鑄劍閣', desc: '青雲劍宗歷代名劍皆出於此，閣中劍爐晝夜不熄。', recipes: [
      { item: 'qingshuangSword', mats: { blackIron: 4, steelIngot: 2, forgeCoal: 4 }, stones: 500, fee: 150 },
      { item: 'wanjianRobe', mats: { starIron: 2, steelIngot: 5, spiritSand: 3 }, stones: 3000, fee: 500 },
    ] },
    xuantian: { name: '天工閣', desc: '道宮以符陣入器，所煉之物皆含清靜道韻。', recipes: [
      { item: 'taiqingCrown', mats: { spiritJade: 2, spiritSand: 2, steelIngot: 1 }, stones: 500, fee: 150 },
      { item: 'zifuCharm', mats: { jadeSlip: 3, spiritJade: 3, skyGold: 1 }, stones: 3000, fee: 500 },
    ] },
    danding: { name: '丹器坊', desc: '丹鼎谷以煉丹地火煉器，所成法寶自帶藥氣。', recipes: [
      { item: 'yaowangGourd', mats: { spiritGrass: 8, demonCore: 3, forgeCoal: 3 }, stones: 500, fee: 150 },
      { item: 'danhuoRobe', mats: { fireCrystal: 3, fireLotus: 3, steelIngot: 4 }, stones: 3000, fee: 500 },
    ] },
    jingang: { name: '金剛鑄坊', desc: '金剛寺的鑄坊專煉護體之器，講究厚重剛猛。', recipes: [
      { item: 'jingangHelm', mats: { blackIron: 4, golemCore: 1, forgeCoal: 4 }, stones: 500, fee: 150 },
      { item: 'arhatCassock', mats: { dragonScale: 3, steelIngot: 5, golemCore: 4 }, stones: 3000, fee: 500 },
    ] },
    xuesha: { name: '血煉坊', desc: '血煞宗以血祭開爐，所煉兵刃嗜血而鳴。', recipes: [
      { item: 'xuehunBlade', mats: { beastBlood: 4, blackIron: 3, wolfFang: 4, forgeCoal: 3 }, stones: 500, fee: 150 },
      { item: 'xuehaiArmor', mats: { beastBlood: 8, dragonScale: 2, steelIngot: 4 }, stones: 3000, fee: 500 },
    ] },
    wandu: { name: '毒器坊', desc: '萬毒門的煉器坊終日毒煙繚繞，外人不敢靠近。', recipes: [
      { item: 'wanduRing', mats: { toadVenom: 6, snakeGall: 2, forgeCoal: 2 }, stones: 500, fee: 150 },
      { item: 'duwuMask', mats: { snakeGall: 4, soulFire: 3, ghostJade: 2, steelIngot: 3 }, stones: 3000, fee: 500 },
    ] },
    youming: { name: '幽煉殿', desc: '幽冥殿以鬼火煉器，器成之時殘魂低語不絕。', recipes: [
      { item: 'zhaohunCharm', mats: { soulFire: 3, boneShard: 3, forgeCoal: 2 }, stones: 500, fee: 150 },
      { item: 'guiwangBoots', mats: { ghostJade: 3, soulFire: 4, steelIngot: 3 }, stones: 3000, fee: 500 },
    ] },
    yushou: { name: '獸器坊', desc: '萬獸山莊的工匠專為御獸之人量身打造器具。', recipes: [
      { item: 'yushouArmor', mats: { beastHide: 8, tigerBone: 3, forgeCoal: 4 }, stones: 500, fee: 150 },
      { item: 'yushouWhip', mats: { dragonScale: 2, beastBlood: 6, steelIngot: 4, thunderWood: 1 }, stones: 3000, fee: 500 },
    ] },
    wanbao: { name: '天工坊', desc: '萬寶商盟重金延請天下巧匠，專煉招財進寶的奇物。', recipes: [
      { item: 'jinsuanPan', mats: { ancientCoin: 3, spiritJade: 2, forgeCoal: 3 }, stones: 500, fee: 150 },
      { item: 'caishenBoots', mats: { ancientCoin: 6, inkPearl: 2, steelIngot: 4 }, stones: 3000, fee: 500 },
    ] },
  }
  // 煉器材料被哪些配方用到（背包說明用）
  const forgeMatUsers = (id) => FORGE_RECIPES.some((r) => r.mats[id]) || Object.values(SECT_FORGE).some((f) => f.recipes.some((r) => r.mats[id]))

  /* 寶箱（秘境寶箱、萬寶令）開出的物品池：weight 越大越容易開到 */
  const LOOTBOX_POOL = [
    { item: 'stonePouch', weight: 20, min: 1, max: 2 },
    { item: 'hpPill', weight: 18, min: 2, max: 4 },
    { item: 'bigQi', weight: 14, min: 1, max: 3 },
    { item: 'huichun', weight: 10, min: 1, max: 2 },
    { item: 'kuangbao', weight: 8, min: 1, max: 2 },
    { item: 'jinzhong', weight: 8, min: 1, max: 2 },
    { item: 'spiritJade', weight: 8, min: 1, max: 2 },
    { item: 'ancientCoin', weight: 7, min: 1, max: 2 },
    { item: 'advancedFeed', weight: 6, min: 1, max: 2 },
    { item: 'xisui', weight: 5, min: 1, max: 1 },
    { item: 'pojing', weight: 4, min: 1, max: 1 },
    { item: 'jadePouch', weight: 4, min: 1, max: 1 },
    { item: 'starIron', weight: 3, min: 1, max: 1 },
    { item: 'zhuanggu', weight: 3, min: 1, max: 1 },
    { item: 'kaiqiao', weight: 3, min: 1, max: 1 },
    { item: 'ningshen', weight: 3, min: 1, max: 1 },
    { item: 'zhuanyun', weight: 3, min: 1, max: 1 },
    { item: 'cuiguDan', weight: 1, min: 1, max: 1 },
    { item: 'tongmingDan', weight: 1, min: 1, max: 1 },
    { item: 'tongshenDan', weight: 1, min: 1, max: 1 },
    { item: 'tianmingDan', weight: 1, min: 1, max: 1 },
    { item: 'ningyuan', weight: 1, min: 1, max: 1 },
    { item: 'dujie', weight: 1, min: 1, max: 1 },
  ]

  // ───── 秘境靈寵掉落（原 index.html）─────
  /* =========================================================
   * 秘境／狩獵地點：依境界解鎖
   * 新增地點：在陣列中加入一個物件。欄位：
   *   id、name、icon  地點識別、名稱、圖示
   *   reqRealm        需要的境界，對應 REALMS 陣列的索引（0=煉氣期即可進入，1=築基期…以此類推）
   *   ticket          門票價格（靈石）：每次進入該秘境要先購票，離開後再次進入須重新購票；不填或 0 = 免費
   *   desc            地點說明
   *   monsters        此地點可挑戰的怪物陣列，每筆欄位：
   *     id、name、icon      怪物識別、名稱、圖示
   *     hp                  氣血
   *     atkMin / atkMax     攻擊力區間
   *     exp                 擊敗後獲得的修為（經驗）
   *     loot                掉落表，陣列每筆為
   *                         { item: 道具id(需存在於 ITEMS), chance: 掉落機率(0~1), min, max: 掉落數量範圍 }
   * ========================================================= */
  const LOCATIONS = [
    {
      id: 'luoxiagu', name: '落霞谷', icon: '🍂', reqRealm: 0, ticket: 20,
      desc: '妖獸出沒的荒谷，適合煉氣期弟子歷練身手。',
      monsters: [
        { id: 'wolf', name: '赤血狼', icon: '🐺', hp: 60, atkMin: 4, atkMax: 9, exp: 18, loot: [{ item: 'beastHide', chance: 0.6, min: 1, max: 2 }, { item: 'spiritGrass', chance: 0.4, min: 1, max: 1 }, { item: 'wolfFang', chance: 0.5, min: 1, max: 2 }, { item: 'beastBlood', chance: 0.08, min: 1, max: 1 }] },
        { id: 'bat', name: '夜魘蝠', icon: '🦇', hp: 45, atkMin: 3, atkMax: 7, exp: 14, loot: [{ item: 'spiritGrass', chance: 0.5, min: 1, max: 2 }, { item: 'batWing', chance: 0.55, min: 1, max: 2 }, { item: 'soulFire', chance: 0.06, min: 1, max: 1 }] },
        { id: 'boar', name: '鐵甲野豬', icon: '🐗', hp: 90, atkMin: 6, atkMax: 12, exp: 28, loot: [{ item: 'beastHide', chance: 0.7, min: 1, max: 3 }, { item: 'demonCore', chance: 0.15, min: 1, max: 1 }, { item: 'beastBlood', chance: 0.2, min: 1, max: 1 }, { item: 'blackIron', chance: 0.12, min: 1, max: 1 }] },
      ],
    },
    {
      id: 'wanyao', name: '萬妖山脈', icon: '🏔️', reqRealm: 1, ticket: 100,
      desc: '妖氣濃郁的連綿山脈，築基期以上弟子方能全身而退。',
      monsters: [
        { id: 'tiger', name: '玄紋妖虎', icon: '🐯', hp: 160, atkMin: 12, atkMax: 20, exp: 55, loot: [{ item: 'demonCore', chance: 0.4, min: 1, max: 2 }, { item: 'beastHide', chance: 0.5, min: 1, max: 2 }, { item: 'tigerBone', chance: 0.35, min: 1, max: 1 }, { item: 'beastBlood', chance: 0.3, min: 1, max: 2 }] },
        { id: 'serpent', name: '赤焰蛟', icon: '🐍', hp: 220, atkMin: 16, atkMax: 26, exp: 75, loot: [{ item: 'demonCore', chance: 0.45, min: 1, max: 2 }, { item: 'jadeSlip', chance: 0.1, min: 1, max: 1 }, { item: 'snakeGall', chance: 0.35, min: 1, max: 1 }, { item: 'fireLotus', chance: 0.1, min: 1, max: 1 }, { item: 'dragonScale', chance: 0.04, min: 1, max: 1 }] },
        { id: 'golem', name: '岩甲傀儡', icon: '🗿', hp: 300, atkMin: 10, atkMax: 18, exp: 65, loot: [{ item: 'thunderCrystal', chance: 0.08, min: 1, max: 1 }, { item: 'beastHide', chance: 0.6, min: 2, max: 4 }, { item: 'blackIron', chance: 0.5, min: 1, max: 2 }, { item: 'golemCore', chance: 0.25, min: 1, max: 1 }, { item: 'spiritJade', chance: 0.15, min: 1, max: 1 }, { item: 'starIron', chance: 0.04, min: 1, max: 1 }] },
      ],
    },
    {
      id: 'taixu', name: '太虛幻境', icon: '🌌', reqRealm: 2, ticket: 400,
      desc: '虛實交錯的秘境，金丹期以上方可窺其堂奧。',
      monsters: [
        { id: 'phoenix', name: '赤羽幻鳳', icon: '🐦', hp: 480, atkMin: 28, atkMax: 42, exp: 160, loot: [{ item: 'thunderCrystal', chance: 0.25, min: 1, max: 2 }, { item: 'jadeSlip', chance: 0.3, min: 1, max: 1 }, { item: 'phoenixFeather', chance: 0.2, min: 1, max: 1 }, { item: 'fireLotus', chance: 0.3, min: 1, max: 1 }, { item: 'spiritJade', chance: 0.25, min: 1, max: 2 }] },
        { id: 'kraken', name: '深淵章鬼', icon: '🐙', hp: 560, atkMin: 24, atkMax: 38, exp: 150, loot: [{ item: 'jadeSlip', chance: 0.35, min: 1, max: 2 }, { item: 'inkPearl', chance: 0.25, min: 1, max: 1 }, { item: 'iceSilk', chance: 0.3, min: 1, max: 2 }, { item: 'soulFire', chance: 0.2, min: 1, max: 1 }, { item: 'starIron', chance: 0.06, min: 1, max: 1 }] },
      ],
    },
    {
      id: 'miwu', name: '迷霧沼澤', icon: '🌫️', reqRealm: 0, ticket: 25,
      desc: '終年瘴氣瀰漫的濕地，毒物遍布，卻也盛產靈草，適合初入道途者磨練。',
      monsters: [
        { id: 'toad', name: '毒瘴蟾', icon: '🐸', hp: 70, atkMin: 5, atkMax: 10, exp: 20, loot: [{ item: 'toadVenom', chance: 0.55, min: 1, max: 2 }, { item: 'spiritGrass', chance: 0.5, min: 1, max: 2 }, { item: 'beastBlood', chance: 0.06, min: 1, max: 1 }] },
        { id: 'leech', name: '泥沼水蛭', icon: '🪱', hp: 55, atkMin: 4, atkMax: 8, exp: 15, loot: [{ item: 'spiritGrass', chance: 0.55, min: 1, max: 2 }, { item: 'beastHide', chance: 0.3, min: 1, max: 1 }, { item: 'soulFire', chance: 0.04, min: 1, max: 1 }] },
        { id: 'croc', name: '沼澤鱷妖', icon: '🐊', hp: 120, atkMin: 8, atkMax: 14, exp: 36, loot: [{ item: 'crocScale', chance: 0.6, min: 1, max: 2 }, { item: 'demonCore', chance: 0.15, min: 1, max: 1 }, { item: 'blackIron', chance: 0.12, min: 1, max: 1 }, { item: 'beastBlood', chance: 0.15, min: 1, max: 1 }] },
      ],
    },
    {
      id: 'youming', name: '幽冥鬼域', icon: '🪦', reqRealm: 1, ticket: 120,
      desc: '陰風慘慘的亂葬荒原，遊魂白骨徘徊不去，築基期以上方敢涉足。',
      monsters: [
        { id: 'wraith', name: '遊魂', icon: '👻', hp: 190, atkMin: 14, atkMax: 22, exp: 60, loot: [{ item: 'soulFire', chance: 0.35, min: 1, max: 1 }, { item: 'ghostJade', chance: 0.08, min: 1, max: 1 }, { item: 'jadeSlip', chance: 0.08, min: 1, max: 1 }] },
        { id: 'skeleton', name: '白骨衛士', icon: '💀', hp: 260, atkMin: 12, atkMax: 20, exp: 70, loot: [{ item: 'boneShard', chance: 0.5, min: 1, max: 2 }, { item: 'blackIron', chance: 0.4, min: 1, max: 2 }, { item: 'ancientCoin', chance: 0.1, min: 1, max: 1 }] },
        { id: 'ghoul', name: '血屍', icon: '🧟', hp: 340, atkMin: 16, atkMax: 24, exp: 88, loot: [{ item: 'demonCore', chance: 0.4, min: 1, max: 2 }, { item: 'ghostJade', chance: 0.2, min: 1, max: 1 }, { item: 'beastBlood', chance: 0.35, min: 1, max: 2 }, { item: 'soulFire', chance: 0.2, min: 1, max: 1 }] },
      ],
    },
    {
      id: 'fentian', name: '焚天火山', icon: '🌋', reqRealm: 2, ticket: 450,
      desc: '地火噴湧、岩漿奔流的絕地，唯有金丹期的護體靈力才撐得住酷熱。',
      monsters: [
        { id: 'lizard', name: '熔岩蜥', icon: '🦎', hp: 353, atkMin: 33, atkMax: 44, exp: 107, loot: [{ item: 'lavaCore', chance: 0.2, min: 1, max: 1 }, { item: 'fireLotus', chance: 0.3, min: 1, max: 1 }, { item: 'spiritJade', chance: 0.2, min: 1, max: 2 }, { item: 'starIron', chance: 0.05, min: 1, max: 1 }] },
        { id: 'lion', name: '烈焰獅', icon: '🦁', hp: 409, atkMin: 32, atkMax: 44, exp: 118, loot: [{ item: 'lionMane', chance: 0.45, min: 1, max: 2 }, { item: 'fireLotus', chance: 0.3, min: 1, max: 1 }, { item: 'thunderCrystal', chance: 0.15, min: 1, max: 1 }, { item: 'phoenixFeather', chance: 0.08, min: 1, max: 1 }] },
      ],
    },
    {
      id: 'jiuyouice', name: '九幽冰原', icon: '❄️', reqRealm: 3, ticket: 1200,
      desc: '極北寒域，冰風蝕骨。元嬰期修士方能以元神抵禦刺骨寒意。',
      monsters: [
        { id: 'snowleopard', name: '霜牙雪豹', icon: '🐆', hp: 537, atkMin: 22, atkMax: 30, exp: 152, loot: [{ item: 'iceSilk', chance: 0.4, min: 1, max: 2 }, { item: 'frostCrystal', chance: 0.1, min: 1, max: 1 }, { item: 'inkPearl', chance: 0.12, min: 1, max: 1 }, { item: 'starIron', chance: 0.08, min: 1, max: 1 }] },
        { id: 'icebear', name: '冰晶巨熊', icon: '🐻‍❄️', hp: 632, atkMin: 24, atkMax: 32, exp: 174, loot: [{ item: 'frostCrystal', chance: 0.18, min: 1, max: 1 }, { item: 'iceSilk', chance: 0.35, min: 1, max: 2 }, { item: 'dragonScale', chance: 0.08, min: 1, max: 1 }, { item: 'jadeSlip', chance: 0.3, min: 1, max: 2 }] },
      ],
    },
    {
      id: 'jiutianlei', name: '九天雷澤', icon: '⚡', reqRealm: 4, ticket: 2500,
      desc: '雷霆終日不歇的天外澤國，化神期修士才能在雷罰中立足。',
      monsters: [
        { id: 'thunderhawk', name: '雷翼鷹', icon: '🦅', hp: 617, atkMin: 25, atkMax: 33, exp: 218, loot: [{ item: 'thunderCrystal', chance: 0.4, min: 1, max: 2 }, { item: 'thunderEssence', chance: 0.12, min: 1, max: 1 }, { item: 'phoenixFeather', chance: 0.12, min: 1, max: 1 }, { item: 'starIron', chance: 0.1, min: 1, max: 1 }] },
        { id: 'thunderrhino', name: '雷霆犀', icon: '🦏', hp: 720, atkMin: 26, atkMax: 35, exp: 251, loot: [{ item: 'thunderEssence', chance: 0.2, min: 1, max: 1 }, { item: 'thunderCrystal', chance: 0.35, min: 1, max: 2 }, { item: 'dragonScale', chance: 0.12, min: 1, max: 1 }, { item: 'ningyuan', chance: 0.015, min: 1, max: 1 }] },
      ],
    },
    {
      id: 'hundunvoid', name: '混沌虛空', icon: '🕳️', reqRealm: 5, ticket: 5000,
      desc: '天地未分的混沌夾縫，法則錯亂。渡劫期大能方可窺其一隅。',
      monsters: [
        { id: 'voideye', name: '虛空之眼', icon: '👁️', hp: 693, atkMin: 27, atkMax: 37, exp: 316, loot: [{ item: 'voidPearl', chance: 0.15, min: 1, max: 1 }, { item: 'chaosShard', chance: 0.2, min: 1, max: 1 }, { item: 'inkPearl', chance: 0.3, min: 1, max: 2 }, { item: 'starIron', chance: 0.15, min: 1, max: 1 }] },
        { id: 'shadow', name: '混沌魔影', icon: '🌑', hp: 802, atkMin: 29, atkMax: 39, exp: 364, loot: [{ item: 'chaosShard', chance: 0.3, min: 1, max: 2 }, { item: 'voidPearl', chance: 0.12, min: 1, max: 1 }, { item: 'thunderEssence', chance: 0.15, min: 1, max: 1 }, { item: 'dujie', chance: 0.02, min: 1, max: 1 }] },
      ],
    },
    {
      id: 'shangguxu', name: '上古神墟', icon: '🏛️', reqRealm: 6, ticket: 9000,
      desc: '上古大戰後遺留的神魔廢墟，唯有大乘期至尊敢踏入，亦是世間機緣所在。',
      monsters: [
        { id: 'guardian', name: '神墟守衛', icon: '🛡️', hp: 765, atkMin: 30, atkMax: 40, exp: 463, loot: [{ item: 'ancientRelic', chance: 0.15, min: 1, max: 1 }, { item: 'chaosShard', chance: 0.25, min: 1, max: 2 }, { item: 'frostCrystal', chance: 0.2, min: 1, max: 1 }, { item: 'treasureBox', chance: 0.08, min: 1, max: 1 }] },
        { id: 'emperor', name: '太古妖皇', icon: '👹', hp: 918, atkMin: 30, atkMax: 41, exp: 532, loot: [{ item: 'ancientRelic', chance: 0.3, min: 1, max: 1 }, { item: 'voidPearl', chance: 0.2, min: 1, max: 1 }, { item: 'divineFeed', chance: 0.05, min: 1, max: 1 }, { item: 'ningyuan', chance: 0.03, min: 1, max: 1 }, { item: 'dujie', chance: 0.03, min: 1, max: 1 }] },
      ],
    },
    // ↑ 在這裡繼續加新地點，記得 reqRealm 對應 REALMS 的索引
  ]

  /* =========================================================
   * 靈寵系統
   * PET_GRADES：靈獸蛋品階
   *   minRealm / maxRealm  孵化時的初始境界範圍（REALMS 索引；越高的境界機率越低）
   *   cap                  資質上限：靈寵最高可修煉到的境界（到該境界第九層即圓滿）
   * PET_TEMPLATES：靈寵模板，加一筆就多一種靈寵。欄位：
   *   id、name、icon  識別、名稱、圖示
   *   grade           品階，對應 PET_GRADES 的 key（決定由哪種蛋孵出）
   *   atk             攻擊倍率（出戰時協同攻擊的傷害）
   *   desc            說明
   * ========================================================= */
  const PET_GRADES = {
    common:   { label: '凡品', color: 'var(--muted-fg)', minRealm: 0, maxRealm: 1, cap: 1 }, // 煉氣～築基，上限築基
    advanced: { label: '靈品', color: 'var(--primary)', minRealm: 2, maxRealm: 3, cap: 3 },  // 金丹～元嬰，上限元嬰
    divine:   { label: '神品', color: 'var(--accent)', minRealm: 4, maxRealm: 6, cap: 6 },   // 化神～大乘，上限大乘
  }
  const PET_TEMPLATES = [
    { id: 'rabbit', name: '玉兔', icon: '🐇', grade: 'common', atk: 0.9, desc: '月下靈兔，性情溫馴，善於尋覓靈草。' },
    { id: 'fox', name: '赤狐', icon: '🦊', grade: 'common', atk: 1.0, desc: '狡黠靈狐，擅使幻術迷惑敵人。' },
    { id: 'sparrow', name: '青羽雀', icon: '🐦', grade: 'common', atk: 0.95, desc: '羽色青碧，鳴聲可清心寧神。' },
    { id: 'frog', name: '金蟾', icon: '🐸', grade: 'common', atk: 0.85, desc: '口吐金霧，傳說能招財納福。' },
    { id: 'lynx', name: '山猞', icon: '🐈', grade: 'common', atk: 1.05, desc: '山林間的靈貓，身手矯健。' },
    { id: 'snowwolf', name: '雪狼王', icon: '🐺', grade: 'advanced', atk: 1.2, desc: '北原狼群之主，寒氣凝爪。' },
    { id: 'roc', name: '金翅鵬', icon: '🦅', grade: 'advanced', atk: 1.3, desc: '一翼九萬里，雙爪可裂金石。' },
    { id: 'python', name: '碧鱗蟒', icon: '🐍', grade: 'advanced', atk: 1.25, desc: '鱗甲如碧玉，毒牙穿心。' },
    { id: 'marten', name: '紫電貂', icon: '🦡', grade: 'advanced', atk: 1.25, desc: '來去如紫電，專噬敵之靈力。' },
    { id: 'azure', name: '青龍', icon: '🐉', grade: 'divine', atk: 1.6, desc: '東方神獸，行雲布雨，威懾萬靈。' },
    { id: 'whitetiger', name: '白虎', icon: '🐅', grade: 'divine', atk: 1.65, desc: '西方神獸，主殺伐，金氣凜然。' },
    { id: 'vermilion', name: '朱雀', icon: '🔥', grade: 'divine', atk: 1.6, desc: '南方神獸，浴火不滅，焚盡邪祟。' },
    { id: 'tortoise', name: '玄武', icon: '🐢', grade: 'divine', atk: 1.5, desc: '北方神獸，龜蛇合體，萬法難侵。' },
    { id: 'qilin', name: '麒麟', icon: '🦄', grade: 'divine', atk: 1.7, desc: '祥瑞之首，踏火而行，福澤主人。' },
    // ↑ 在這裡繼續加新靈寵，grade 決定由哪種蛋孵出
  ]
  const MAX_PETS = 12 // 最多可同時擁有的靈寵數

  /* 靈寵蛋 / 飼料掉落設定（chance = 機率 0~1） */
  // 秘境：所有地點的每隻妖獸都會加上這份掉落表
  // minRealm：只有解鎖境界（reqRealm）≥ 此值的秘境才會掉（0 煉氣…），低階地圖不掉高價值物品
  const REALM_PET_LOOT = [
    { item: 'advancedEgg', chance: 0.003, min: 1, max: 1, minRealm: 1 },
    { item: 'advancedFeed', chance: 0.05, min: 1, max: 2 },
  ]
  // 世界王：每次出手由「伺服器」判定一次（只用來顯示說明；實際機率在 server.js，兩邊要一起改），境界須達 BOSS_LOOT_MIN_REALM
  const BOSS_LOOT_MIN_REALM = 3
  const BOSS_PET_LOOT = [
    { item: 'divineEgg', chance: 0.001, min: 1, max: 1 },
    { item: 'divineFeed', chance: 0.005, min: 1, max: 1 },
    { item: 'wuxingDan', chance: 0.0005, min: 1, max: 1 },
  ]
  // 秘境：所有妖獸共通的稀有掉落（錦囊、寶箱、丹藥）
  const REALM_COMMON_LOOT = [
    { item: 'stonePouch', chance: 0.02, min: 1, max: 1 },
    { item: 'ancientCoin', chance: 0.015, min: 1, max: 1, minRealm: 1 },
    { item: 'treasureBox', chance: 0.005, min: 1, max: 1, minRealm: 1 },
    { item: 'hpPill', chance: 0.04, min: 1, max: 1 },
    { item: 'kuangbao', chance: 0.015, min: 1, max: 1 },
    { item: 'jinzhong', chance: 0.015, min: 1, max: 1 },
    { item: 'wudaoTea', chance: 0.005, min: 1, max: 1, minRealm: 1 },
    { item: 'lingzhi', chance: 0.003, min: 1, max: 1, minRealm: 2 },
    { item: 'beastPill', chance: 0.02, min: 1, max: 1 },
    { item: 'jadePouch', chance: 0.003, min: 1, max: 1, minRealm: 1 },
    { item: 'pojing', chance: 0.003, min: 1, max: 1, minRealm: 1 },
    { item: 'zhuanggu', chance: 0.002, min: 1, max: 1, minRealm: 1 },
    { item: 'kaiqiao', chance: 0.002, min: 1, max: 1, minRealm: 1 },
    { item: 'ningshen', chance: 0.002, min: 1, max: 1, minRealm: 1 },
    { item: 'zhuanyun', chance: 0.002, min: 1, max: 1, minRealm: 1 },
    { item: 'cuiguDan', chance: 0.0005, min: 1, max: 1, minRealm: 2 },
    { item: 'tongmingDan', chance: 0.0005, min: 1, max: 1, minRealm: 2 },
    { item: 'tongshenDan', chance: 0.0005, min: 1, max: 1, minRealm: 2 },
    { item: 'tianmingDan', chance: 0.0005, min: 1, max: 1, minRealm: 2 },
  ]
  /* 煉器材料掉落：依秘境加進該地所有妖獸的掉落表（chance = 機率 0~1） */
  const LOCATION_FORGE_LOOT = {
    luoxiagu: [{ item: 'forgeCoal', chance: 0.35, min: 1, max: 2 }, { item: 'pigIron', chance: 0.2, min: 1, max: 2 }],
    miwu: [{ item: 'forgeCoal', chance: 0.3, min: 1, max: 2 }, { item: 'pigIron', chance: 0.15, min: 1, max: 2 }, { item: 'spiritSand', chance: 0.05, min: 1, max: 1 }],
    wanyao: [{ item: 'forgeCoal', chance: 0.3, min: 1, max: 2 }, { item: 'pigIron', chance: 0.3, min: 1, max: 2 }, { item: 'steelIngot', chance: 0.12, min: 1, max: 1 }, { item: 'spiritSand', chance: 0.08, min: 1, max: 1 }],
    youming: [{ item: 'forgeCoal', chance: 0.2, min: 1, max: 2 }, { item: 'steelIngot', chance: 0.12, min: 1, max: 1 }, { item: 'spiritSand', chance: 0.12, min: 1, max: 1 }],
    taixu: [{ item: 'steelIngot', chance: 0.12, min: 1, max: 1 }, { item: 'spiritSand', chance: 0.15, min: 1, max: 2 }, { item: 'fireCrystal', chance: 0.04, min: 1, max: 1 }],
    fentian: [{ item: 'steelIngot', chance: 0.12, min: 1, max: 1 }, { item: 'fireCrystal', chance: 0.1, min: 1, max: 1 }, { item: 'spiritSand', chance: 0.1, min: 1, max: 1 }],
    jiuyouice: [{ item: 'steelIngot', chance: 0.1, min: 1, max: 1 }, { item: 'iceIronEssence', chance: 0.1, min: 1, max: 1 }, { item: 'spiritSand', chance: 0.1, min: 1, max: 1 }],
    jiutianlei: [{ item: 'steelIngot', chance: 0.1, min: 1, max: 1 }, { item: 'thunderWood', chance: 0.1, min: 1, max: 1 }, { item: 'skyGold', chance: 0.03, min: 1, max: 1 }],
    hundunvoid: [{ item: 'skyGold', chance: 0.08, min: 1, max: 1 }, { item: 'thunderWood', chance: 0.08, min: 1, max: 1 }],
    shangguxu: [{ item: 'skyGold', chance: 0.12, min: 1, max: 1 }, { item: 'divineForgeStone', chance: 0.04, min: 1, max: 1 }],
  }
  LOCATIONS.sort((a, b) => a.reqRealm - b.reqRealm) // 依解鎖境界排序
  /* 妖獸成長：玩家氣血上限隨境界提高，妖獸數值也要跟著放大。
   * 以「該秘境解鎖境界、第一層」的氣血上限相對起始值的倍率 k 為基準：
   *   攻擊 × (1 + (k-1) × MON_ATK_GROW)　氣血 × (1 + (k-1) × MON_HP_GROW)　修為 × 氣血倍率
   * 上面 LOCATIONS 內寫的是基礎值，實際數值在這裡換算（介面顯示的是換算後的數字）。 */
  const MON_ATK_GROW = 0.85, MON_HP_GROW = 0.25
  LOCATIONS.forEach((loc) => {
    const k = hpAt(loc.reqRealm, 1) / BASE_HP
    const ka = 1 + (k - 1) * MON_ATK_GROW, kh = 1 + (k - 1) * MON_HP_GROW
    loc.monsters.forEach((m) => {
      m.hp = Math.round(m.hp * kh); m.exp = Math.round(m.exp * kh)
      m.atkMin = Math.round(m.atkMin * ka); m.atkMax = Math.round(m.atkMax * ka)
    })
  })
  LOCATIONS.forEach((loc) => loc.monsters.forEach((m) => m.loot.push(...[...REALM_PET_LOOT, ...REALM_COMMON_LOOT].filter((e) => (e.minRealm || 0) <= loc.reqRealm), ...(LOCATION_FORGE_LOOT[loc.id] || []))))

  // ───── 宗門（原 index.html）─────
  /* =========================================================
   * 宗門系統
   * 加入宗門即獲得宗門特色狀態（bonuses）；完成宗門任務得貢獻，貢獻可在宗門寶庫兌換該宗專屬天材地寶。
   * 離開宗門（或改投他派）貢獻值歸零、進行中的任務作廢。
   *
   * SECT_ALIGNS：陣營（顯示分組與顏色）
   * BONUS_TYPES：宗門特色狀態的種類（數值已實際串接到遊戲邏輯）
   *   atk 攻擊%｜hp 氣血上限%（僅裝備提供）｜def 受到傷害減免%｜cultivate 運功/閉關修為%｜breakthrough 突破機率(加算)
   *   mpRegen 每息靈力回復｜hpRegen 每息氣血回復｜pill 丹藥效果%｜lifesteal 擊殺回復氣血上限%
   *   loot 秘境掉落機率%｜exp 擊殺修為%｜petAtk 靈寵攻擊%｜petXp 靈寵修為獲取%
   *   sell 出售價格%｜discount 交易所購買折扣%
   * SECTS 欄位：
   *   id（英文字母）、name、align（SECT_ALIGNS 的 key）、master 掌門、desc
   *   bonuses   [{ type, value }]
   *   shop      宗門寶庫 [{ item: 道具 id, cost: 貢獻 }]
   *   quests    宗門任務（可重複接）：
   *             { id（英文字母，≤18 字）, name, desc, type: 'kill', monster: 怪物 id, qty, reward }
   *             { id, name, desc, type: 'submit', item: 道具 id, qty, reward }
   *             reward = { contribution, stones?, xp?(當前層修為比例) }
   *             cd = 完成（交付）後的冷卻時間，單位「分鐘」，冷卻中不能再接取／上交（以伺服器時間計算，下線也照常倒數）
   * ========================================================= */
  const SECT_ALIGNS = {
    righteous: { label: '正道', color: 'var(--primary)' },
    evil: { label: '邪道', color: 'var(--destructive)' },
    beast: { label: '靈獸', color: 'oklch(0.78 0.13 130)' },
    neutral: { label: '中立', color: 'var(--accent)' },
  }
  const BONUS_TYPES = {
    atk: (v) => `攻擊 +${Math.round(v * 100)}%`,
    hp: (v) => `氣血上限 +${Math.round(v * 100)}%`,
    def: (v) => `受到傷害 -${Math.round(v * 100)}%`,
    cultivate: (v) => `修煉速度 +${Math.round(v * 100)}%`,
    breakthrough: (v) => `突破機率 +${Math.round(v * 100)}%`,
    mpRegen: (v) => `靈力回復 +${v}/息`,
    hpRegen: (v) => `氣血回復 +${v}/息`,
    pill: (v) => `丹藥效果 +${Math.round(v * 100)}%`,
    lifesteal: (v) => `擊殺妖獸回復 ${Math.round(v * 100)}% 氣血`,
    loot: (v) => `秘境掉落機率 +${Math.round(v * 100)}%`,
    exp: (v) => `擊殺修為 +${Math.round(v * 100)}%`,
    petAtk: (v) => `靈寵攻擊 +${Math.round(v * 100)}%`,
    petXp: (v) => `靈寵修為獲取 +${Math.round(v * 100)}%`,
    sell: (v) => `出售價格 +${Math.round(v * 100)}%`,
    discount: (v) => `交易所購買 -${Math.round(v * 100)}%`,
  }
  const SECTS = [
    // ── 正道 ──
    {
      id: 'qingyun', name: '青雲劍宗', align: 'righteous', master: '玄真子',
      desc: '正道劍修魁首，一劍光寒十九州，弟子以斬妖除魔為己任。',
      bonuses: [{ type: 'atk', value: 0.1 }, { type: 'breakthrough', value: 0.03 }],
      shop: [{ item: 'jianxinStone', cost: 300 }, { item: 'qingmingPill', cost: 500 }, { item: 'wanjianSlip', cost: 800 }],
      quests: [
        { id: 'qyWolf', name: '斬妖除魔', desc: '落霞谷赤血狼傷及山民，前往斬殺。', type: 'kill', monster: 'wolf', qty: 5, cd: 20, reward: { contribution: 10, stones: 100 } },
        { id: 'qyIron', name: '鑄劍之材', desc: '劍閣需玄鐵重鑄弟子佩劍。', type: 'submit', item: 'blackIron', qty: 3, cd: 20, reward: { contribution: 15 } },
        { id: 'qyTiger', name: '試劍萬妖山', desc: '以妖虎磨礪劍意。', type: 'kill', monster: 'tiger', qty: 3, cd: 40, reward: { contribution: 25, xp: 0.2 } },
        { id: 'qyStar', name: '星辰劍胚', desc: '掌門欲以天外隕鐵煉製鎮宗飛劍。', type: 'submit', item: 'starIron', qty: 1, cd: 120, reward: { contribution: 45 } },
      ],
    },
    {
      id: 'xuantian', name: '玄天道宮', align: 'righteous', master: '太虛真人',
      desc: '道門正統，講究清靜無為、吐納天地，修行之速冠絕天下。',
      bonuses: [{ type: 'cultivate', value: 0.2 }, { type: 'mpRegen', value: 1 }],
      shop: [{ item: 'taiqingDew', cost: 300 }, { item: 'xuantianFruit', cost: 700 }, { item: 'zifuTalisman', cost: 900 }],
      quests: [
        { id: 'xtGrass', name: '採藥童子', desc: '為丹房採集靈草。', type: 'submit', item: 'spiritGrass', qty: 5, cd: 20, reward: { contribution: 10 } },
        { id: 'xtBat', name: '驅散夜魘', desc: '夜魘蝠擾人清修，前往驅除。', type: 'kill', monster: 'bat', qty: 6, cd: 20, reward: { contribution: 10, stones: 80 } },
        { id: 'xtJade', name: '護山大陣', desc: '大陣靈玉耗損，需補充。', type: 'submit', item: 'spiritJade', qty: 2, cd: 40, reward: { contribution: 25 } },
        { id: 'xtKraken', name: '鎮壓章鬼', desc: '太虛幻境深淵章鬼作亂。', type: 'kill', monster: 'kraken', qty: 2, cd: 120, reward: { contribution: 50, xp: 0.3 } },
      ],
    },
    {
      id: 'danding', name: '丹鼎谷', align: 'righteous', master: '藥王孫思玄',
      desc: '天下丹道之源，谷中丹爐千年不熄，懸壺濟世。',
      bonuses: [{ type: 'pill', value: 0.3 }, { type: 'hpRegen', value: 2 }],
      shop: [{ item: 'baicaoMarrow', cost: 300 }, { item: 'jiuzhuanPill', cost: 900 }, { item: 'zaohuaPill', cost: 800 }],
      quests: [
        { id: 'ddGrass', name: '百草入爐', desc: '丹房缺靈草煉製回氣丹。', type: 'submit', item: 'spiritGrass', qty: 8, cd: 20, reward: { contribution: 15 } },
        { id: 'ddCore', name: '妖丹藥引', desc: '以妖丹為藥引煉製培元丹。', type: 'submit', item: 'demonCore', qty: 3, cd: 40, reward: { contribution: 20 } },
        { id: 'ddSnake', name: '取膽入藥', desc: '獵殺赤焰蛟取其蛇膽。', type: 'kill', monster: 'serpent', qty: 3, cd: 60, reward: { contribution: 30, stones: 200 } },
        { id: 'ddLotus', name: '地火金蓮', desc: '谷主閉關煉丹，需火蓮為引。', type: 'submit', item: 'fireLotus', qty: 2, cd: 60, reward: { contribution: 30 } },
      ],
    },
    {
      id: 'jingang', name: '金剛寺', align: 'righteous', master: '了塵大師',
      desc: '佛門體修聖地，金身不壞，以慈悲心降妖伏魔。',
      bonuses: [{ type: 'def', value: 0.15 }, { type: 'hpRegen', value: 2 }],
      shop: [{ item: 'sheli', cost: 300 }, { item: 'bodhiSeed', cost: 500 }, { item: 'budongTalisman', cost: 800 }],
      quests: [
        { id: 'jgBoar', name: '護田降豬', desc: '鐵甲野豬毀壞寺田。', type: 'kill', monster: 'boar', qty: 5, cd: 20, reward: { contribution: 15, stones: 100 } },
        { id: 'jgHide', name: '縫製僧袍', desc: '為弟子縫製禦寒僧袍。', type: 'submit', item: 'beastHide', qty: 6, cd: 20, reward: { contribution: 10 } },
        { id: 'jgGolem', name: '破傀儡陣', desc: '萬妖山脈岩甲傀儡擋住朝聖之路。', type: 'kill', monster: 'golem', qty: 3, cd: 60, reward: { contribution: 30, xp: 0.2 } },
        { id: 'jgCoin', name: '古剎香火', desc: '收集上古銅錢重修古剎。', type: 'submit', item: 'ancientCoin', qty: 2, cd: 60, reward: { contribution: 30 } },
      ],
    },
    // ── 邪道 ──
    {
      id: 'xuesha', name: '血煞宗', align: 'evil', master: '血屠老祖',
      desc: '以殺證道的魔門，越戰越勇，飲血療傷。',
      bonuses: [{ type: 'atk', value: 0.15 }, { type: 'lifesteal', value: 0.08 }],
      shop: [{ item: 'bloodSoulBead', cost: 300 }, { item: 'xueshaEssence', cost: 560 }, { item: 'huaxuePill', cost: 400 }],
      quests: [
        { id: 'xsWolf', name: '血祭', desc: '以狼血祭煉血旗。', type: 'kill', monster: 'wolf', qty: 8, cd: 20, reward: { contribution: 15, stones: 120 } },
        { id: 'xsBlood', name: '精血供奉', desc: '上交妖獸精血供老祖修煉。', type: 'submit', item: 'beastBlood', qty: 3, cd: 40, reward: { contribution: 25 } },
        { id: 'xsBone', name: '白骨魔座', desc: '以虎骨打造魔座。', type: 'submit', item: 'tigerBone', qty: 2, cd: 40, reward: { contribution: 20 } },
        { id: 'xsPhoenix', name: '獵鳳', desc: '奪幻鳳真血煉製血魂珠。', type: 'kill', monster: 'phoenix', qty: 2, cd: 120, reward: { contribution: 50, xp: 0.3 } },
      ],
    },
    {
      id: 'wandu', name: '萬毒門', align: 'evil', master: '毒仙子',
      desc: '精於毒術蠱道，手段詭譎難防，搜刮天下奇物。',
      bonuses: [{ type: 'atk', value: 0.08 }, { type: 'loot', value: 0.2 }],
      shop: [{ item: 'guKing', cost: 400 }, { item: 'biXuePill', cost: 520 }, { item: 'wuduBead', cost: 400 }],
      quests: [
        { id: 'wdBat', name: '收集毒源', desc: '夜魘蝠體內毒腺可煉蠱。', type: 'kill', monster: 'bat', qty: 6, cd: 20, reward: { contribution: 10, stones: 80 } },
        { id: 'wdWing', name: '蝠翼毒粉', desc: '上交蝠翼研磨毒粉。', type: 'submit', item: 'batWing', qty: 4, cd: 20, reward: { contribution: 15 } },
        { id: 'wdGall', name: '蛇膽煉蠱', desc: '以蛇膽餵養蠱王。', type: 'submit', item: 'snakeGall', qty: 2, cd: 40, reward: { contribution: 25 } },
        { id: 'wdSerpent', name: '毒蛟之爭', desc: '赤焰蛟佔據毒潭，前往剿滅。', type: 'kill', monster: 'serpent', qty: 3, cd: 60, reward: { contribution: 30, xp: 0.2 } },
      ],
    },
    {
      id: 'youming', name: '幽冥殿', align: 'evil', master: '冥河鬼帝',
      desc: '鬼道魂修，掌生死輪迴之秘，吞噬魂魄精進修為。',
      bonuses: [{ type: 'exp', value: 0.25 }, { type: 'breakthrough', value: 0.05 }],
      shop: [{ item: 'ghostFire', cost: 900 }, { item: 'samsaraFruit', cost: 800 }, { item: 'soulBanner', cost: 360 }],
      quests: [
        { id: 'ymBat', name: '收魂', desc: '收取夜魘蝠殘魂。', type: 'kill', monster: 'bat', qty: 8, cd: 20, reward: { contribution: 15, stones: 100 } },
        { id: 'ymSlip', name: '殘卷尋蹤', desc: '尋回失落的鬼道玉簡。', type: 'submit', item: 'jadeSlip', qty: 1, cd: 40, reward: { contribution: 20 } },
        { id: 'ymSoul', name: '冥火燃燈', desc: '上交幽魂火點燃引魂燈。', type: 'submit', item: 'soulFire', qty: 2, cd: 60, reward: { contribution: 30 } },
        { id: 'ymKraken', name: '深淵噬魂', desc: '吞噬深淵章鬼之魂。', type: 'kill', monster: 'kraken', qty: 2, cd: 120, reward: { contribution: 50, xp: 0.3 } },
      ],
    },
    // ── 靈獸宗 ──
    {
      id: 'yushou', name: '萬獸山莊', align: 'beast', master: '百獸真君',
      desc: '御獸一脈，與靈獸同修共生，獸寵戰力冠絕修仙界。',
      bonuses: [{ type: 'petAtk', value: 0.3 }, { type: 'petXp', value: 0.5 }],
      shop: [{ item: 'beastSoul', cost: 240 }, { item: 'dragonBlood', cost: 800 }, { item: 'yushouRing', cost: 300 }, { item: 'advancedEgg', cost: 1000 }],
      quests: [
        { id: 'ysHide', name: '獸欄修繕', desc: '上交靈獸皮修繕獸欄。', type: 'submit', item: 'beastHide', qty: 5, cd: 20, reward: { contribution: 10 } },
        { id: 'ysBlood', name: '精血育獸', desc: '以妖獸精血餵養幼獸。', type: 'submit', item: 'beastBlood', qty: 2, cd: 40, reward: { contribution: 20 } },
        { id: 'ysTiger', name: '降服妖虎', desc: '擊敗玄紋妖虎，挫其凶性。', type: 'kill', monster: 'tiger', qty: 3, cd: 40, reward: { contribution: 25, stones: 150 } },
        { id: 'ysFeather', name: '鳳羽為信', desc: '取得鳳羽，與鳳族結盟。', type: 'submit', item: 'phoenixFeather', qty: 1, cd: 120, reward: { contribution: 45 } },
      ],
    },
    // ── 中立 ──
    {
      id: 'wanbao', name: '萬寶商盟', align: 'neutral', master: '金算盤錢百通',
      desc: '不問正邪、只論買賣的中立商盟，財可通神。',
      bonuses: [{ type: 'sell', value: 0.2 }, { type: 'discount', value: 0.15 }],
      shop: [{ item: 'cornucopia', cost: 300 }, { item: 'goldToad', cost: 500 }, { item: 'wanbaoToken', cost: 400 }],
      quests: [
        { id: 'wbHide', name: '皮貨收購', desc: '商盟大量收購靈獸皮。', type: 'submit', item: 'beastHide', qty: 10, cd: 40, reward: { contribution: 20, stones: 150 } },
        { id: 'wbBoar', name: '護送商隊', desc: '清除商路上的鐵甲野豬。', type: 'kill', monster: 'boar', qty: 4, cd: 20, reward: { contribution: 15, stones: 200 } },
        { id: 'wbCoin', name: '古錢鑑寶', desc: '上交上古銅錢供鑑寶閣研究。', type: 'submit', item: 'ancientCoin', qty: 3, cd: 60, reward: { contribution: 30 } },
        { id: 'wbPearl', name: '奇珍異寶', desc: '貴客高價求購墨珠。', type: 'submit', item: 'inkPearl', qty: 1, cd: 120, reward: { contribution: 35, stones: 300 } },
      ],
    },
    // ↑ 在這裡繼續加新宗門
  ]
  const MAX_ACTIVE_QUESTS = 3 // 擊殺任務最多同時接取數
  const QUEST_CD_KEY = 'zqqcd'   // 任務冷卻存檔：key = 'zqqcd' + 任務 id，value = 可再次承接的時間（伺服器時間，分鐘）

  // ───── 修為減速（原 index.html）─────
  const XP_SLOW_BASE = 5

  // ───── 修為減速（原 index.html）─────
  const XP_SLOW_PER_LEVEL = 0.1

  // ───── 魔蛟招式（原 index.html）─────
  const BOSS_SKILLS = [
    { name: '蛟尾橫掃', w: 55, mul: 1.0 },
    { name: '噬魂利爪', w: 25, mul: 1.4 },
    { name: '滅世龍息', w: 12, mul: 2.2 },
    { name: '蛟嘯震魂', w: 8, mul: 0.6, mp: 20 },
  ]

  // ───── const BOSS_DMG_PCT =（原 index.html）─────
  const BOSS_DMG_PCT = [0.08, 0.13] // 基礎傷害 = 你的氣血上限的 8%～13%（再乘招式倍率、狂暴倍率）

  // ───── const BOSS_MIN_HP_RATIO =（原 index.html）─────
  const BOSS_MIN_HP_RATIO = 0.25              // 氣血低於此比例，不可再向世界王出手

  // ───── const SECLUDE_COST =（原 index.html）─────
  const SECLUDE_COST = 2 // 閉關每息消耗靈石的基礎值（GM 免費）；實際成本隨等級增加，見 secludeCost()

  // ───── const REGEN_SCALE =（原 index.html）─────
  const REGEN_SCALE = 0.2


  /* =====================================================================
   * 規則（純函式）：s = 一位玩家的存檔
   * 伺服器用這些函式「計算並保存」結果；前端只用來顯示（例如顯示氣血上限、突破機率）。
   * 所有會改變存檔的動作都在下面的 ACTIONS，只會在伺服器上執行。
   * ===================================================================== */
  const SAVE_FMT = 2                       // 存檔格式版本（2 = 伺服器權威版）
  const OFFLINE_TICK_CAP = 60              // 太久沒連線時，最多補算幾息（避免離線也一直閉關、回血）
  const STATE_KEYS = ['realm', 'layer', 'xp', 'hp', 'mp', 'stones', 'jade', 'inventory', 'sect', 'contribution', 'attrs', 'learned', 'quests', 'questCd', 'buffs', 'breakBonus', 'cooldowns', 'pets', 'activePet', 'equipped', 'secluded', 'selectedLocation', 'battle']

  const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
  const fail = (msg) => { const e = new Error(msg); e.game = true; throw e }
  const log = (out, text, tone = 'normal') => { if (out) out.push([text, tone]) }

  /* ---------- 基礎計算 ---------- */
  const lv = (s) => lvIdx(s.realm, s.layer)
  const statPts = (s, k) => Math.min(STAT_CAP, (s.attrs && s.attrs[k]) || 0)
  const statBonus = (s, k) => statPts(s, k) * STAT_META[k].per
  const gearBonus = (s, type) => Object.values(s.equipped || {}).reduce((sum, id) => { const e = ITEMS[id] && ITEMS[id].equip; return sum + (e ? e.bonuses.filter((b) => b.type === type).reduce((a, b) => a + b.value, 0) : 0) }, 0)
  const sectOf = (s) => SECTS.find((x) => x.id === s.sect) || null
  const sectBonus = (s, type) => { const x = sectOf(s); return (x ? x.bonuses.filter((b) => b.type === type).reduce((a, b) => a + b.value, 0) : 0) + gearBonus(s, type) }
  const buffVal = (s, stat) => (s.buffs && s.buffs[stat] ? s.buffs[stat].value : 0)
  const maxHp = (s) => Math.round(hpAt(s.realm, s.layer) * (1 + statBonus(s, 'root') + gearBonus(s, 'hp')))
  const maxMp = (s) => mpAt(s.realm, s.layer)
  const hpRatio = (s) => maxHp(s) / BASE_HP
  const mpRatio = (s) => maxMp(s) / BASE_MP
  const cultCost = (s) => Math.max(CULTIVATE_COST, Math.round(CULTIVATE_COST * mpRatio(s)))
  const required = (s) => Math.round(100 * Math.pow(1.6, s.realm) * (1 + s.layer * 0.25))
  const xpSlow = (s) => XP_SLOW_BASE * (1 + (s.realm * MAX_LAYER + s.layer - 1) * XP_SLOW_PER_LEVEL)
  const xpGain = (s, n) => Math.round(n / xpSlow(s) * 100) / 100
  const usableSkills = (s) => SKILLS.filter((k) => k.grade === 'basic' || (s.sect && k.sect === s.sect && (k.grade === 'sect' || (s.learned || {})[k.id])))
  const sellPrice = (s, id) => Math.round(ITEMS[id].sell * (1 + sectBonus(s, 'sell')))
  const buyPrice = (s, id) => Math.max(1, Math.round(ITEMS[id].buy * (1 - sectBonus(s, 'discount'))))
  const cultivateBonus = (s) => sectBonus(s, 'cultivate') + buffVal(s, 'cultivate') + statBonus(s, 'insight')
  const chance = (s) => {
    const base = s.layer === MAX_LAYER ? 0.55 - s.realm * 0.05 : 0.92 - s.layer * 0.03
    return Math.min(0.9, Math.max(0.2, Math.min(0.95, base)) + sectBonus(s, 'breakthrough') + statBonus(s, 'luck') + (s.breakBonus || 0))
  }
  const secludeCost = (s) => SECLUDE_COST + Math.floor(lv(s) / 4)
  const ticketCost = (s, loc) => (s.gm ? 0 : Math.max(0, loc.ticket || 0))
  const bossAtkCost = (s) => Math.round(10 * mpRatio(s))
  const realmText = (realm, layer) => `${REALMS[realm]}期第${NUM[layer - 1]}層`
  const BUFF_LABELS = { atk: '攻擊', def: '減傷', cultivate: '修煉速度', petAtk: '靈寵攻擊' }
  const rewardText = (r) => [`貢獻 ${r.contribution}`, r.stones ? `靈石 ${r.stones}` : '', r.xp ? `修為 ${Math.round(r.xp * 100)}%` : ''].filter(Boolean).join('、')
  const bonusText = (x) => x.bonuses.map((b) => BONUS_TYPES[b.type](b.value)).join('、')
  const findLoc = (id) => LOCATIONS.find((l) => l.id === id) || null
  const monsterById = (id) => { for (const l of LOCATIONS) { const m = l.monsters.find((x) => x.id === id); if (m) return { m, loc: l } } return null }
  const findQuest = (s, qid) => { const x = sectOf(s); return x ? x.quests.find((q) => q.id === qid) : null }
  const questCdLeft = (s, qid, now) => Math.max(0, ((s.questCd || {})[qid] || 0) - now)
  const fmtCd = (ms) => { const t = Math.ceil(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60; return h ? `${h}時${String(m).padStart(2, '0')}分` : `${m}:${String(sec).padStart(2, '0')}` }

  /* ---------- 背包 ---------- */
  const addItem = (s, id, qty = 1) => { s.inventory[id] = (s.inventory[id] || 0) + qty }
  const consumeItem = (s, id, qty = 1) => {
    if (s.gm) return   // GM：物品無限
    s.inventory[id] = (s.inventory[id] || 0) - qty
    if (s.inventory[id] <= 0) delete s.inventory[id]
  }
  const have = (s, id) => s.inventory[id] || 0
  function rollTable(table, mul = 1) {
    const loot = []
    for (const e of table) if (Math.random() < e.chance * mul) loot.push({ item: e.item, qty: randomInt(e.min, e.max) })
    return loot
  }
  const rollLoot = (s, m) => rollTable(m.loot, 1 + sectBonus(s, 'loot'))
  function rollLootbox(rolls) {
    const total = LOOTBOX_POOL.reduce((a, e) => a + e.weight, 0), got = []
    for (let i = 0; i < rolls; i++) {
      let r = Math.random() * total
      const e = LOOTBOX_POOL.find((x) => (r -= x.weight) < 0) || LOOTBOX_POOL[0]
      got.push({ item: e.item, qty: randomInt(e.min, e.max) })
    }
    return got
  }
  const lootText = (loot) => loot.map((l) => `${ITEMS[l.item].name} × ${l.qty}`).join('、')

  /* ---------- 靈寵 ---------- */
  const petTpl = (p) => PET_TEMPLATES.find((t) => t.id === p.tpl) || PET_TEMPLATES[0]
  const petRequired = (p) => Math.round(80 * Math.pow(1.6, p.realm) * (1 + p.layer * 0.25))
  const petMaxed = (p) => p.realm >= p.cap && p.layer >= MAX_LAYER
  const petEff = (s, p) => { const e = Math.min(p.realm * MAX_LAYER + p.layer - 1, lv(s)); return { realm: Math.floor(e / MAX_LAYER), layer: e % MAX_LAYER + 1 } }
  const petAtk = (s, p) => { const e = petEff(s, p); return Math.round((4 + e.realm * 7 + e.layer * 1.2) * petTpl(p).atk * (1 + sectBonus(s, 'petAtk') + buffVal(s, 'petAtk'))) }
  const petStrike = (s, p) => { const a = petAtk(s, p); return randomInt(Math.round(a * 0.8), Math.round(a * 1.2)) }
  const activePet = (s) => (s.pets || []).find((p) => p.uid === s.activePet) || null
  const newPetUid = () => Array.from({ length: 6 }, () => String.fromCharCode(97 + randomInt(0, 25))).join('')
  function hatchEgg(s, grade) {
    const g = PET_GRADES[grade], pool = PET_TEMPLATES.filter((t) => t.grade === grade)
    const tpl = pool[randomInt(0, pool.length - 1)]
    const span = g.maxRealm - g.minRealm + 1
    let r = Math.random() * (span * (span + 1) / 2), realm = g.minRealm
    for (let i = 0; i < span; i++) { r -= span - i; if (r < 0) { realm = g.minRealm + i; break } }
    let uid; do uid = newPetUid(); while (s.pets.some((p) => p.uid === uid))
    const pet = { uid, tpl: tpl.id, grade, realm, layer: randomInt(1, 3), xp: 0, cap: g.cap }
    s.pets.push(pet)
    if (!activePet(s)) s.activePet = pet.uid
    return pet
  }
  function addPetXp(s, p, amount, out) {
    if (!p || petMaxed(p)) return
    p.xp += Math.round(amount * (1 + sectBonus(s, 'petXp')) * 100) / 100
    let ups = 0
    while (!petMaxed(p) && p.xp >= petRequired(p)) {
      p.xp -= petRequired(p)
      if (p.layer < MAX_LAYER) p.layer++
      else { p.realm++; p.layer = 1 }
      ups++
    }
    if (petMaxed(p)) p.xp = 0
    if (ups) log(out, `靈寵「${petTpl(p).name}」修為精進，晉入${realmText(p.realm, p.layer)}${petMaxed(p) ? '，已達資質上限，圓滿無缺！' : '。'}`, 'success')
  }

  /* ---------- 增益／功法 ---------- */
  function addBuff(s, stat, value, sec) {
    const cur = s.buffs[stat]
    s.buffs[stat] = { value: Math.max(value, cur ? cur.value : 0), left: Math.max(sec, cur ? cur.left : 0) }   // 同類取較高數值、較長時間
  }
  // 施展功法的共同部分：檢查、扣靈力、上冷卻、套用回復／增益效果。傷害由呼叫者依場合計算
  function castCore(s, skillId) {
    const k = SKILLS.find((x) => x.id === skillId)
    if (!k || !usableSkills(s).includes(k)) fail('目前無法施展這個功法')
    if ((k.req || 0) > s.realm) fail(`「${k.name}」需達到${REALMS[k.req]}期方能施展。`)
    if ((s.cooldowns[k.id] || 0) > 0) fail(`「${k.name}」冷卻中。`)
    if (s.mp < k.cost) fail('靈力不足。')
    s.mp -= k.cost
    s.cooldowns[k.id] = k.cooldown
    const notes = []
    for (const ef of k.effects) {
      if (ef.t === 'heal') { const v = Math.round(maxHp(s) * ef.pct * (1 + statBonus(s, 'soul'))); s.hp = Math.min(maxHp(s), s.hp + v); notes.push(`氣血 +${v}`) }
      else if (ef.t === 'mp') { const v = Math.round(maxMp(s) * ef.pct); s.mp = Math.min(maxMp(s), s.mp + v); notes.push(`靈力 +${v}`) }
      else if (ef.t === 'buff') { addBuff(s, ef.stat, ef.value, ef.sec); notes.push(`${BUFF_LABELS[ef.stat]} +${Math.round(ef.value * 100)}%，${ef.sec} 息`) }
    }
    return { skill: k, dmgFx: k.effects.find((e) => e.t === 'dmg') || null, notes }
  }
  const skillById = (id) => SKILLS.find((x) => x.id === id) || null

  /* ---------- 宗門任務進度 ---------- */
  function progressKillQuests(s, monsterId, out) {
    for (const qid of Object.keys(s.quests)) {
      const q = findQuest(s, qid)
      if (!q || q.monster !== monsterId || s.quests[qid] >= q.qty) continue
      s.quests[qid]++
      if (s.quests[qid] >= q.qty) log(out, `宗門任務「${q.name}」已達成，回宗門交付吧。`, 'gold')
    }
  }

  /* ---------- 時間流逝：每一息（秒）的自然變化，伺服器依真實時間補算 ---------- */
  function tickSecond(s, out) {
    s.acc = s.acc || { hp: 0, mp: 0 }
    s.acc.mp += ((s.secluded ? 1 : 2) + sectBonus(s, 'mpRegen')) * mpRatio(s) * REGEN_SCALE
    s.acc.hp += (1 + sectBonus(s, 'hpRegen')) * hpRatio(s) * REGEN_SCALE
    const gMp = Math.floor(s.acc.mp), gHp = Math.floor(s.acc.hp)
    s.acc.mp -= gMp; s.acc.hp -= gHp
    s.mp = Math.min(maxMp(s), s.mp + gMp)
    s.hp = Math.min(maxHp(s), s.hp + gHp)
    for (const k of Object.keys(s.cooldowns)) { if (s.cooldowns[k] > 1) s.cooldowns[k]--; else delete s.cooldowns[k] }
    for (const [k, b] of Object.entries(s.buffs)) if (--b.left <= 0) { delete s.buffs[k]; log(out, `${BUFF_LABELS[k] || k}增益的效力消散了。`) }
    if (s.secluded) {
      const req = required(s)
      if (s.xp >= req) { s.secluded = false; log(out, '修為已至圓滿，你緩緩出關，準備衝擊瓶頸。', 'gold') }
      else if (!s.gm && s.stones < secludeCost(s)) { s.secluded = false; log(out, '靈石耗盡，無以維持洞府靈陣，你被迫出關。', 'danger') }
      else {
        s.xp = Math.min(req, s.xp + req * 0.03 / xpSlow(s) * (1 + cultivateBonus(s)))
        if (!s.gm) s.stones -= secludeCost(s)
      }
    }
  }
  function fillGM(s) { if (s.gm) for (const id of Object.keys(ITEMS)) s.inventory[id] = 99999 }
  // 補算到 now：每過一整秒跑一次 tickSecond；太久沒動作最多補 OFFLINE_TICK_CAP 息
  function advance(s, now, out) {
    if (!s.t) { s.t = now; fillGM(s); return }
    let n = Math.floor((now - s.t) / 1000)
    if (n > 0) {
      s.t += n * 1000
      n = Math.min(n, OFFLINE_TICK_CAP)
      for (let i = 0; i < n; i++) tickSecond(s, out)
    }
    fillGM(s)
  }

  /* ---------- 存檔：建立、舊格式轉換、傳給前端的版本 ---------- */
  function newSave() {
    return { fmt: SAVE_FMT, realm: 0, layer: 1, xp: 120, hp: 220, mp: 86, stones: 1000, jade: 1,
      inventory: { qi: 5, foundation: 2, spiritGrass: 3, commonEgg: 1, commonFeed: 5 },
      sect: '', contribution: 0, attrs: {}, learned: {}, quests: {}, questCd: {}, buffs: {}, breakBonus: 0, cooldowns: {},
      pets: [], activePet: null, equipped: {}, secluded: false, selectedLocation: null, battle: null, acc: { hp: 0, mp: 0 }, t: 0, v: 0 }
  }
  const N = (c) => c.charCodeAt(0) - 97
  // 第一階段以前的存檔把靈寵、任務、功法、屬性、裝備編碼在 inventory 的 zq 開頭欄位裡，這裡解開成正式欄位
  function migrate(raw) {
    const s = Object.assign(newSave(), raw || {})
    for (const k of ['inventory', 'attrs', 'learned', 'quests', 'questCd', 'buffs', 'cooldowns', 'equipped']) if (!s[k] || typeof s[k] !== 'object' || Array.isArray(s[k])) s[k] = {}
    if (!Array.isArray(s.pets)) s.pets = []
    if (!raw || raw.fmt !== SAVE_FMT) {   // 依「原始資料」判斷是否為舊格式（s 已被新存檔預設值填過）
      const inv = s.inventory
      for (const [k, v] of Object.entries(inv)) {
        if (k.startsWith('zqpet')) {
          const body = k.slice(5), tpl = PET_TEMPLATES.find((t) => t.id === body.slice(9))
          if (tpl && s.pets.length < MAX_PETS) {
            const cap = PET_GRADES[tpl.grade].cap
            const p = { uid: body.slice(3, 9), tpl: tpl.id, grade: tpl.grade, realm: Math.min(cap, Math.max(0, N(body[0]))), layer: Math.min(MAX_LAYER, Math.max(1, N(body[1]) + 1)), xp: Number(v) || 0, cap }
            s.pets.push(p)
            if (body[2] === 'y') s.activePet = p.uid
          }
        } else if (k.startsWith('zqqst')) s.quests[k.slice(5)] = Number(v) || 0
        else if (k.startsWith('zqqcd')) s.questCd[k.slice(5)] = (Number(v) || 0) * 60000
        else if (k.startsWith('zqskl')) s.learned[k.slice(5)] = true
        else if (k.startsWith('zqstat')) { const st = k.slice(6); if (STAT_META[st]) s.attrs[st] = Math.min(STAT_CAP, Math.max(0, Number(v) || 0)) }
        else if (k.startsWith(EQUIP_KEY)) { const id = k.slice(EQUIP_KEY.length), eq = ITEMS[id] && ITEMS[id].equip; if (eq && Number(v) > 0 && !s.equipped[eq.slot]) s.equipped[eq.slot] = id }
        else continue
        delete inv[k]
      }
      s.fmt = SAVE_FMT
    }
    // 清理：不存在的道具、功法、靈寵；失效的宗門
    for (const [id, q] of Object.entries(s.inventory)) if (!ITEMS[id] || !(q > 0)) delete s.inventory[id]
    for (const id of Object.keys(s.learned)) if (!SKILLS.some((k) => k.id === id && k.grade === 'advanced')) delete s.learned[id]
    for (const [slot, id] of Object.entries(s.equipped)) if (!ITEMS[id] || !ITEMS[id].equip || ITEMS[id].equip.slot !== slot) delete s.equipped[slot]
    s.pets = s.pets.filter((p) => p && PET_TEMPLATES.some((t) => t.id === p.tpl)).slice(0, MAX_PETS)
    if (!s.pets.some((p) => p.uid === s.activePet)) s.activePet = null
    if (!sectOf(s)) { s.sect = ''; s.contribution = 0; s.quests = {} }
    for (const qid of Object.keys(s.quests)) { const q = findQuest(s, qid); if (!q || q.type !== 'kill') delete s.quests[qid] }
    s.realm = Math.min(REALMS.length - 1, Math.max(0, Math.floor(Number(s.realm) || 0)))
    s.layer = Math.min(MAX_LAYER, Math.max(1, Math.floor(Number(s.layer) || 1)))
    for (const k of ['xp', 'hp', 'mp', 'stones', 'jade', 'contribution', 'breakBonus']) s[k] = Math.max(0, Number(s[k]) || 0)
    s.xp = Math.min(s.xp, required(s)); s.hp = Math.min(s.hp, maxHp(s)); s.mp = Math.min(s.mp, maxMp(s))
    if (!s.acc || typeof s.acc !== 'object') s.acc = { hp: 0, mp: 0 }
    return s
  }
  // 傳給前端的狀態（回合制戰鬥補上妖獸完整資料，方便顯示）
  function publicSave(s) {
    const o = { v: s.v || 0, gm: !!s.gm }
    for (const k of STATE_KEYS) o[k] = s[k]
    if (s.battle) { const loc = findLoc(s.battle.loc), m = loc && loc.monsters.find((x) => x.id === s.battle.mon); o.battle = m ? { monster: m, monsterHp: s.battle.monsterHp, log: s.battle.log } : null }
    return JSON.parse(JSON.stringify(o))
  }

  /* ---------- 回合制戰鬥 ---------- */
  const battleMon = (s) => { const b = s.battle, loc = b && findLoc(b.loc); return loc ? loc.monsters.find((m) => m.id === b.mon) || null : null }
  function battleLog(s, text) { s.battle.log.unshift(text); if (s.battle.log.length > 6) s.battle.log.pop() }
  function playerAtkRange(s) {
    const base = Math.round((8 + s.realm * 10 + s.layer * 2) * (1 + sectBonus(s, 'atk') + buffVal(s, 'atk')))
    const v = Math.round(base * 0.3)
    return [Math.max(1, base - v), base + v]
  }
  function monsterTurn(s, out) {
    const m = battleMon(s)
    const mitigation = Math.round(s.realm * 2 * hpRatio(s))
    const reduce = Math.min(0.8, sectBonus(s, 'def') + buffVal(s, 'def'))
    const d = Math.max(1, Math.round((randomInt(m.atkMin, m.atkMax) - mitigation) * (1 - reduce)))
    s.hp = Math.max(0, s.hp - d)
    battleLog(s, `「${m.name}」反擊，你受到 ${d} 點傷害。`)
    if (s.hp <= 0) { defeat(s, out); return true }
    return false
  }
  function defeat(s, out) {
    const m = battleMon(s)
    log(out, `不敵「${m ? m.name : '妖獸'}」，你身受重傷，狼狽撤退。`, 'danger')
    s.hp = Math.max(1, Math.round(maxHp(s) * 0.2))
    s.xp = Math.floor(s.xp * 0.9)
    s.selectedLocation = null; s.battle = null
    log(out, '傷重撤出秘境：損失 10% 修為，門票作廢，再次進入須重新購票。', 'danger')
  }
  function victory(s, out) {
    const m = battleMon(s)
    const exp = xpGain(s, m.exp * (1 + sectBonus(s, 'exp')))
    s.xp = Math.min(required(s), s.xp + exp)
    const loot = rollLoot(s, m)
    loot.forEach((l) => addItem(s, l.item, l.qty))
    log(out, `擊敗「${m.name}」，獲得 ${exp} 點修為${loot.length ? `，拾取 ${lootText(loot)}` : ''}。`, 'success')
    if (loot.some((l) => l.item === 'advancedEgg')) log(out, '妖獸巢穴中竟藏著一顆高級靈獸蛋！', 'gold')
    const heal = Math.round(maxHp(s) * sectBonus(s, 'lifesteal'))
    if (heal > 0) { s.hp = Math.min(maxHp(s), s.hp + heal); log(out, `血煞之力反哺，回復 ${heal} 點氣血。`, 'danger') }
    progressKillQuests(s, m.id, out)
    addPetXp(s, activePet(s), xpGain(s, m.exp), out)
    s.battle = null
  }
  function attackMonster(s, mult, skill, out) {
    const m = battleMon(s)
    const [lo, hi] = playerAtkRange(s)
    const dmg = Math.max(1, Math.round(randomInt(lo, hi) * mult))
    s.battle.monsterHp = Math.max(0, s.battle.monsterHp - dmg)
    battleLog(s, skill ? `你施展「${skill.name}」，造成 ${dmg} 點傷害。` : `你攻擊「${m.name}」，造成 ${dmg} 點傷害。`)
    const pet = activePet(s)
    if (pet && s.battle.monsterHp > 0) {
      const pd = petStrike(s, pet)
      s.battle.monsterHp = Math.max(0, s.battle.monsterHp - pd)
      battleLog(s, `靈寵「${petTpl(pet).name}」撲擊，造成 ${pd} 點傷害。`)
    }
    if (s.battle.monsterHp <= 0) return victory(s, out)
    monsterTurn(s, out)
  }

  /* ---------- 野外即時戰鬥（伺服器在妖獸出手／擊殺時呼叫）---------- */
  function fieldHit(s, rawDmg) {
    const mitigation = Math.round(s.realm * 2 * hpRatio(s))
    const reduce = Math.min(0.8, sectBonus(s, 'def') + buffVal(s, 'def'))
    const dmg = Math.max(1, Math.round((rawDmg - mitigation) * (1 - reduce)))
    s.hp = Math.max(0, s.hp - dmg)
    return { dmg, dead: s.hp <= 0 }
  }
  function fieldDefeat(s, out) {
    log(out, '你在野外不敵妖獸，身受重傷，被傳送陣送回主城。', 'danger')
    s.hp = Math.max(1, Math.round(maxHp(s) * 0.2))
    s.xp = Math.floor(s.xp * 0.9)
    s.selectedLocation = null
    log(out, '傷重撤出秘境：損失 10% 修為，門票作廢，再次進入須重新購票。', 'danger')
  }
  function fieldKill(s, def, loot, out) {
    const exp = xpGain(s, def.exp * (1 + sectBonus(s, 'exp')))
    s.xp = Math.min(required(s), s.xp + exp)
    loot.forEach((l) => addItem(s, l.item, l.qty))
    log(out, `擊敗「${def.name}」，獲得 ${exp} 點修為${loot.length ? `，拾取 ${lootText(loot)}` : ''}。`, 'success')
    if (loot.some((l) => l.item === 'advancedEgg')) log(out, '妖獸巢穴中竟藏著一顆高級靈獸蛋！', 'gold')
    const heal = Math.round(maxHp(s) * sectBonus(s, 'lifesteal'))
    if (heal > 0) s.hp = Math.min(maxHp(s), s.hp + heal)
    progressKillQuests(s, def.id, out)
    addPetXp(s, activePet(s), xpGain(s, def.exp), out)
    return exp
  }
  // 野外出手：回傳伺服器計算的傷害參數（取代舊版由前端傳來的 bonus／pet／lm）
  function fieldStrikeParams(s, skillId) {
    let skill = null, notes = []
    if (skillId) {
      const k = skillById(skillId)
      if (!k || !k.effects.some((e) => e.t === 'dmg')) fail('這不是攻伐功法')
      const c = castCore(s, skillId); skill = c; notes = c.notes
    }
    const atkB = sectBonus(s, 'atk') + buffVal(s, 'atk')
    const bonus = skill ? (1 + atkB) * (1 + statBonus(s, 'soul')) - 1 : atkB
    const pet = activePet(s)
    return { mult: skill ? skill.dmgFx.mult : 1, bonus, pet: pet ? petStrike(s, pet) : 0, lm: 1 + sectBonus(s, 'loot'), skill: skill && skill.skill, notes }
  }

  /* ---------- 世界王 ---------- */
  function bossBlock(s) { return s.hp < maxHp(s) * BOSS_MIN_HP_RATIO ? `氣血過低（需高於 ${Math.ceil(maxHp(s) * BOSS_MIN_HP_RATIO)}），再戰恐有性命之憂，先服丹療傷吧。` : '' }
  // 出手前：檢查並扣除消耗，回傳傷害倍率
  function bossStrikeParams(s, skillId) {
    const block = bossBlock(s); if (block) fail(block)
    if (skillId) {
      const k = skillById(skillId)
      if (!k || !k.effects.some((e) => e.t === 'dmg')) fail('這不是攻伐功法')
      const c = castCore(s, skillId)
      return { mult: c.dmgFx.mult * (1 + statBonus(s, 'soul')), skill: c.skill }
    }
    if (s.mp < bossAtkCost(s)) fail('靈力不足，無法出手。')
    s.mp -= bossAtkCost(s)
    return { mult: 1, skill: null }
  }
  // 出手後：魔蛟反擊
  function bossCounter(s, bossName, rage, out) {
    let roll = Math.random() * BOSS_SKILLS.reduce((a, k) => a + k.w, 0)
    const sk = BOSS_SKILLS.find((k) => (roll -= k.w) < 0) || BOSS_SKILLS[0]
    const reduce = Math.min(0.8, sectBonus(s, 'def') + buffVal(s, 'def'))
    const baseDmg = maxHp(s) * (BOSS_DMG_PCT[0] + Math.random() * (BOSS_DMG_PCT[1] - BOSS_DMG_PCT[0]))
    let dmg = Math.max(1, Math.round((baseDmg * sk.mul * (rage ? 1.5 : 1) - s.realm * 2 * hpRatio(s)) * (1 - reduce)))
    let text = `${rage ? '【狂暴】' : ''}「${bossName}」施展「${sk.name}」`
    const pet = activePet(s)
    if (pet && Math.random() < 0.25) { dmg = Math.max(1, Math.round(dmg * 0.4)); text += `，靈寵「${petTpl(pet).name}」捨身擋下大半` }
    s.hp = Math.max(0, s.hp - dmg)
    text += `，你受到 ${dmg} 點傷害`
    if (sk.mp) { const lost = Math.min(s.mp, Math.round(sk.mp * mpRatio(s))); s.mp -= lost; if (lost) text += `，靈力被震散 ${lost} 點` }
    text += '。'
    if (s.hp <= 0) { s.hp = 1; text += `你被${bossName}重創，僅存一口氣，需先調息或服丹再戰！` }
    log(out, text, 'danger')
    return text
  }

  /* =====================================================================
   * 動作：前端送 { type, p }，伺服器呼叫 ACTIONS[type](s, p, out, ctx)
   *   s = 存檔（會被修改）、p = 參數、out = 要顯示的日誌、ctx = { now: 伺服器時間 }
   *   不合法的操作用 fail('原因') 中止，存檔不會被改動（伺服器會先複製一份再執行）
   * ===================================================================== */
  const ACTIONS = {
    sync() {},   // 只是要最新狀態（時間流逝由 advance 處理）

    cultivate(s, p, out) {
      const req = required(s)
      if (s.xp >= req) fail('修為已圓滿，請先突破。')
      if (s.mp < cultCost(s)) fail('靈力不足，無法運功。')
      const gain = xpGain(s, req * (0.06 + Math.random() * 0.06) * (1 + cultivateBonus(s)))
      s.mp -= cultCost(s)
      s.xp = Math.min(req, s.xp + gain)
      if (Math.random() < 0.35) log(out, `運轉周天，吸納天地靈氣，修為增加 ${gain}。`)
    },

    breakthrough(s, p, out) {
      if (s.xp < required(s)) fail('修為尚未圓滿。')
      const ok = Math.random() < chance(s)
      const oldHp = maxHp(s), oldMp = maxMp(s)
      if (s.breakBonus) { s.breakBonus = 0; log(out, '突破加持之力已消耗。') }
      if (ok) {
        s.xp = 0
        if (s.layer < MAX_LAYER) { log(out, `突破成功！晉入${REALMS[s.realm]}期第${NUM[s.layer]}層。`, 'success'); s.layer++ }
        else if (s.realm < REALMS.length - 1) { s.realm++; s.layer = 1; log(out, `天降異象，霞光萬道！你成功踏入${REALMS[s.realm]}期！`, 'gold') }
        else log(out, '你已臻大乘圓滿，只待飛升之日。', 'gold')
        s.hp = Math.min(maxHp(s), s.hp + Math.max(0, maxHp(s) - oldHp))
        s.mp = Math.min(maxMp(s), s.mp + Math.max(0, maxMp(s) - oldMp))
      } else {
        s.xp = Math.floor(s.xp * 0.5)
        s.hp = Math.max(1, s.hp - Math.round(40 * hpRatio(s)))
        log(out, '衝擊瓶頸失敗，靈氣逆衝經脈，氣血受損，損失一半修為。', 'danger')
        if (s.layer >= 7 && Math.random() < 0.3) {
          s.layer--
          s.xp = Math.min(s.xp, required(s)); s.hp = Math.min(s.hp, maxHp(s))
          log(out, `瓶頸反噬，境界跌落至${REALMS[s.realm]}期第${NUM[s.layer - 1]}層！`, 'danger')
        }
      }
    },

    seclude(s, p, out) {
      if (!s.secluded && !s.gm && s.stones < secludeCost(s)) fail(`靈石不足（閉關每息需 ${secludeCost(s)} 靈石），無法閉關。`)
      s.secluded = !s.secluded
      log(out, s.secluded ? '你封閉洞府，開始閉關苦修。' : '你推開石門，結束閉關。', s.secluded ? 'normal' : 'gold')
    },

    cast(s, p, out) {   // 非攻伐功法（回復、護體、增益）；回合制戰鬥中的攻伐功法也走這裡
      const k = skillById(String(p.skill || ''))
      if (!k) fail('功法無效')
      const isDmg = k.effects.some((e) => e.t === 'dmg')
      if (isDmg && !s.battle) fail(`「${k.name}」是攻伐功法，需在秘境戰鬥、野外，或在「魔蛟」分頁對世界王施展。`)
      const c = castCore(s, k.id)
      if (isDmg) {
        log(out, `施展「${k.name}」—— ${k.description}${c.notes.length ? `（${c.notes.join('，')}）` : ''}。`, 'success')
        return attackMonster(s, c.dmgFx.mult * (1 + statBonus(s, 'soul')), k, out)
      }
      log(out, `施展「${k.name}」—— ${k.description}（${c.notes.join('，')}）。`, 'success')
      if (s.battle) { battleLog(s, `你施展「${k.name}」。`); monsterTurn(s, out) }
    },

    use(s, p, out) {
      const id = String(p.id || ''), def = ITEMS[id]
      if (!def || !def.effect || have(s, id) <= 0) fail('沒有這個道具。')
      if (def.effect.type === 'hatch') {
        if (s.pets.length >= MAX_PETS) fail(`靈寵已達上限 ${MAX_PETS} 隻，請先放生部分靈寵。`)
        consumeItem(s, id)
        const pet = hatchEgg(s, def.effect.grade), g = PET_GRADES[pet.grade]
        return log(out, `${def.name}破殼而出——獲得${g.label}靈寵「${petTpl(pet).icon} ${petTpl(pet).name}」（${realmText(pet.realm, pet.layer)}，資質上限：${REALMS[pet.cap]}期）！`, 'gold')
      }
      if (def.effect.type === 'feedPet') {
        const pet = activePet(s)
        if (!pet) fail('尚無出戰靈寵，請先到「靈寵」分頁指定出戰靈寵再餵食。')
        return ACTIONS.feed(s, { uid: pet.uid, item: id }, out)
      }
      const effects = Array.isArray(def.effect) ? def.effect : [def.effect]
      const statFx = effects.filter((e) => e.type === 'stat')
      if (statFx.length && statFx.every((e) => statPts(s, e.stat) >= STAT_CAP)) fail(`「${def.name}」：該屬性已達丹藥可提升的上限（${STAT_CAP} 點），無法再服用。`)
      consumeItem(s, id)
      const pillMul = 1 + sectBonus(s, 'pill'), notes = []
      for (const ef of effects) {
        if (ef.type === 'restoreMp') { const v = Math.round(ef.value * pillMul * mpRatio(s)); s.mp = Math.min(maxMp(s), s.mp + v); notes.push(`靈力 +${v}`) }
        else if (ef.type === 'restoreHp') { const v = Math.round(ef.value * pillMul * hpRatio(s)); s.hp = Math.min(maxHp(s), s.hp + v); notes.push(ef.value >= 9999 ? '氣血全滿' : `氣血 +${v}`) }
        else if (ef.type === 'restoreAll') { s.hp = maxHp(s); s.mp = maxMp(s); notes.push('氣血靈力全滿') }
        else if (ef.type === 'addXpPercent') { const req = required(s), v = xpGain(s, req * ef.value * pillMul); s.xp = Math.min(req, s.xp + v); notes.push(`修為 +${v}`) }
        else if (ef.type === 'buff') { addBuff(s, ef.stat, ef.value, ef.sec); notes.push(`${BUFF_LABELS[ef.stat]} +${Math.round(ef.value * 100)}%，持續 ${ef.sec} 息`) }
        else if (ef.type === 'stat') {
          const cur = statPts(s, ef.stat), gain = Math.min(STAT_CAP - cur, ef.value)
          if (gain > 0) { s.attrs[ef.stat] = cur + gain; notes.push(`${STAT_META[ef.stat].label} +${gain}（${STAT_META[ef.stat].fx(cur + gain)}）`) }
          else notes.push(`${STAT_META[ef.stat].label}已達上限`)
        }
        else if (ef.type === 'breakBonus') { s.breakBonus = Math.max(s.breakBonus || 0, ef.value); notes.push(`下次突破機率 +${Math.round(s.breakBonus * 100)}%`) }
        else if (ef.type === 'stones') { const v = randomInt(ef.min, ef.max); s.stones += v; notes.push(`獲得 ${v} 靈石`) }
        else if (ef.type === 'jade') { const v = randomInt(ef.min, ef.max); s.jade += v; notes.push(`獲得 ${v} 仙玉`) }
        else if (ef.type === 'lootbox') { const got = rollLootbox(ef.rolls); got.forEach((l) => addItem(s, l.item, l.qty)); notes.push(`開出 ${lootText(got)}`) }
      }
      const verb = ['bag', 'treasure'].includes(def.type) && effects.some((e) => ['stones', 'jade', 'lootbox'].includes(e.type)) ? '打開' : '使用'
      log(out, `${verb}「${def.name}」：${notes.join('，')}。`, effects.some((e) => ['addXpPercent', 'breakBonus', 'lootbox', 'jade', 'stat'].includes(e.type)) ? 'gold' : 'success')
    },

    sell(s, p, out) {
      const id = String(p.id || ''), def = ITEMS[id]
      if (!def || have(s, id) <= 0) fail('沒有這個道具。')
      consumeItem(s, id)
      const price = sellPrice(s, id)
      s.stones += price
      log(out, `售出「${def.name}」，獲得 ${price} 靈石。`)
    },

    buy(s, p, out) {
      const id = String(p.id || ''), def = ITEMS[id]
      if (!def || !def.buy || !SHOP_ITEMS.includes(id)) fail('商店沒有販售這個道具。')
      const wallet = def.currency === 'jade' ? 'jade' : 'stones', price = buyPrice(s, id)
      if (s[wallet] < price) fail(`${wallet === 'jade' ? '仙玉' : '靈石'}不足，無法購買「${def.name}」。`)
      s[wallet] -= price
      addItem(s, id, 1)
      log(out, `花費 ${price} ${wallet === 'jade' ? '仙玉' : '靈石'}，購得「${def.name}」。`, 'gold')
    },

    exchange(s, p, out) {
      const amount = Math.max(0, Math.floor(Number(p.amount) || 0))
      const jadeGain = Math.floor(amount / JADE_RATE)
      if (jadeGain <= 0) fail('靈石數量不足以兌換仙玉。')
      const cost = jadeGain * JADE_RATE
      if (s.stones < cost) fail('靈石不足，無法完成兌換。')
      s.stones -= cost; s.jade += jadeGain
      log(out, `以 ${cost} 靈石兌換 ${jadeGain} 仙玉。`, 'gold')
    },

    equip(s, p, out) {
      const id = String(p.id || ''), def = ITEMS[id], eq = def && def.equip
      if (!eq || have(s, id) <= 0) fail('沒有這件裝備。')
      if (s.battle) fail('戰鬥中無法更換裝備。')
      if (s.realm < eq.req) fail(`「${def.name}」需${REALMS[eq.req]}期方可佩戴。`)
      const old = s.equipped[eq.slot]
      consumeItem(s, id)
      if (old) addItem(s, old, 1)
      s.equipped[eq.slot] = id
      s.hp = Math.min(s.hp, maxHp(s))
      log(out, `你換上「${def.name}」（${EQUIP_SLOTS[eq.slot].label}）${old ? `，換下「${ITEMS[old].name}」` : ''}。`, 'success')
    },

    unequip(s, p, out) {
      const slot = String(p.slot || ''), id = s.equipped[slot]
      if (!id) fail('這個部位沒有裝備。')
      if (s.battle) fail('戰鬥中無法更換裝備。')
      delete s.equipped[slot]
      addItem(s, id, 1)
      s.hp = Math.min(s.hp, maxHp(s))
      log(out, `你卸下了「${ITEMS[id].name}」。`)
    },

    forge(s, p, out) {
      const x = sectOf(s); if (!x) fail('拜入宗門才能使用煉器工坊。')
      const itemId = String(p.id || '')
      const own = ((SECT_FORGE[x.id] || {}).recipes || []).find((r) => r.item === itemId)
      const r = own || FORGE_RECIPES.find((rr) => rr.item === itemId)
      if (!r) fail('沒有這個配方。')
      const def = ITEMS[itemId], fee = r.fee || 0
      const lack = Object.entries(r.mats).find(([m, n]) => have(s, m) < n)
      if (lack) fail(`煉製「${def.name}」的材料不足：缺少「${ITEMS[lack[0]].name}」。`)
      if (s.stones < r.stones) fail(`煉製「${def.name}」需要 ${r.stones} 靈石，靈石不足。`)
      if (s.contribution < fee) fail(`煉製「${def.name}」需要 ${fee} 點宗門貢獻，貢獻不足。`)
      s.stones -= r.stones
      if (Math.random() < forgeFailRate(r)) {
        const lost = []
        for (const [m, n] of Object.entries(r.mats)) { const k = Math.ceil(n / 2); consumeItem(s, m, k); lost.push(`${ITEMS[m].name} × ${k}`) }
        return log(out, `爐火失控，煉製「${def.name}」失敗！損失 ${r.stones} 靈石與材料（${lost.join('、')}），貢獻未扣。`, 'danger')
      }
      for (const [m, n] of Object.entries(r.mats)) consumeItem(s, m, n)
      s.contribution -= fee
      addItem(s, itemId, 1)
      log(out, `爐火燃起，你煉成了${def.icon}「${def.name}」（${def.rarity}）！耗費 ${r.stones} 靈石${fee ? `、${fee} 點貢獻` : ''}。`, 'gold')
    },

    feed(s, p, out) {
      const pet = s.pets.find((x) => x.uid === p.uid), id = String(p.item || ''), def = ITEMS[id]
      if (!pet || !def || !def.effect || def.effect.type !== 'feedPet') fail('無法餵食。')
      if (have(s, id) <= 0) fail(`沒有「${def.name}」了。`)
      if (petMaxed(pet)) fail(`「${petTpl(pet).name}」已達資質上限（${REALMS[pet.cap]}期圓滿），無法再精進。`)
      consumeItem(s, id)
      log(out, `餵食「${petTpl(pet).name}」${def.name}，靈寵修為 +${Math.round(def.effect.value * (1 + sectBonus(s, 'petXp')))}。`)
      addPetXp(s, pet, def.effect.value, out)
    },

    petActive(s, p, out) {
      const pet = s.pets.find((x) => x.uid === p.uid); if (!pet) fail('找不到這隻靈寵。')
      if (s.activePet === pet.uid) { s.activePet = null; log(out, `「${petTpl(pet).name}」回到靈獸袋中休息。`) }
      else { s.activePet = pet.uid; log(out, `「${petTpl(pet).name}」隨你出戰。`, 'success') }
    },

    petRelease(s, p, out) {
      const pet = s.pets.find((x) => x.uid === p.uid); if (!pet) fail('找不到這隻靈寵。')
      s.pets = s.pets.filter((x) => x !== pet)
      if (s.activePet === pet.uid) s.activePet = null
      log(out, `你將「${petTpl(pet).name}」放歸山林。`)
    },

    sectJoin(s, p, out) {
      const x = SECTS.find((y) => y.id === p.id); if (!x) fail('沒有這個宗門。')
      if (s.sect === x.id) fail('你已是本宗弟子。')
      const old = sectOf(s)
      if (old) log(out, `你離開了「${old.name}」，宗門貢獻歸零。`, 'danger')
      s.sect = x.id; s.contribution = 0; s.quests = {}; s.questCd = {}
      log(out, `你拜入「${x.name}」，獲得宗門特色：${bonusText(x)}。`, 'gold')
      log(out, `習得宗門功法：${SKILLS.filter((k) => k.sect === x.id && k.grade === 'sect').map((k) => `「${k.name}」`).join('、')}。`, 'gold')
    },

    sectLeave(s, p, out) {
      const x = sectOf(s); if (!x) fail('你目前是散修。')
      s.sect = ''; s.contribution = 0; s.quests = {}; s.questCd = {}
      log(out, `你離開了「${x.name}」，重歸散修，宗門貢獻歸零，宗門功法暫時封存。`, 'danger')
    },

    questAccept(s, p, out, ctx) {
      const q = findQuest(s, p.qid)
      if (!q || q.type !== 'kill') fail('沒有這個討伐任務。')
      if (q.id in s.quests) fail('已接取這個任務。')
      if (questCdLeft(s, q.id, ctx.now) > 0) fail(`「${q.name}」冷卻中，還需 ${fmtCd(questCdLeft(s, q.id, ctx.now))}。`)
      if (Object.keys(s.quests).length >= MAX_ACTIVE_QUESTS) fail(`討伐任務最多同時接取 ${MAX_ACTIVE_QUESTS} 個。`)
      s.quests[q.id] = 0
      log(out, `接取宗門任務「${q.name}」。`)
    },

    questAbandon(s, p, out) {
      const q = findQuest(s, p.qid)
      if (!q || !(q.id in s.quests)) fail('沒有接取這個任務。')
      delete s.quests[q.id]
      log(out, `放棄宗門任務「${q.name}」。`)
    },

    questComplete(s, p, out, ctx) {
      const q = findQuest(s, p.qid); if (!q) fail('沒有這個任務。')
      if (questCdLeft(s, q.id, ctx.now) > 0) fail(`「${q.name}」冷卻中，還需 ${fmtCd(questCdLeft(s, q.id, ctx.now))}。`)
      if (q.type === 'kill') {
        if ((s.quests[q.id] || 0) < q.qty) fail('任務尚未完成。')
        delete s.quests[q.id]
      } else {
        if (have(s, q.item) < q.qty) fail(`「${ITEMS[q.item].name}」數量不足。`)
        consumeItem(s, q.item, q.qty)
      }
      const r = q.reward
      if (q.cd) s.questCd[q.id] = ctx.now + q.cd * 60000
      s.contribution += r.contribution
      if (r.stones) s.stones += r.stones
      if (r.xp) { const req = required(s); s.xp = Math.min(req, s.xp + xpGain(s, req * r.xp)) }
      log(out, `完成宗門任務「${q.name}」，獲得${rewardText(r)}。${q.cd ? `（冷卻 ${q.cd} 分鐘）` : ''}`, 'gold')
    },

    sectSkill(s, p, out) {
      const x = sectOf(s)
      const k = x && SKILLS.find((y) => y.id === p.id && y.grade === 'advanced' && y.sect === x.id)
      if (!k) fail('本宗沒有這個高階功法。')
      if (s.learned[k.id]) fail('已經習得。')
      if (s.contribution < k.shopCost) fail('宗門貢獻不足。')
      s.contribution -= k.shopCost
      s.learned[k.id] = true
      log(out, `以 ${k.shopCost} 點貢獻兌換高階功法「${k.name}」${k.req > s.realm ? `（需${REALMS[k.req]}期方能施展）` : '，已可施展'}。`, 'gold')
    },

    sectBuy(s, p, out) {
      const x = sectOf(s), entry = x && x.shop.find((y) => y.item === p.item)
      if (!entry) fail('本宗寶庫沒有這個道具。')
      if (s.contribution < entry.cost) fail('宗門貢獻不足。')
      s.contribution -= entry.cost
      addItem(s, entry.item, 1)
      log(out, `以 ${entry.cost} 點貢獻兌換「${ITEMS[entry.item].name}」。`, 'gold')
    },

    enterLoc(s, p, out) {
      const loc = findLoc(p.id)
      if (!loc || s.realm < loc.reqRealm) fail('境界不足，無法進入。')
      if (s.selectedLocation === loc.id) return
      const cost = ticketCost(s, loc)
      if (cost > 0) {
        if (s.stones < cost) fail(`靈石不足：進入「${loc.name}」需購買門票 ${cost} 靈石。`)
        s.stones -= cost
        log(out, `購買「${loc.name}」門票，花費 ${cost} 靈石，踏入秘境。`, 'gold')
      }
      s.selectedLocation = loc.id; s.battle = null
    },

    leaveLoc(s) { s.selectedLocation = null; s.battle = null },

    battleStart(s, p) {
      const loc = findLoc(s.selectedLocation)
      if (!loc) fail('請先購買門票進入秘境。')
      if (s.battle) fail('正在戰鬥中。')
      const m = loc.monsters.find((x) => x.id === p.mon); if (!m) fail('這裡沒有這種妖獸。')
      s.battle = { loc: loc.id, mon: m.id, monsterHp: m.hp, log: [`你與「${m.name}」遭遇了！`] }
    },

    battleAttack(s, p, out) {
      if (!s.battle || !battleMon(s)) fail('目前不在戰鬥中。')
      attackMonster(s, 1, null, out)
    },

    battleFlee(s, p, out) {
      const m = battleMon(s); if (!m) fail('目前不在戰鬥中。')
      log(out, `你從「${m.name}」身邊脫身而逃。`)
      s.battle = null
    },
  }

  // 伺服器執行動作：先補算時間，再在「複本」上執行，成功才寫回（失敗不會留下半套修改）
  function runAction(save, type, p, now) {
    const fn = Object.prototype.hasOwnProperty.call(ACTIONS, type) && ACTIONS[type]
    if (!fn) fail('未知的操作')
    const out = []
    advance(save, now, out)
    save.v = (save.v || 0) + 1
    const work = JSON.parse(JSON.stringify(save))
    try { fn(work, p || {}, out, { now }) } catch (e) { e.out = out; throw e }   // 失敗：存檔只保留時間流逝的部分
    work.v = save.v + 1
    for (const k of Object.keys(save)) delete save[k]
    Object.assign(save, work)
    return out
  }

  const API = { REALMS, NUM, MAX_LAYER, CULTIVATE_COST, BASE_HP, BASE_MP, HP_PER_LV, MP_PER_LV, lvIdx, hpAt, mpAt, SKILL_GRADES, SKILL_TYPES, fxDmg, fxHeal, fxMp, fxBuff, SKILLS, ATTRIBUTES, STAT_CAP, STAT_META, JADE_RATE, ITEMS, SHOP_ITEMS, EQUIP_SLOTS, EQUIP_KEY, FORGE_FAIL, forgeFailRate, FORGE_RECIPES, SECT_FORGE, forgeMatUsers, LOOTBOX_POOL, LOCATIONS, PET_GRADES, PET_TEMPLATES, MAX_PETS, REALM_PET_LOOT, BOSS_LOOT_MIN_REALM, BOSS_PET_LOOT, REALM_COMMON_LOOT, LOCATION_FORGE_LOOT, MON_ATK_GROW, MON_HP_GROW, SECT_ALIGNS, BONUS_TYPES, SECTS, MAX_ACTIVE_QUESTS, QUEST_CD_KEY, XP_SLOW_BASE, XP_SLOW_PER_LEVEL, BOSS_SKILLS, BOSS_DMG_PCT, BOSS_MIN_HP_RATIO, REGEN_SCALE, SECLUDE_COST, SAVE_FMT, lv, statPts, statBonus, gearBonus, sectOf, sectBonus, buffVal, maxHp, maxMp, hpRatio, mpRatio, cultCost, required, xpSlow, xpGain, usableSkills, sellPrice, buyPrice, cultivateBonus, chance, secludeCost, ticketCost, bossAtkCost, realmText, BUFF_LABELS, rewardText, bonusText, findLoc, monsterById, findQuest, questCdLeft, fmtCd, randomInt, lootText, petTpl, petRequired, petMaxed, petEff, petAtk, petStrike, activePet, playerAtkRange, newSave, migrate, publicSave, advance, runAction, ACTIONS, fieldHit, fieldDefeat, fieldKill, fieldStrikeParams, bossStrikeParams, bossCounter, bossBlock, skillById, tickSecond }
  if (typeof module !== "undefined" && module.exports) module.exports = API
  else root.GameRules = API
})(typeof window !== "undefined" ? window : globalThis)
