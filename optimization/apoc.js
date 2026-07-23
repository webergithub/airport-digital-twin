/**
 * APOC — Airport Operations Centre (Total Airport Management).
 *
 * Real airports increasingly run a single "predictive operations centre" (SESAR
 * Total Airport Management / APOC; e.g. WAISL AeroWise at Hyderabad, Heathrow's
 * APOC): one integrated picture that scores dozens of KPIs from every operational
 * domain against agreed targets, rolls them up to a performance status, and
 * surfaces what needs attention BEFORE it degrades operations.
 *
 * This module is that integration layer for the twin. It does NOT compute new
 * physics — it INGESTS the outputs the other modules already publish (analytics
 * KPIs, the A-SMGCS safety net, the DCB demand-capacity forecast, the turnaround
 * wall) and adds the management view the individual panels lack:
 *   1. every KPI rated Green / Amber / Red against an industry-style target,
 *   2. KPIs grouped into the four APOC domains (Capacity, Punctuality, Safety,
 *      Environment) and rolled up to a domain status,
 *   3. one composite Airport Performance Score (0–100),
 *   4. an alert feed — active breaches, worst first, plus the DCB look-ahead so
 *      the centre is *predictive*, not just reactive.
 *
 * It is advisory: it reads, rates and ranks; it never alters control logic.
 */

export const RAG = { GREEN: 'green', AMBER: 'amber', RED: 'red', NA: 'na' };
const PTS = { green: 100, amber: 55, red: 15 };          // KPI → score points
const CO2_PER_KG = 3.16;                                  // jet-A burn → CO₂ (same factor as analytics)

// A KPI: which domain it belongs to, how to pull its raw value from the ingested
// module outputs, how to format it, its human target, and how to rate it R/A/G.
// `dir` documents intent; the rate() closure is the source of truth.
const KPIS = [
  // ── Punctuality (A-CDM) ───────────────────────────────────────────────────
  { id: 'otp', domain: 'punc', dir: 'up', target: '≥ 80%',
    val: d => d.metrics.otp, na: d => (d.metrics.otpCount || 0) < 3,
    fmt: v => Math.round(v * 100) + '%',
    rate: v => v >= 0.80 ? RAG.GREEN : v >= 0.65 ? RAG.AMBER : RAG.RED },
  { id: 'depWait', domain: 'punc', dir: 'down', target: '≤ 120s',
    val: d => d.metrics.avgDepWait, na: d => (d.metrics.completed?.dep || 0) < 2,
    fmt: v => Math.round(v) + 's',
    rate: v => v <= 120 ? RAG.GREEN : v <= 300 ? RAG.AMBER : RAG.RED },

  // ── Capacity ──────────────────────────────────────────────────────────────
  { id: 'dcbPeak', domain: 'cap', dir: 'down', target: '< 1.0',
    val: d => d.dcb ? d.dcb.worstRatio : 0, na: d => !d.dcb,
    fmt: v => v.toFixed(2) + '×',
    rate: v => v < 0.85 ? RAG.GREEN : v < 1.0 ? RAG.AMBER : RAG.RED },
  { id: 'gateUtil', domain: 'cap', dir: 'band', target: '40–82%',
    val: d => d.metrics.gateUtil, na: () => false,
    fmt: v => Math.round(v * 100) + '%',
    rate: v => v > 0.92 ? RAG.RED : v > 0.82 ? RAG.AMBER : RAG.GREEN },
  { id: 'standContact', domain: 'cap', dir: 'up', target: '≥ 75%',
    val: d => d.metrics.standContactPct, na: d => (d.metrics.standCount || 0) < 2,
    fmt: v => Math.round(v * 100) + '%',
    rate: v => v >= 0.75 ? RAG.GREEN : v >= 0.5 ? RAG.AMBER : RAG.RED },

  // ── Airside safety (A-SMGCS / RIMCAS) ─────────────────────────────────────
  { id: 'rwyLive', domain: 'safe', dir: 'down', target: 'clear',
    val: d => d.safety ? Math.max(...Object.values(d.safety.runways).map(r => r.stage), 0) : 0,
    na: d => !d.safety, fmt: v => v === 2 ? 'ALARM' : v === 1 ? 'CAUTION' : 'CLEAR',
    rate: v => v >= 2 ? RAG.RED : v >= 1 ? RAG.AMBER : RAG.GREEN },
  { id: 'rwyAlarms', domain: 'safe', dir: 'down', target: '0',
    val: d => d.safety ? d.safety.alarms : 0, na: d => !d.safety,
    fmt: v => String(v),
    rate: v => v === 0 ? RAG.GREEN : RAG.RED },

  // ── Environment (Airport Carbon Accreditation) ────────────────────────────
  { id: 'setCut', domain: 'env', dir: 'up', target: '≥ 30%',
    val: d => d.metrics.setCutPct, na: d => !d.metrics.setEnabled,
    fmt: v => Math.round(v * 100) + '%',
    rate: v => v >= 0.30 ? RAG.GREEN : v >= 0.10 ? RAG.AMBER : RAG.RED },
];

