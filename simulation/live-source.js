/**
 * LiveSource — "对接真实机场运行" 的数据源客户端（预览版 MVP）。
 *
 * 通过 WebSocket 接入外部数据源：对端按本产品的标准快照契约
 * （getSnapshot() 形状，见规格说明书 §6.1；schemaVersion '1.0'）持续推送
 * JSON 文本消息。连接期间本地模拟暂停推进，快照直接驱动纯快照消费的
 * 视图（FIDS / 统计条 / 场面雷达）；依赖本地控制层内部状态的面板保持冻结。
 */
export class LiveSource {
  constructor() { this._ws = null; this._n = 0; }

  get connected() { return !!this._ws && this._ws.readyState === 1; }
  get frames() { return this._n; }

  connect(url, { onSnapshot, onStatus }) {
    this.disconnect();
    this._n = 0;
    let ws;
    try { ws = new WebSocket(url); }
    catch (e) { onStatus && onStatus('error', String(e.message || e)); return; }
    this._ws = ws;
    onStatus && onStatus('connecting', url);
    ws.onopen = () => onStatus && onStatus('open', url);
    ws.onmessage = (ev) => {
      try {
        const snap = JSON.parse(ev.data);
        if (!snap || !Array.isArray(snap.flights)) throw new Error('not a snapshot');
        this._n++;
        onSnapshot && onSnapshot(snap);
        if (this._n % 20 === 1) onStatus && onStatus('data', String(this._n));
      } catch (e) {
        onStatus && onStatus('badframe', String(e.message || e));
      }
    };
    ws.onerror = () => onStatus && onStatus('error', 'websocket error');
    ws.onclose = () => { if (this._ws === ws) { this._ws = null; onStatus && onStatus('closed', ''); } };
  }

  disconnect() {
    if (this._ws) { const w = this._ws; this._ws = null; try { w.close(); } catch (e) {} }
  }
}
