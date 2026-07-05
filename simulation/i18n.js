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
  'an.onTime':  { zh: '准点',          en: 'On-time' },
  'an.avgTurn': { zh: '平均过站',      en: 'Avg turnaround' },
  'an.taxiOut': { zh: '平均滑出',      en: 'Avg taxi-out' },
  'an.gateHold':{ zh: '机位等待',      en: 'Gate hold' },
  'an.fuelSaved':{ zh: '估算节油',     en: 'Fuel saved' },

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
  'log.tsat':      { zh: '{cs} 获 TSAT 放行（机位等待 {s}s，引擎未启动）',
                     en: '{cs} TSAT approved — held {s}s at gate, engines off' },
  'log.export':    { zh: '导出运行日志（{e} 事件 / {s} 快照）', en: 'Exported run log ({e} events / {s} snapshots)' },
};
