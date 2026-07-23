/**
 * i18n — shared with the OPC Studio site via the `opcstudio_lang` localStorage
 * key. t(key) / tf(key, params) resolve a string in the current language;
 * setLang / toggleLang switch it and notify subscribers.
 */

export const LANG_KEY = 'opcstudio_lang';

let _lang = 'zh';
try { _lang = localStorage.getItem(LANG_KEY) || 'zh'; } catch (e) {}
const _subs = [];

export function getLang() { return _lang; }
export function onLangChange(cb) { _subs.push(cb); return cb; }
export function setLang(l) {
  _lang = (l === 'en') ? 'en' : 'zh';
  try { localStorage.setItem(LANG_KEY, _lang); } catch (e) {}
  _subs.forEach(f => { try { f(_lang); } catch (e) {} });
}
export function toggleLang() { setLang(_lang === 'zh' ? 'en' : 'zh'); }

export function t(key, fallback) {
  const e = DICT[key];
  if (!e) return fallback ?? key;
  return e[_lang] ?? e.zh ?? key;
}
/** t with {placeholder} substitution. */
export function tf(key, params = {}) {
  return t(key).replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? `{${k}}`));
}

const DICT = {
  // ── Page / nav ──
  'page.title':   { zh: '机场数字孪生 · AirportTwin — OPC Studio', en: 'Airport Digital Twin · AirportTwin — OPC Studio' },
  'nav.back':     { zh: '← 返回主页', en: '← Home' },
  'nav.title':    { zh: '机场数字孪生 · AirportTwin', en: 'Airport Digital Twin · AirportTwin' },
  'nav.langBtn':  { zh: 'EN', en: '中文' },

  // ── Panel titles ──
  'panel.config':    { zh: '✈ 机场控制台', en: '✈ Airport Console' },
  'panel.flights':   { zh: '🛬 航班动态',   en: '🛬 Flights' },
  'panel.log':       { zh: '运行日志',       en: 'Event Log' },
  'panel.analytics': { zh: '📈 数据分析与优化', en: '📈 Analytics & Optimization' },
  'panel.gateDetail':{ zh: '机位 · 地面保障', en: 'Gate · Ground Handling' },
  'panel.turnwall':  { zh: '🕑 过站监控墙',   en: '🕑 Turnaround Control' },

  // ── Config panel ──
  'cfg.interval':    { zh: '到港间隔 (秒)：', en: 'Arrival interval (s):' },
  'cfg.runwayMode':  { zh: '跑道模式',       en: 'Runway mode' },
  'cfg.dual':        { zh: '双跑道运行',     en: 'Dual runway' },
  'cfg.single':      { zh: '单跑道 (RWY1)',  en: 'Single (RWY1)' },
  'cfg.gateCount':   { zh: '机位数量：',     en: 'Gates:' },
  'cfg.bridgeCount': { zh: '廊桥数量：',     en: 'Jet bridges:' },
  'cfg.apply':       { zh: '应用配置',       en: 'Apply' },
  'cfg.emergency':   { zh: '🚨 应急操作',     en: '🚨 Emergency' },
  'cfg.spawn':       { zh: '立即新航班',     en: 'New flight' },
  'cfg.groundStop':  { zh: '全场地面停止',   en: 'Ground stop' },
  'cfg.resume':      { zh: '恢复运行',       en: 'Resume' },
  'cfg.atc':         { zh: '📡 ATC 状态',     en: '📡 ATC Status' },
  'cfg.next':        { zh: '下一航班：',     en: 'Next flight:' },
  'cfg.nextUnit':    { zh: '秒后',           en: 's' },
  'cfg.onGround':    { zh: '在场航班：',     en: 'On ground:' },
  'cfg.metering':    { zh: '离港排序（TSAT 放行）', en: 'Departure metering (TSAT)' },
  'cfg.set':         { zh: '单发滑行（省油）',     en: 'Single-engine taxi' },
  'cfg.agl':         { zh: '滑行引导（随行绿灯）', en: 'Taxi guidance (greens)' },

  // ── FIDS header ──
  'fids.flight':  { zh: '航班', en: 'Flight' },
  'fids.airline': { zh: '航司', en: 'Airline' },
  'fids.state':   { zh: '状态', en: 'Status' },
  'fids.gate':    { zh: '机位', en: 'Gate' },

  // ── Flight states (also 3D labels) ──
  'state.TAXIING_IN':  { zh: '进场', en: 'Inbound' },
  'state.AT_GATE':     { zh: '停靠', en: 'At gate' },
  'state.GATE_HOLD':   { zh: '待放行', en: 'Hold' },
  'state.PUSHBACK':    { zh: '推出', en: 'Pushback' },
  'state.TAXIING_OUT': { zh: '滑出', en: 'Taxi out' },
  'state.HOLDING':     { zh: '等待', en: 'Holding' },
  'state.TAKEOFF':     { zh: '起飞', en: 'Takeoff' },
  'state.DONE':        { zh: '离港', en: 'Departed' },

  // ── Stats bar ──
  'stat.arrivals':   { zh: '到港',     en: 'Arrivals' },
  'stat.departures': { zh: '离港',     en: 'Departures' },
  'stat.onGround':   { zh: '在场',     en: 'On ground' },
  'stat.gateUtil':   { zh: '机位占用', en: 'Gate util' },
  'stat.throughput': { zh: '吞吐/小时', en: 'Flights/hr' },

  // ── Analytics panel ──
  'an.gateUtil':   { zh: '机位占用', en: 'Gate util' },
  'an.interval':   { zh: '到港间隔', en: 'Arr. int.' },
  'an.avgTaxiIn':  { zh: '平均滑入', en: 'Avg taxi-in' },
  'an.avgDepWait': { zh: '离港等待', en: 'Dep. wait' },
  'an.throughput': { zh: '吞吐/时',  en: 'Flights/hr' },
  'an.noGate':     { zh: '机位溢出', en: 'Overflow' },
  'an.autoOpt':    { zh: '自动优化参数', en: 'Auto-optimize' },
  'an.export':     { zh: '导出日志', en: 'Export log' },
  'an.head':       { zh: '优化决策 / 运行日志', en: 'Optimization / Log' },
  'an.noActions':  { zh: '暂无优化动作', en: 'No optimization yet' },
  'an.logCounts':  { zh: '📊 日志：{e} 事件 · {s} 快照 · {t} 保障记录',
                     en: '📊 Log: {e} events · {s} snapshots · {t} turnarounds' },
  'an.decAction':  { zh: '到港间隔 {a}s → {b}s（{reason}）',
                     en: 'Arr. interval {a}s → {b}s ({reason})' },
  'an.reasonOverflow': { zh: '机位溢出 {n}',     en: 'gate overflow {n}' },
  'an.reasonHigh':     { zh: '机位占用 {p}%',    en: 'gate util {p}%' },
  'an.reasonLow':      { zh: '机位占用偏低 {p}%', en: 'low gate util {p}%' },

  // ── Gate detail ──
  'gd.waiting': { zh: '等待航班进位…', en: 'Awaiting aircraft…' },
  'gd.exit':    { zh: '← 返回全景',    en: '← Back' },
  'gd.suffix':  { zh: '· 地面保障',    en: '· Ground Handling' },
  'gd.acdm':    { zh: 'A-CDM 里程碑',  en: 'A-CDM Milestones' },

  // ── Turnaround Control wall ──
  'tw.atRiskN':  { zh: '⚠ {n} 个航班有超时风险', en: '⚠ {n} turnaround(s) at risk' },
  'tw.onTrackN': { zh: '✓ {n} 个航班过站中 · 均准点', en: '✓ {n} turnaround(s) · on track' },
  'tw.empty':    { zh: '暂无在站航班', en: 'No aircraft at gates' },
  'tw.pobt':     { zh: '就绪 ~{s}s', en: 'ready ~{s}s' },
  'tw.held':     { zh: '待放行 (TSAT)', en: 'Hold (TSAT)' },

  // ── Stand plan / allocation ──
  'panel.standplan': { zh: '🅿 机位计划', en: '🅿 Stand Plan' },
  'stand.contact': { zh: '廊桥',   en: 'Contact' },
  'stand.remote':  { zh: '远机位', en: 'Remote' },
  'stand.wide':    { zh: '宽体位', en: 'Wide' },
  'stand.narrow':  { zh: '窄体位', en: 'Narrow' },
  'sp.inbound':    { zh: '进港中', en: 'inbound' },
  'sp.now':        { zh: '现在',   en: 'now' },

  // ── AMAN arrival ladder ──
  'panel.aman': { zh: '🛬 到港排序 (AMAN)', en: '🛬 Arrival Ladder (AMAN)' },
  'aman.none':  { zh: '无进港航班', en: 'No inbounds' },

  // ── Dock 与全局窗口管理 ──
  'dock.control':  { zh: '控制',      en: 'Control' },
  'dock.ops':      { zh: '运行监控',  en: 'Operations' },
  'dock.analysis': { zh: '分析与安全', en: 'Analysis & Safety' },
  'dock.expand':   { zh: '详细/精简视图', en: 'Detailed / compact view' },
  'dock.settings': { zh: '全局设置',  en: 'Settings' },
  'dock.solo':     { zh: '单窗模式：调出新窗口时关闭已打开的窗口', en: 'Solo mode: opening a window closes the others' },
  // 各窗口核心功能一句话（dock 详细卡片图标下方展示）
  'dock.d.config':    { zh: '流量·速度·机位·跑道控制', en: 'Traffic, speed, stands & runway controls' },
  'dock.d.whatif':    { zh: '注入天气与跑道中断情景', en: 'Inject weather & runway disruptions' },
  'dock.d.flights':   { zh: '全场航班状态与里程碑', en: 'Live flights & A-CDM milestones' },
  'dock.d.aman':      { zh: '进港排序与延误吸收', en: 'Arrival sequencing & delay absorption' },
  'dock.d.turnwall':  { zh: '过站保障进度与风险预警', en: 'Turnaround progress & risk watch' },
  'dock.d.standplan': { zh: '机位占用甘特与分配', en: 'Stand occupancy Gantt & allocation' },
  'dock.d.radar':     { zh: '2D 场面态势总览', en: '2D surface situation overview' },
  'dock.d.log':       { zh: '运行事件实时流水', en: 'Live operational event stream' },
  'dock.d.analytics': { zh: '吞吐·准点·利用率 KPI', en: 'Throughput, OTP & utilisation KPIs' },
  'dock.d.dcb':       { zh: '跑道需求-容量热点预测', en: 'Runway demand-capacity hotspots' },
  'dock.d.safetynet': { zh: '跑道冲突 RIMCAS 告警', en: 'RIMCAS runway conflict alerts' },
  'dock.d.oooi':      { zh: 'OOOI 报文与滑行统计', en: 'OOOI reports & taxi-time stats' },
  'dock.d.replay':    { zh: '录制·导出·复盘运行', en: 'Record, export & replay runs' },

  // ── 底部运行控制 ──
  'act.pause':   { zh: '⏸ 暂停模拟', en: '⏸ Pause sim' },
  'act.resume':  { zh: '▶ 启动模拟', en: '▶ Start sim' },
  'act.live':    { zh: '🔗 对接真实机场', en: '🔗 Connect live data' },
  'act.save':    { zh: '💾 保存运行状态', en: '💾 Save state' },
  'log.simPaused':  { zh: '模拟已暂停', en: 'Simulation paused' },
  'log.simResumed': { zh: '模拟已启动', en: 'Simulation running' },

  // ── LIVE 数据源 ──
  'live.title':   { zh: '对接真实机场运行（预览版）', en: 'Connect live airport data (preview)' },
  'live.desc':    { zh: '通过 WebSocket 接入外部数据源：对端按本产品的标准快照契约（schemaVersion 1.0，见 GitHub 文档 §6.1）持续推送 JSON。连接期间本地模拟暂停，快照直接驱动航班动态、统计条与场面雷达；其余面板保持冻结。', en: 'Connect a WebSocket source that streams JSON snapshots in this product\'s standard contract (schemaVersion 1.0, see docs §6.1). While connected the local sim pauses; snapshots drive the flight board, stats bar and surface radar; other panels freeze.' },
  'live.connect': { zh: '连接', en: 'Connect' },
  'live.disconnect': { zh: '断开', en: 'Disconnect' },
  'live.close':   { zh: '关闭', en: 'Close' },
  'live.st.idle':       { zh: '未连接', en: 'Not connected' },
  'live.st.connecting': { zh: '连接中…', en: 'Connecting…' },
  'live.st.open':       { zh: '已连接，等待数据', en: 'Connected, awaiting data' },
  'live.st.data':       { zh: '已接收 {n} 帧快照', en: 'Received {n} snapshot frames' },
  'live.st.badframe':   { zh: '收到非快照格式的数据：{e}', en: 'Frame is not a snapshot: {e}' },
  'live.st.error':      { zh: '连接错误', en: 'Connection error' },
  'live.st.closed':     { zh: '连接已关闭', en: 'Connection closed' },
  'log.liveOn':   { zh: '🔗 已接入外部数据源，本地模拟暂停', en: '🔗 Live data connected — local sim paused' },
  'log.liveOff':  { zh: '外部数据源已断开，本地模拟恢复', en: 'Live data disconnected — local sim resumed' },

  // ── 保存/恢复运行状态 ──
  'save.saved':    { zh: '💾 运行状态已保存（{n} 架航班，T+{t}s）', en: '💾 State saved ({n} flights, T+{t}s)' },
  'save.restoreQ': { zh: '检测到上次保存的运行状态（{n} 架航班，T+{t}s）。要继续吗？', en: 'A saved state was found ({n} flights, T+{t}s). Continue from it?' },
  'save.restore':  { zh: '恢复继续', en: 'Restore' },
  'save.discard':  { zh: '重新开始', en: 'Start fresh' },
  'log.restored':  { zh: '已恢复上次运行状态（{n} 架航班）', en: 'Restored saved state ({n} flights)' },

  // ── Demand-Capacity Balancing forecast ──
  'panel.dcb':  { zh: '📈 需求-容量预测', en: '📈 Demand-Capacity (DCB)' },
  'dcb.next':   { zh: '⚠ 预计 ~{s}s 后出现容量热点', en: '⚠ Capacity hotspot in ~{s}s' },
  'dcb.clear':  { zh: '✓ 未来窗口容量充足', en: '✓ Within capacity' },
  'dcb.closed': { zh: '关闭', en: 'closed' },

  // ── Disruption / what-if console ──
  'panel.whatif':   { zh: '🌩 情景推演', en: '🌩 What-If Console' },
  'wi.weather':     { zh: '天气 (容量)', en: 'Weather (capacity)' },
  'wi.runways':     { zh: '跑道关闭',    en: 'Runway closure' },
  'wi.delta':       { zh: '相对基线',    en: 'Δ vs baseline' },
  'wi.noBaseline':  { zh: '触发中断后对比基线', en: 'Arm a disruption to compare' },
  'wi.activeBanner':{ zh: '⚠ 中断生效：{s}', en: '⚠ Disruption active: {s}' },
  'wi.closed':      { zh: '{r} 关闭', en: '{r} closed' },

  // ── ASDE-X surface surveillance radar ──
  'panel.radar': { zh: '🛰 场面监视雷达', en: '🛰 Surface Radar' },

  // ── RECALL surface replay ──
  'panel.replay':  { zh: '🎞 场面回放', en: '🎞 Surface Replay' },
  'rp.recording':  { zh: '记录中…',    en: 'recording…' },

  // ── A-SMGCS runway safety net (RIMCAS) ──
  'panel.safetynet': { zh: '🚨 A-SMGCS 安全网', en: '🚨 A-SMGCS Safety Nets' },
  'sn.clear':    { zh: '畅通',     en: 'CLEAR' },
  'sn.caution':  { zh: '警戒',     en: 'CAUTION' },
  'sn.alarm':    { zh: '冲突',     en: 'ALARM' },
  'sn.streak':   { zh: '无冲突时长', en: 'Conflict-free' },
  'sn.alarms':   { zh: '冲突',     en: 'Alarms' },
  'sn.cautions': { zh: '警戒',     en: 'Cautions' },
  'sn.cautionLabel': { zh: '⚠ 跑道占用', en: '⚠ RWY OCCUPIED' },
  'sn.alarmLabel':   { zh: '⛔ 跑道冲突', en: '⛔ RWY CONFLICT' },
  'sn.logHead':  { zh: '冲突记录',  en: 'Conflict log' },
  'sn.noAlerts': { zh: '暂无冲突',  en: 'No conflicts' },
  'sn.episode':  { zh: '{rwy} {kind} {dur}s', en: '{rwy} {kind} {dur}s' },
  'log.rimcas':  { zh: '⚠️ {rwy} 跑道{kind}告警', en: '⚠️ {rwy} runway {kind}' },

  // ── OOOI wire feed + ASPM taxi-time stats ──
  'panel.oooi':  { zh: '📻 OOOI / ASPM', en: '📻 OOOI / ASPM' },
  'aspm.head':   { zh: '滑行时间 · 中位/P90（秒）', en: 'Taxi time · median/P90 (s)' },
  'aspm.out':    { zh: '滑出', en: 'out' },
  'aspm.in':     { zh: '滑入', en: 'in' },
  'oooi.wait':   { zh: '等待 OOOI 事件…', en: 'Awaiting OOOI events…' },
  'an.onTime':  { zh: '准点',          en: 'On-time' },
  'an.avgTurn': { zh: '平均过站',      en: 'Avg turnaround' },
  'an.taxiOut': { zh: '平均滑出',      en: 'Avg taxi-out' },
  'an.gateHold':{ zh: '机位等待',      en: 'Gate hold' },
  'an.fuelSaved':{ zh: '估算节油',     en: 'Fuel saved' },
  'an.contact': { zh: '接驳率',        en: 'Contact %' },
  'an.standFit':{ zh: '选位匹配',      en: 'Stand fit' },
  'an.taxiCO2': { zh: '滑行碳排',      en: 'Taxi CO₂' },
  'an.setSaved':{ zh: '单发减排',      en: 'SET cut' },

  // ── Ground-handling nodes (by node id) ──
  'node.CHOCKS_ON':    { zh: '上轮挡',     en: 'Chocks on' },
  'node.BRIDGE':       { zh: '接廊桥/客梯', en: 'Bridge/stairs' },
  'node.DEPLANE':      { zh: '下客',       en: 'Deplane' },
  'node.UNLOAD_BAG':   { zh: '下行李',     en: 'Unload bags' },
  'node.CATERING':     { zh: '配餐',       en: 'Catering' },
  'node.WATER':        { zh: '清水车',     en: 'Potable water' },
  'node.LAV':          { zh: '污水车',     en: 'Lavatory' },
  'node.GARBAGE':      { zh: '垃圾车',     en: 'Cabin waste' },
  'node.REFUEL':       { zh: '加油',       en: 'Refuel' },
  'node.LOAD_BAG':     { zh: '上行李',     en: 'Load bags' },
  'node.BOARD':        { zh: '上客',       en: 'Boarding' },
  'node.CHOCKS_OFF':   { zh: '撤轮挡',     en: 'Chocks off' },
  'node.PUSHBACK_TUG': { zh: '牵引车推出', en: 'Pushback tug' },

  // ── Airlines (by Chinese name) ──
  'airline.国航': { zh: '国航', en: 'Air China' },
  'airline.东航': { zh: '东航', en: 'China Eastern' },
  'airline.南航': { zh: '南航', en: 'China Southern' },
  'airline.海航': { zh: '海航', en: 'Hainan' },
  'airline.厦航': { zh: '厦航', en: 'XiamenAir' },
  'airline.川航': { zh: '川航', en: 'Sichuan' },
  'airline.深航': { zh: '深航', en: 'Shenzhen' },
  'airline.首都': { zh: '首都', en: 'Capital' },
  'airline.测试': { zh: '测试', en: 'Test' },

  // ── Terminal / world labels ──
  'world.terminal': { zh: '客运航站楼', en: 'Passenger Terminal' },

  // ── Boot / log messages ──
  'boot.start':   { zh: '机场数字孪生系统启动', en: 'Airport digital twin online' },
  'boot.waiting': { zh: '等待首批航班进场…',   en: 'Awaiting first arrivals…' },
  'boot.hint':    { zh: '💡 点击机位可进入地面保障详情视图', en: '💡 Click a gate for ground-handling detail' },

  'log.spawned':  { zh: '{cs}（{al}）接近 {rwy}，机位 {gate}', en: '{cs} ({al}) approaching {rwy}, gate {gate}' },
  'log.arrived':  { zh: '{cs} 停靠机位 {gate}', en: '{cs} parked at gate {gate}' },
  'log.atcHold':  { zh: '{cs} 等待 {rwy} 起飞许可', en: '{cs} holding for {rwy} takeoff clearance' },
  'log.takeoff':  { zh: '{cs} 起飞离港', en: '{cs} departing' },
  'log.departed': { zh: '{cs} 已离港', en: '{cs} airborne' },
  'log.noGate':   { zh: '⚠️ {cs} 无可用机位', en: '⚠️ {cs} no gate available' },
  'log.groundStopOn': { zh: '⚠️ 全场地面停止生效', en: '⚠️ Ground stop in effect' },
  'log.groundStopCmd':{ zh: '⚠️ 全场地面停止指令', en: '⚠️ Ground stop command' },
  'log.resume':   { zh: '恢复正常运行', en: 'Normal operations resumed' },
  'log.bridgeConnect': { zh: '{cs} 廊桥对接，开始下客', en: '{cs} bridge connected, deplaning' },
  'log.bridgeRetract': { zh: '{cs} 廊桥撤离', en: '{cs} bridge retracted' },
  'log.gateEnter': { zh: '进入机位 {gate} 详情视图', en: 'Entered gate {gate} detail view' },
  'log.reconfig':  { zh: '配置更新：{g} 机位 / {b} 廊桥，间隔 {i}s，{r} 跑道',
                     en: 'Reconfigured: {g} gates / {b} bridges, interval {i}s, {r} runway(s)' },
  'log.blocked':   { zh: '⚠️ 机位 {ids} 有航班占用，无法缩减机位',
                     en: '⚠️ Gates {ids} occupied — cannot reduce gate count' },
  'log.autoOptOn': { zh: '已开启自动参数优化', en: 'Auto parameter optimization ON' },
  'log.autoOptOff':{ zh: '已关闭自动参数优化', en: 'Auto parameter optimization OFF' },
  'log.meterOn':   { zh: '已开启离港排序（TSAT 机位放行）', en: 'Departure metering ON (TSAT gate holds)' },
  'log.meterOff':  { zh: '已关闭离港排序', en: 'Departure metering OFF' },
  'log.setOn':     { zh: '已开启单发滑行（滑行省油）', en: 'Single-engine taxi ON (taxi fuel savings)' },
  'log.setOff':    { zh: '已关闭单发滑行', en: 'Single-engine taxi OFF' },
  'log.aglOn':     { zh: '已开启滑行引导绿灯', en: 'Follow-the-Greens taxi guidance ON' },
  'log.aglOff':    { zh: '已关闭滑行引导绿灯', en: 'Follow-the-Greens taxi guidance OFF' },
  'log.weather':   { zh: '天气变更：{w}', en: 'Weather set: {w}' },
  'log.rwyClosed': { zh: '⚠️ {r} 跑道关闭', en: '⚠️ Runway {r} closed' },
  'log.rwyOpened': { zh: '{r} 跑道恢复运行', en: 'Runway {r} reopened' },
  'log.tsat':      { zh: '{cs} 获 TSAT 放行（机位等待 {s}s，引擎未启动）',
                     en: '{cs} TSAT approved — held {s}s at gate, engines off' },
  'log.export':    { zh: '导出运行日志（{e} 事件 / {s} 快照）', en: 'Exported run log ({e} events / {s} snapshots)' },
};