const DOMAINS = ['cap', 'punc', 'safe', 'env'];

export class APOC {
  constructor() {
    this._state = null;
  }

  /**
   * Ingest one round of module outputs and recompute the operations picture.
   * @param {{metrics, safety, dcb, wall, stats, simTimeSec}} d
   */
  update(d) {
    const kpis = KPIS.map(k => {
      const na = k.na(d);
      const v  = na ? null : k.val(d);
      const rag = na || v == null || Number.isNaN(v) ? RAG.NA : k.rate(v);
      return { id: k.id, domain: k.domain, dir: k.dir, target: k.target,
               value: v, text: na || v == null ? '—' : k.fmt(v), rag };
    });

    // Roll KPIs up per domain, then domains up to one score. A domain with no
    // rated KPI (all N/A early in a run) is itself N/A and excluded from the mean.
    const domains = DOMAINS.map(dom => {
      const rated = kpis.filter(k => k.domain === dom && k.rag !== RAG.NA);
      const score = rated.length
        ? Math.round(rated.reduce((s, k) => s + PTS[k.rag], 0) / rated.length) : null;
      return { id: dom, score, rag: score == null ? RAG.NA : ragOf(score),
               kpis: kpis.filter(k => k.domain === dom) };
    });

    const scored = domains.filter(dm => dm.score != null);
    const score  = scored.length
      ? Math.round(scored.reduce((s, dm) => s + dm.score, 0) / scored.length) : 100;

    // The headline colour must never read greener than an open breach warrants:
    // a whole domain in the red forces the centre red; any single red KPI floors
    // the status at amber even when other domains pull the mean back up.
    let rag = ragOf(score);
    if (domains.some(dm => dm.rag === RAG.RED)) rag = RAG.RED;
    else if (rag === RAG.GREEN && kpis.some(k => k.rag === RAG.RED)) rag = RAG.AMBER;

    // Alert feed: every amber/red KPI, worst first; then the predictive item.
    const alerts = kpis
      .filter(k => k.rag === RAG.RED || k.rag === RAG.AMBER)
      .map(k => ({ sev: k.rag, domain: k.domain, kpi: k.id, text: k.text }))
      .sort((a, b) => (a.sev === RAG.RED ? 0 : 1) - (b.sev === RAG.RED ? 0 : 1));

    const nextHot = d.dcb ? d.dcb.nextHotspotSec : null;
    const lookahead = { nextHotspotSec: nextHot, worstRatio: d.dcb ? d.dcb.worstRatio : 0 };
    if (nextHot != null) {
      alerts.push({ sev: nextHot <= 120 ? RAG.RED : RAG.AMBER, domain: 'cap',
                    kpi: 'hotspot', text: '+' + nextHot + 's', predictive: true });
    }

    const co2 = (d.metrics.taxiCO2Kg || 0);
    this._state = {
      score, rag, domains, alerts,
      lookahead,
      headline: {
        throughput: d.stats ? d.stats.throughput : 0,
        onGround:   d.stats ? d.stats.onGround : 0,
        turnAtRisk: d.wall ? d.wall.atRisk : 0,
        taxiCO2Kg:  +co2.toFixed(1),
      },
      simTimeSec: d.simTimeSec || 0,
    };
    return this._state;
  }

  getState() { return this._state; }
}

/** Map a 0–100 score to an overall RAG band. */
function ragOf(score) {
  return score >= 82 ? RAG.GREEN : score >= 62 ? RAG.AMBER : RAG.RED;
}
