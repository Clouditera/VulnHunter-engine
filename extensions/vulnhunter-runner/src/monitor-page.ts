// ---------------------------------------------------------------------------
// SPA
// ---------------------------------------------------------------------------

export const SPA = `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VulnHunter · Workflow 观察台</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
/* Read-only snapshot: packages/web/src/shared/theme/tokens.css (2026-09-14). No new colors. */
:root {
  /* Brand blue */
  --brand: #298cff;
  --brand-hover: #1871f5;
  --brand-active: #145be1;
  --brand-soft: rgba(41, 140, 255, 0.1);
  --brand-border: rgba(41, 140, 255, 0.2);
  --brand-disabled-bg: #eef7ff;

  /* Danger (separated from brand) */
  --danger: #c22828;
  --danger-hover: #a61f1f;
  --danger-soft: rgba(194, 40, 40, 0.1);
  --danger-border: rgba(194, 40, 40, 0.28);

  /* Special purple (admin badge etc.) */
  --special: #9285ff;
  --special-soft: rgba(146, 133, 255, 0.12);
  --special-border: rgba(146, 133, 255, 0.35);

  /* Neutrals light */
  --nav-bg: #1b2033;
  --bg-page: #f8f8f8;
  --bg-card: #ffffff;
  --bg-header: #f8fafe;
  --text-primary: #0a1730;
  --text-secondary: #616d7e;
  --text-tertiary: #bbc3cc;
  --icon-muted: #a5afbc;
  --border: #e7e8eb;
  --divider: #e7e8eb;

  /* Severity / functional (dots/borders/soft bg only; text stays neutral) */
  --sev-critical: #c22828;
  --sev-high: #f24f4f;
  --sev-medium: #ff733c;
  --sev-low: #f7c530;
  --sev-info: #9ca3af;

  /* Audit Progress — green-depth ramp (not brand) */
  --audit-none: #9ca3af;
  --audit-low: #86efac;
  --audit-mid: #22c55e;
  --audit-high: #15803d;

  /* Code viewer */
  --code-bg: #f8fafc;
  --code-text: #0f172a;
  --code-comment: #94a3b8;
  --code-line-number: #cbd5e1;
  --code-vuln-bg: rgba(194, 40, 40, 0.08);
  --code-vuln-border: rgba(194, 40, 40, 0.35);
  --terminal-bg: #0a0a0a;

  /* Semantic status */
  --status-running: #28d1ff;
  --status-completed: #3ad186;
  --status-failed: #c22828;
  --status-cancelled: #616d7e;
  --status-queued: #f7c530;
  --status-paused: #ff733c;

  /* Backgrounds */
  --bg-success: rgba(58, 209, 134, 0.1);
  --bg-success-border: rgba(58, 209, 134, 0.28);
  --bg-success-text: #0a1730;
  --bg-warning: rgba(247, 197, 48, 0.12);
  --bg-error: rgba(194, 40, 40, 0.08);
  --bg-info: rgba(41, 140, 255, 0.08);
  --bg-purple: rgba(146, 133, 255, 0.1);
  --bg-disabled: #e7e8eb;
  --bg-hover: rgba(10, 23, 48, 0.04);
  --bg-active-filter: rgba(41, 140, 255, 0.12);

  /* Button */
  --btn-primary-text: #ffffff;

  /* Live log (terminal context) */
  --log-tab-border: #333333;
  --log-tab-active: #ffffff;
  --log-tab-inactive: #737373;
  --log-text-tool: #e5e5e5;
  --log-text-dim: #737373;
  --log-text-timestamp: #555555;
  --log-stage-start: #f7c530;
  --log-stage-end: #3ad186;
  --log-pill-bg: #333333;
  --log-pill-text: #e5e5e5;

  /* Charts */
  --chart-bar: #298cff;

  /* Review Status */
  --review-pending: #f7c530;
  --review-confirmed: #3ad186;
  --review-false-positive: #616d7e;
  --review-ignored: #a5afbc;
  --review-pending-bg: rgba(247, 197, 48, 0.12);
  --review-confirmed-bg: rgba(58, 209, 134, 0.12);
  --review-false-positive-bg: rgba(97, 109, 126, 0.1);
  --review-ignored-bg: rgba(165, 175, 188, 0.1);

  /* Partner / CloudRouter soft blue */
  --partner-grad-from: #eef7ff;
  --partner-grad-to: #f0f7ff;
  --partner-border: rgba(41, 140, 255, 0.28);
  --partner-accent: #1871f5;

  /* Font stacks */
  --font-sans: "Roboto", "Source Han Sans CN", "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  /* Markdown inline code tint (typography v1.0) */
  --md-code-inline-bg: rgba(97, 109, 126, 0.10);
}
:root[data-theme="dark"] {
  --md-code-inline-bg: rgba(187, 195, 204, 0.14);
  --bg-page: #131828;
  --bg-card: #1b2033;
  --bg-header: #232a40;
  --text-primary: #ffffff;
  --text-secondary: #bbc3cc;
  --text-tertiary: #616d7e;
  --icon-muted: #a5afbc;
  --border: rgba(255, 255, 255, 0.09);
  --divider: rgba(255, 255, 255, 0.09);

  --brand-soft: rgba(41, 140, 255, 0.15);
  --brand-border: rgba(41, 140, 255, 0.35);
  --danger-soft: rgba(194, 40, 40, 0.15);
  --danger-border: rgba(194, 40, 40, 0.4);
  --special-soft: rgba(146, 133, 255, 0.18);
  --special-border: rgba(146, 133, 255, 0.4);

  --bg-success: rgba(58, 209, 134, 0.12);
  --bg-success-border: rgba(58, 209, 134, 0.35);
  --bg-success-text: #86efac;
  --bg-warning: rgba(247, 197, 48, 0.12);
  --bg-error: rgba(194, 40, 40, 0.14);
  --bg-info: rgba(41, 140, 255, 0.14);
  --bg-purple: rgba(146, 133, 255, 0.14);
  --bg-disabled: #404040;
  --bg-hover: rgba(255, 255, 255, 0.06);
  --bg-active-filter: rgba(41, 140, 255, 0.18);

  --btn-primary-text: #ffffff;

  --code-bg: #1e1e1e;
  --code-text: #d4d4d4;
  --code-comment: #6b7280;
  --code-line-number: #525252;
  --code-vuln-bg: rgba(194, 40, 40, 0.14);
  --code-vuln-border: rgba(194, 40, 40, 0.45);

  --review-pending: #eab308;
  --review-confirmed: #3ad186;
  --review-false-positive: #a3a3a3;
  --review-ignored: #737373;
  --review-pending-bg: rgba(234, 179, 8, 0.15);
  --review-confirmed-bg: rgba(58, 209, 134, 0.15);
  --review-false-positive-bg: rgba(163, 163, 163, 0.1);
  --review-ignored-bg: rgba(115, 115, 115, 0.1);

  --partner-grad-from: rgba(41, 140, 255, 0.16);
  --partner-grad-to: rgba(20, 91, 225, 0.12);
  --partner-border: rgba(41, 140, 255, 0.35);
  --partner-accent: #60a5fa;
}
*{box-sizing:border-box}html{color-scheme:light}html[data-theme="dark"]{color-scheme:dark}body{margin:0;background:var(--bg-page);color:var(--text-primary);font:13px/1.55 system-ui,-apple-system,"Microsoft YaHei",sans-serif}button,select,input{font:inherit;color:inherit}button,select{cursor:pointer}button,a,summary,select{touch-action:manipulation}button{background:var(--bg-card);border:1px solid var(--border);border-radius:5px;padding:5px 10px}button:hover,select:hover{background:var(--bg-hover)}button:focus-visible,a:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--brand);outline-offset:3px}a,.link{color:var(--partner-accent);text-decoration:none}a:hover,.link:hover{text-decoration:underline}button.link{padding:0;border:0;background:none}h1,h2,h3,p{margin:0}h1{font-size:23px;line-height:1.25;letter-spacing:-.5px}h2{font-size:14px}h3{font-size:13px}code,.mono,.num{font-family:var(--font-mono);font-variant-numeric:tabular-nums}.muted{color:var(--text-secondary)}.small{font-size:11px}.caps{font:11px var(--font-mono);letter-spacing:1px;text-transform:uppercase;color:var(--text-secondary)}.row{display:flex;align-items:center;gap:10px}.spread{justify-content:space-between}.wrap{flex-wrap:wrap}.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--text-secondary);flex-shrink:0}.dot.running{background:var(--status-running)}.dot.done{background:var(--status-completed)}.dot.error{background:var(--status-failed)}.dot.queued{background:var(--status-queued)}.badge{display:inline-flex;align-items:center;gap:6px;padding:2px 7px;border-radius:4px;font-size:11px;border:1px solid var(--border);white-space:nowrap}.badge.running{background:var(--bg-info);border-color:var(--brand-border)}.badge.done{background:var(--bg-success);border-color:var(--bg-success-border)}.badge.error{background:var(--bg-error);border-color:var(--danger-border)}.badge.warn{background:var(--bg-warning)}.icon{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}.topbar{border-bottom:1px solid var(--border);height:56px;padding:0 28px;background:var(--bg-card)}.brandname{font-size:16px;font-weight:650;letter-spacing:-.3px}.brandmark{color:var(--brand);display:flex}.slash{color:var(--text-secondary);margin:0 5px}.previewbar{padding:7px 28px;background:var(--bg-header);border-bottom:1px solid var(--border);font-size:11px}.previewbar select{background:var(--bg-card);border:1px solid var(--border);border-radius:4px;font-size:11px;padding:3px 22px 3px 6px}.previewbar .row{gap:7px}.layout{max-width:1600px;margin:auto;padding:22px 28px 30px}.runheading{margin-bottom:17px}.runheading .eyebrow{margin-bottom:7px}.runheading .sub{margin-top:7px}.runtime{text-align:right}.runtime strong{font-size:24px;font-weight:500;line-height:1.1}.runtime p{margin-top:4px}.params{border:1px solid var(--border);border-radius:7px;background:var(--bg-card);display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px}.paramset{gap:20px}.param{display:flex;align-items:baseline;gap:7px}.param code{font-size:12px}.param b{font-size:12px;font-weight:500}.configdetail{border:1px solid var(--border);border-top:0;background:var(--bg-card);padding:14px;border-radius:0 0 7px 7px}.configgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:9px 18px}.configitem{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--divider);padding-bottom:7px}.configitem code{font-size:11px;color:var(--text-secondary)}.sectionheading{margin:20px 0 10px}.pipeline{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:7px}.stage{position:relative;border:1px solid var(--border);border-radius:6px;background:var(--bg-card);text-align:left;padding:12px 13px;min-width:0}.stage::after{content:'›';position:absolute;right:-7px;top:25px;color:var(--text-secondary);z-index:1;background:var(--bg-page);font-size:16px;line-height:14px}.stage:last-child::after{display:none}.stage .row{gap:7px}.stage strong{font-size:13px}.stage .stepnum{font:10px var(--font-mono);color:var(--text-secondary)}.stage .status{font-size:11px;margin-top:8px;display:flex;justify-content:space-between;gap:4px}.stage.running{border-color:var(--brand);background:var(--bg-info)}.stage.error{border-color:var(--danger);background:var(--bg-error)}.stage.pending{border-style:dashed;background:none}.stage.pending strong{color:var(--text-secondary)}.stage.selected{box-shadow:inset 0 -2px var(--brand)}.stagegroups{display:grid;grid-template-columns:4fr 1fr 1fr;gap:7px;margin:7px 0 15px;text-align:center}.stagegroups span{border-bottom:1px solid var(--border);padding-bottom:6px;font-size:10px;color:var(--text-secondary)}.workspace{display:grid;grid-template-columns:310px minmax(0,1fr);gap:13px;align-items:stretch}.panel{border:1px solid var(--border);border-radius:8px;background:var(--bg-card);overflow:hidden;min-width:0}.panelhead{padding:13px 16px;border-bottom:1px solid var(--border)}.panelhead .index{font:11px var(--font-mono);color:var(--text-secondary)}.panelhead .subtitle{font-size:11px;color:var(--text-secondary);margin-top:3px}.panel.active{border-color:var(--brand-border)}.panel.failed{border-color:var(--danger-border)}.panelbody{padding:15px 16px}.metricrow{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}.metric strong{font:25px/1.2 var(--font-mono);letter-spacing:-1px}.metric span{font-size:11px;margin-left:5px;color:var(--text-secondary)}.metric p{font-size:11px;color:var(--text-secondary);margin-top:4px}.rounds{display:grid;grid-template-columns:repeat(9,1fr);gap:3px;margin-top:7px}.round{border:1px solid var(--border);border-radius:3px;text-align:center;font:11px var(--font-mono);padding:6px 0}.round small{display:block;color:var(--text-secondary);font-size:9px;margin-bottom:4px}.round.zero{background:var(--bg-hover)}.round.inprogress{border-color:var(--brand);background:var(--bg-info)}.round.failedround{border-color:var(--danger);background:var(--bg-error)}.coverage{margin-top:15px}.track{height:4px;background:var(--bg-disabled);border-radius:3px;margin:8px 0 5px;position:relative}.fill{height:100%;background:var(--status-queued);border-radius:3px;width:55.7%}.target{position:absolute;left:90%;top:-3px;width:1px;height:10px;background:var(--text-secondary)}.notebox{border-left:2px solid var(--status-queued);background:var(--bg-warning);padding:8px 10px;font-size:11px;margin-top:14px}.notebox.info{border-color:var(--brand);background:var(--bg-info)}.notebox.error{border-color:var(--danger);background:var(--bg-error)}.poolbody{display:grid;grid-template-columns:minmax(0,1fr) 185px}.verify{min-width:0;border-right:1px solid var(--border)}.pooltitle{padding:12px 15px 9px}.capacity{display:flex;gap:3px;margin-left:6px}.slotbar{height:6px;width:21px;border-radius:2px;background:var(--brand)}.slotbar.off{background:var(--bg-disabled)}.pooltitle strong{font:18px var(--font-mono);margin-left:6px}.taskhead,.taskrow{display:grid;grid-template-columns:25px minmax(0,1fr) 82px 58px;gap:8px;align-items:center;padding:8px 15px}.taskhead{font-size:10px;color:var(--text-secondary);background:var(--bg-header);border-block:1px solid var(--border)}.taskrow{border-bottom:1px solid var(--border);min-height:62px}.taskrow:hover{background:var(--bg-hover)}.taskrow .slotid{font:10px var(--font-mono);color:var(--text-secondary)}.taskrow .tasklabel{font:12px var(--font-mono);font-weight:500}.sessionid{font:10px var(--font-mono);color:var(--text-secondary);display:block;overflow-wrap:anywhere;margin-top:2px}.taskrow .agent{font-size:10px}.taskrow .elapsed{font:11px var(--font-mono);text-align:right}.taskrow .elapsed a{font:10px system-ui;display:block;margin-top:3px}.queue{padding:11px 15px 12px}.queuegrid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}.queuetask{display:flex;align-items:center;gap:7px;font:10px var(--font-mono);background:var(--bg-header);border:1px solid var(--border);border-radius:4px;padding:6px 8px}.queuetask .rank{color:var(--text-secondary);font-size:9px}.sandbox{padding:13px 14px;min-width:0}.sandbox .mutedslot{height:54px;border:1px dashed var(--border);border-radius:5px;display:flex;align-items:center;justify-content:center;color:var(--text-secondary);margin:14px 0 10px;font:22px var(--font-mono);background:var(--bg-page)}.sandbox p{font-size:11px;color:var(--text-secondary);margin-top:6px}.sandbox hr{border:0;border-top:1px solid var(--border);margin:15px 0}.poolfoot{border-top:1px solid var(--border);font-size:10px;color:var(--text-secondary);padding:9px 15px}.waiting{padding:28px 18px;text-align:center;color:var(--text-secondary)}.waiting strong{display:block;color:var(--text-primary);font-weight:500;margin:8px 0}.waiting .empty-slots{display:flex;gap:7px;justify-content:center;margin:14px 0}.waiting .empty-slots span{border:1px dashed var(--border);padding:9px 30px;border-radius:5px;font-family:var(--font-mono)}.lowergrid{display:grid;grid-template-columns:1fr 1fr;gap:13px;margin-top:16px}.slimhead{padding:10px 15px;border-bottom:1px solid var(--border)}.slimhead h2{font-size:12px}.support{padding:11px 15px;font-size:11px}.support .record{display:flex;justify-content:space-between;gap:12px;padding-bottom:9px}.support .record:last-child{padding:0}.event{display:grid;grid-template-columns:63px 7px 1fr;gap:8px;padding:3px 0;font-size:11px}.event time{font-family:var(--font-mono);color:var(--text-secondary)}.event .dot{margin-top:6px;width:5px;height:5px}.history{margin-top:16px;border:1px solid var(--border);border-radius:7px;background:var(--bg-card)}.history summary{padding:10px 15px;cursor:pointer;font-size:11px;color:var(--text-secondary)}.history table{width:100%;border-collapse:collapse;font-size:11px}.history th,.history td{padding:8px 15px;border-top:1px solid var(--border);text-align:left}.history th{font-weight:400;color:var(--text-secondary);font-size:10px}.history tr:hover td{background:var(--bg-hover)}.footer{font-size:10px;color:var(--text-secondary);margin-top:18px}.banner{border:1px solid var(--danger-border);border-radius:6px;background:var(--bg-error);padding:10px 14px;margin-bottom:17px;font-size:12px;display:flex;align-items:center;justify-content:space-between;gap:10px}.banner.warn{border-color:var(--border);background:var(--bg-warning)}.emptyview{min-height:510px;border:1px dashed var(--border);border-radius:8px;display:flex;align-items:center;justify-content:center;text-align:center;background:var(--bg-card)}.emptyview .emptyicon{display:inline-flex;padding:14px;border:1px solid var(--border);border-radius:10px;color:var(--brand);margin-bottom:20px}.emptyview h1{font-size:20px}.emptyview p{margin-top:10px;color:var(--text-secondary);font-size:12px}.emptyview pre{padding:13px 18px;border-radius:5px;background:var(--bg-page);color:var(--text-secondary);text-align:left;margin:20px auto 0;font:11px/1.7 var(--font-mono);max-width:520px;white-space:pre-wrap}.emptyview .emptycolumns{display:flex;gap:35px;justify-content:center;margin-top:25px;color:var(--text-secondary);font-size:11px}.emptyview .emptycolumns b{font:18px var(--font-mono);display:block;color:var(--text-primary);margin-bottom:4px}dialog{max-width:640px;width:calc(100% - 32px);background:var(--bg-card);color:var(--text-primary);border:1px solid var(--border);border-radius:9px;padding:0}dialog::backdrop{background:var(--nav-bg);opacity:.8}.dialogbody{padding:20px;max-height:70vh;overflow:auto}.dialogbody p{margin:10px 0;color:var(--text-secondary);font-size:12px}.dialogbody pre{background:var(--bg-page);padding:12px;font:11px/1.7 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere}.dialogbody .kv{display:grid;grid-template-columns:100px 1fr;gap:8px;font-size:12px}.dialogbody .kv code{overflow-wrap:anywhere}#toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--bg-header);border:1px solid var(--brand-border);border-radius:6px;padding:9px 15px;font-size:12px;z-index:10}[hidden]{display:none!important}
@media(min-width:1450px){.workspace{grid-template-columns:340px minmax(0,1fr)}.taskhead,.taskrow{grid-template-columns:25px minmax(0,1fr) 105px 62px}.poolbody{grid-template-columns:minmax(0,1fr) 210px}}
@media(max-width:1150px){.layout{padding:20px}.paramset{gap:12px}.param{gap:5px}.param code{font-size:11px}.workspace{grid-template-columns:285px minmax(0,1fr)}.poolbody{grid-template-columns:minmax(0,1fr) 158px}.taskhead,.taskrow{grid-template-columns:18px minmax(0,1fr) 53px;padding-inline:12px;gap:6px}.taskrow .agent,.taskhead .agent{display:none}.queuegrid{grid-template-columns:1fr 1fr}.queuetask{font-size:9px;padding:5px}.stage{padding:10px}.sandbox{padding:12px}.previewbar{padding-inline:20px}}
@media(max-width:850px){.workspace{grid-template-columns:1fr}.params,.paramset{flex-wrap:wrap}.params{align-items:flex-start}.paramset{gap:9px 20px}.pipeline{grid-template-columns:repeat(3,minmax(0,1fr))}.stagegroups{display:none}.pipeline{margin-bottom:14px}.stage:nth-child(3)::after{display:none}.huntbody{display:grid;grid-template-columns:1fr 1fr;gap:14px}.huntbody .coverage{margin-top:0}.huntbody .notebox{margin-top:10px}.huntbody .metricrow{margin-bottom:10px}.lowergrid{grid-template-columns:1fr}.poolbody{grid-template-columns:minmax(0,1fr) 185px}.previewbar>.row{flex-wrap:wrap}.configgrid{grid-template-columns:1fr 1fr}.topbar{padding-inline:20px}.topbar .service{display:none}.runheading h1{font-size:20px}.layout{padding:17px 16px}.runheading{align-items:flex-start}}
@media(max-width:520px){.previewbar{padding:7px 16px}.previewbar .hint{display:none}.topbar{padding-inline:16px}.topbar .muted.brandlabel{display:none}.runtime strong{font-size:20px}.runtime .small{font-size:10px}.runheading .row{gap:6px}.runheading{flex-wrap:wrap;gap:12px}.runheading>div:first-child{width:100%}.runtime{display:flex;align-items:baseline;gap:8px;text-align:left;flex-wrap:wrap}.runtime p{margin:0}.runheading .sub{max-width:none;overflow-wrap:anywhere}.huntbody{display:block}.poolbody{grid-template-columns:1fr}.verify{border-right:0}.sandbox{border-top:1px solid var(--border)}.sandbox .mutedslot{height:35px;margin:8px 0}.sandbox hr{margin:8px 0}.sandbox .sandboxextra{display:none}.queuegrid{grid-template-columns:1fr 1fr}.queuetask{font-size:10px}.configgrid{grid-template-columns:1fr}.stage .row{gap:5px}.stage strong{font-size:12px}.stage .stepnum{display:none}.stage .status{font-size:10px}.emptyview{padding:25px 16px}.emptyview .emptycolumns{gap:24px}.history{overflow:auto}.banner{align-items:flex-start}.paramset{gap:8px 15px}}
</style></head>

<header class="topbar row spread"><div class="row"><span class="brandmark"><svg class="icon" viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></span><span class="brandname">VulnHunter</span><span class="slash">/</span><span class="muted brandlabel">运行观察台</span></div><div class="row muted small"><span class="service mono">runner 观察台</span><span class="badge">只读</span><button id="theme" aria-label="切换主题">浅色</button></div></header>
<main class="layout" id="main"></main>
<dialog id="inspector" aria-labelledby="dialogtitle"><div class="panelhead row spread"><h2 id="dialogtitle"></h2><button id="closedialog" aria-label="关闭详情">关闭 ×</button></div><div class="dialogbody" id="dialogbody"></div></dialog><div id="toast" role="status" hidden></div>
<script>
// 生产版观察台主页脚本（接 /api/state + /api/run，3s 轮询）
const S = { lastGood: null, lastSync: 0, gen: 0, configOpen: false, offline: false };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const badge = (text, status = "") => \`<span class="badge \${status}">\${status ? \`<i class="dot \${status}"></i>\` : ""}\${text}</span>\`;
const fm = (ms) => ms == null ? "—" : \`\${Math.floor(ms / 60000)}m \${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}s\`;
const fmShort = (ms) => ms == null ? "—" : ms < 60000 ? \`\${Math.floor(ms / 1000)}s\` : fm(ms);
const ts = (t) => new Date(t).toTimeString().slice(0, 8);
const enc = encodeURIComponent;

async function j(u) { const r = await fetch(u); if (!r.ok) throw new Error(String(r.status)); return r.json(); }

async function tick() {
  const g = ++S.gen;
  try {
    const st = await j("/api/state");
    const run = st.runs.find((r) => r.status === "running") ?? st.runs[0] ?? null;
    let detail = null;
    if (run) detail = await j(\`/api/run?workdir=\${enc(run.workdir)}&runId=\${enc(run.runId)}\`);
    if (g !== S.gen) return;
    S.lastGood = { st, run, detail };
    S.lastSync = Date.now();
    S.offline = false;
  } catch (e) {
    if (g !== S.gen) return;
    S.offline = true;
  }
  render();
}

function pickStageOrder(state) { return state && state.stages ? Object.keys(state.stages) : ["onboard", "build", "research", "compress", "hunt", "chains"]; }

function render() {
  const snap = S.lastGood;
  const now = S.offline ? S.lastSync : Date.now();
  const scrollY = window.scrollY;
  if (!snap) {
    $("main").innerHTML = \`<div class="emptyview" style="min-height:70vh"><div><h1>连接观察台失败</h1><p>服务可能尚未启动或已退出（VULNHUNTER_WEB=1 起 run 后本页可用）。持续重试中…</p></div></div>\`;
    return;
  }
  const { st, run, detail } = snap;
  if (!run) {
    $("main").innerHTML = \`<div class="row spread runheading"><div><p class="caps eyebrow">PROCESS OVERVIEW</p><h1>等待 workflow 启动</h1></div>\${badge("服务可访问", "done")}</div><div class="emptyview"><div><h1>本进程还没有 run</h1><p>通过 vulnhunter 工具或驱动启动 workflow 后，阶段、配置和任务会出现在这里。</p><pre>VULNHUNTER_WEB=1\\nVULNHUNTER_WEB_HOST=0.0.0.0\\nVULNHUNTER_WEB_PORT=4100</pre></div></div><div class="footer">空态不会把缺失的 workflow 配置渲染成 0 并发。</div>\`;
    return;
  }
  const state = detail?.state ?? {};
  const stagesObj = state.stages ?? {};
  const order = pickStageOrder(state);
  const stageTimes = (state.data && state.data.stageTimes) || {};
  const cfg = run.config ?? {};
  const cur = run.status === "running" ? run.currentStage : null;
  const failedStage = order.find((k) => stagesObj[k] === "failed");
  const hunting = cur === "hunt";
  const dynamic = run.sandbox === true;
  const elapsed = (run.endedAt ?? now) - run.startedAt;

  const stageMeta = (name) => {
    const stt = stagesObj[name] ?? "pending";
    const label = { done: "已完成", failed: "失败", pending: cur === name ? "进行中" : "待开始", skipped: "已跳过" }[stt] ?? "未知";
    const ui = stt === "failed" ? "error" : cur === name ? "running" : stt === "done" ? "done" : "pending";
    let time = null;
    const t = stageTimes[name];
    if (t) time = cur === name && run.status === "running" ? now - new Date(t.start).getTime() : t.ms;
    return { stt, label, ui, time };
  };
  const doneCount = order.filter((k) => stagesObj[k] === "done").length;

  // hunt 数据
  const arrLen = (v) => Array.isArray(v) ? v.length : 0;
  const roundHyps = (state.data && state.data.roundHyps) || {};
  const roundKeys = Object.keys(roundHyps).sort((a, b) => Number(a.replace(/\\D+/g, "")) - Number(b.replace(/\\D+/g, "")));
  const hypTotal = roundKeys.reduce((n, k) => n + arrLen(roundHyps[k]), 0);
  const doneRounds = (state.data && state.data.huntRound) || roundKeys.length;
  const cov = detail?.coverage ?? null;
  const threshold = String(cfg.hunt_coverage_threshold ?? "").replace(/[^0-9.]/g, "") || "90";
  const stopEv = [...(st.events ?? [])].reverse().find((e) => /停轮/.test(e.msg));

  // 池数据
  const vp = (st.pools ?? []).find((p) => p.name === "verify");
  // 沙箱=资源容量（非池，fish 09-21）：dynamic verify / ev 段嵌套占用
  const sc = (st.capacities ?? []).find((c) => c.name === "sandbox");
  const conc = Number(String(cfg.chain_concurrency ?? "3").replace(/\\D+/g, "")) || 3;
  const sessOf = (label) => (st.running ?? []).find((n) => n.target === label);
  const outSessions = (st.running ?? []).filter((n) => n.agent !== "hyp-chain");
  const chainsState = stagesObj.chains ?? "pending";

  const banner = S.offline
    ? \`<div class="banner warn"><span><strong>连接已中断</strong> · 最后成功同步 \${ts(S.lastSync)}。以下为旧快照，状态已冻结；服务可能已退出。</span></div>\`
    : failedStage
      ? \`<div class="banner"><span><strong>\${esc(failedStage)} 阶段失败</strong> · \${esc(run.note ?? "")}。这不是正常停轮。</span></div>\` : "";

  const paramStrip = \`<div class="params"><div class="row wrap paramset">
    <span class="param"><span class="muted small">模型</span><code>\${esc(cfg.model ?? "—")}</code></span>
    <span class="param"><span class="muted small">hunt</span><b class="mono">1</b><span class="small muted">固定串行</span></span>
    <span class="param"><span class="muted small">verify</span><b class="mono">×\${esc(String(cfg.chain_concurrency ?? "—"))}</b><span class="small muted">可配置</span></span>
    <span class="param"><span class="muted small">模式</span><b>\${dynamic ? "动态验证" : "纯静态"}</b><span class="small muted">\${run.sandbox === undefined ? "启用状态未知" : dynamic ? "沙箱已启用" : "无沙箱"}</span></span></div>
    <button class="link small" data-action="config" aria-expanded="\${S.configOpen}">\${S.configOpen ? "收起" : "全部"}配置 \${S.configOpen ? "↑" : "↓"}</button></div>
    <div class="configdetail" id="configdetail" \${S.configOpen ? "" : "hidden"}><div class="configgrid">\${Object.entries(cfg).map(([k, v]) => \`<div class="configitem"><code>\${esc(k)}</code><span class="small">\${esc(String(v))}</span></div>\`).join("")}</div><p class="small muted" style="margin-top:10px">配置为 workflow 自报的有效值（默认值已落定），只读不改。</p></div>\`;

  const pipeline = \`<div class="sectionheading row spread"><h2>阶段流水线</h2><span class="small muted"><span class="mono">\${doneCount} / \${order.length}</span> 阶段已完成 · 非时间进度</span></div>
  <nav class="pipeline" aria-label="Workflow 阶段">\${order.map((name, i) => { const m = stageMeta(name); return \`<button class="stage \${m.ui}" data-action="stage" data-name="\${esc(name)}"><div class="row"><span class="stepnum">0\${i + 1}</span><i class="dot \${m.ui}"></i><strong class="mono">\${esc(name)}</strong></div><div class="status"><span>\${m.ui === "done" ? "✓ " : m.ui === "error" ? "× " : ""}\${m.label}</span><span class="mono">\${m.time != null ? fmShort(m.time) : "—"}</span></div></button>\`; }).join("")}</nav>
  <div class="stagegroups"><span style="grid-column:1/\${order.indexOf("hunt") >= 0 ? order.indexOf("hunt") + 1 : 1}">init 共享会话 · 依次执行</span><span>单会话多轮 · 并发锁 1</span><span>HYP 扇出 · 池化</span></div>\`;

  // hunt 面板
  const covPct = cov && cov.pct != null ? cov.pct : null;
  const roundsHtml = roundKeys.length
    ? roundKeys.map((k) => { const n = arrLen(roundHyps[k]); const rn = Number(k.replace(/\\D+/g, "")); return \`<div class="round \${n === 0 ? "zero" : ""}"><small>\${rn}</small>\${n}</div>\`; }).join("") + (hunting ? \`<div class="round inprogress"><small>\${doneRounds + 1}</small>·</div>\` : "")
    : \`<span class="muted small">尚无轮次记录</span>\`;
  const huntNote = (stagesObj.hunt === "pending" || stagesObj.hunt === "skipped" || stagesObj.hunt === undefined)
    ? \`<div class="notebox info">待开始 · init 阶段完成后进入逐轮精读。</div>\`
    : hunting
    ? \`<div class="notebox info"><strong>正在精读 · hunt\${doneRounds + 1}</strong><br>已完成 \${doneRounds} 轮。<button class="link" data-action="seshow" data-file="\${esc((state.sessions && state.sessions.init) || "")}">init · 打开当前会话 →</button></div>\`
    : stagesObj.hunt === "failed"
      ? \`<div class="notebox error"><strong>hunt 阶段失败</strong><br>\${esc(run.note ?? "")}</div>\`
      : stopEv
        ? \`<div class="notebox"><strong>\${esc(stopEv.msg)}</strong></div>\`
        : \`<div class="notebox info">已结束 · 停轮原因未上报（历史 run 不展示本进程事件）。</div>\`;
  const huntPanel = \`<section class="panel \${hunting ? "active" : stagesObj.hunt === "failed" ? "failed" : ""}"><div class="panelhead"><div class="row spread"><div class="row"><span class="index">0\${order.indexOf("hunt") + 1}</span><h2 class="mono">hunt</h2></div>\${badge(stageMeta("hunt").label, stageMeta("hunt").ui)}</div><p class="subtitle">串行执行 · 1 个会话 · 非运行池</p></div><div class="panelbody huntbody"><div><div class="metricrow"><div class="metric"><strong>\${hunting ? doneRounds + 1 : doneRounds || "—"}</strong><span>轮</span><p>\${hunting ? "当前轮次" : "已完成轮次"}</p></div><div class="metric"><strong>\${hypTotal}</strong><span>HYP</span><p>累计产出 · 不等于已证实</p></div></div><div class="row spread small"><span class="muted">逐轮新增 HYP</span><button class="link" data-action="rounds">产出详情 →</button></div><div class="rounds" style="grid-template-columns:repeat(\${Math.min(Math.max(roundKeys.length + (hunting ? 1 : 0), 1), 10)},1fr)">\${roundsHtml}</div></div><div><div class="coverage"><div class="row spread small"><span>靶内已读覆盖</span><span class="mono">\${covPct != null ? covPct + "%" : "未上报"} <span class="muted">/ \${esc(threshold)}%</span></span></div><div class="track"><div class="fill" style="width:\${covPct ?? 0}%"></div><i class="target" style="left:\${Math.min(Number(threshold) || 90, 100)}%"></i></div><p class="muted small">\${covPct != null && covPct < Number(threshold) ? "目标线未达到 · " : ""}覆盖不等于漏洞检出率</p></div>\${huntNote}</div></div></section>\`;

  // chains 面板
  let verifyBody;
  if (chainsState === "pending" || chainsState === "skipped") {
    verifyBody = \`<div class="waiting"><div class="empty-slots">\${Array.from({ length: conc }, (_, i) => \`<span>\${i + 1}</span>\`).join("")}</div><strong>\${hunting ? "等待 hunt 收束后派发" : "待开始"}</strong><p class="small">配置上限 \${conc}。尚未建池，不把待研判的 HYP 算作已排队。</p></div>\`;
  } else if (vp) {
    const rows = vp.active.map((a, i) => { const s = sessOf(a.label); return \`<div class="taskrow"><span class="slotid">0\${i + 1}</span><div>\${s && s.sessionFile ? \`<a class="tasklabel" href="/session?file=\${enc(s.sessionFile)}" target="_blank">\${esc(a.label)}</a><span class="sessionid">\${esc(s.id)}</span>\` : \`<span class="tasklabel">\${esc(a.label)}</span><span class="sessionid">会话文件尚未上报</span>\`}</div><span class="agent muted mono">\${esc(s?.agent ?? "")}</span><div class="elapsed">\${fm(a.ms)}\${s && s.sessionFile ? \`<a href="/session?file=\${enc(s.sessionFile)}" target="_blank">会话 ↗</a>\` : ""}</div></div>\`; }).join("");
    const q = vp.queued ?? [];
    verifyBody = \`<div class="taskhead"><span>槽</span><span>任务 / 会话 ID</span><span class="agent">AGENT</span><span style="text-align:right">占用耗时</span></div>\${rows || \`<div class="waiting"><strong>池空闲</strong><p class="small">无在跑任务。</p></div>\`}
      <div class="queue"><div class="row spread small"><span class="row"><i class="dot queued"></i><strong>排队 \${q.length}</strong></span><span class="muted">等待 verify 槽位 · 尚无会话</span></div>\${q.length ? \`<div class="queuegrid">\${q.map((t, i) => \`<div class="queuetask"><span class="rank">\${String(i + 1).padStart(2, "0")}</span>\${esc(t)}</div>\`).join("")}</div>\` : ""}</div>\`;
  } else {
    verifyBody = \`<div class="waiting"><strong>池数据未上报</strong></div>\`;
  }
  const sandboxBody = run.sandbox === false
    ? \`<div style="margin-top:10px">\${badge("未启用")}</div><div class="mutedslot">— / 1</div><p><code>sandbox_cfg</code> 未提供。</p><p>本次仅静态研判，不调度沙箱任务。</p><hr><div class="row spread small"><span class="muted">排队</span><span>不适用</span></div><div class="sandboxextra"><p style="margin-top:14px">配置保留，运行态不适用。<br>不等同于“空闲 0/1”。</p></div>\`
    : run.sandbox === true
      ? (sc ? \`<div style="margin-top:10px">\${badge(\`占用 \${sc.held.length} / \${sc.permits}\`, sc.held.length ? "running" : "")}</div>\${sc.held.map((h) => \`<p class="mono" style="margin-top:12px">\${esc(h.tag)}</p><p><code>\${fm(h.ms)}</code></p>\`).join("")}\${sc.waiting.length ? \`<hr><div class="row spread small"><span class="row"><i class="dot queued"></i>等待 \${sc.waiting.length}</span></div>\${sc.waiting.map((w) => \`<p class="mono">\${esc(w.tag)}</p>\`).join("")}\` : ""}<hr><p>资源容量（非池）：dynamic verify / ev 段嵌套占用；等待时仍持有链槽位。</p>\` : \`<div style="margin-top:10px">\${badge("已启用 · 容量未上报")}</div>\`)
      : \`<div style="margin-top:10px">\${badge("启用状态未知")}</div>\`;
  const chainsPanel = \`<section class="panel \${cur === "chains" ? "active" : ""}"><div class="panelhead"><div class="row spread"><div class="row"><span class="index">0\${order.indexOf("chains") + 1}</span><h2 class="mono">chains</h2><span class="muted small">/ \${dynamic ? "dynamic-verify → ev-assess" : "static-verify"}</span></div>\${badge(stageMeta("chains").label, stageMeta("chains").ui)}</div><p class="subtitle">HYP 按出生轮 fork → 启动摘要 → \${dynamic ? "动态研判 / 复现 → 按门槛评估影响" : "静态研判"}\${vp && vp.dispatched ? \` · 已结束 \${vp.finished} / \${vp.dispatched} 条链\` : ""}</p></div><div class="poolbody"><div class="verify"><div class="pooltitle row spread"><div class="row"><h3 class="mono">verify</h3><span class="badge">池</span><span class="capacity">\${Array.from({ length: conc }, (_, i) => \`<i class="slotbar \${vp && i < vp.active.length ? "" : "off"}"></i>\`).join("")}</span></div><span class="small muted">在跑 <strong style="color:var(--text-primary)">\${vp ? vp.active.length : "—"}<span class="muted" style="font-size:12px"> / \${conc}</span></strong></span></div>\${verifyBody}</div><aside class="sandbox"><div class="row spread"><h3 class="mono">sandbox</h3><span class="badge">资源容量</span></div>\${sandboxBody}</aside></div><div class="poolfoot"><code>chain_concurrency = \${esc(String(cfg.chain_concurrency ?? conc))}</code> · 链槽位上限，不是全部会话数。init 是协调会话，不占 verify 槽位。</div></section>\`;

  const sessionsPanel = \`<section class="panel"><div class="slimhead row spread"><h2>进行中的会话 <span class="muted">\${(st.running ?? []).length}</span></h2></div><div class="support">\${(st.running ?? []).map((n) => \`<div class="record"><div>\${n.sessionFile ? \`<a class="mono" href="/session?file=\${enc(n.sessionFile)}" target="_blank">\${esc(n.id)} ↗</a>\` : \`<span class="mono">\${esc(n.id)}</span>\`} <span class="muted mono">· \${esc(n.agent)}</span><p class="small muted">目标 \${esc(n.target ?? "—")}</p></div><div class="mono muted">\${fm(n.ms)}</div></div>\`).join("") || '<p class="muted small">无进行中会话。</p>'}<p class="small muted">会话打开时长 ≠ 当前模型持续生成时长，不能据此断言卡死。</p></div></section>\`;
  const eventsPanel = \`<section class="panel"><div class="slimhead row spread"><h2>最近事件</h2><button class="link small" data-action="events">完整事件流 →</button></div><div class="support">\${(st.events ?? []).slice(-6).reverse().map((e) => \`<div class="event"><time>\${ts(e.ts)}</time><i class="dot"></i><span>\${esc(e.msg)}</span></div>\`).join("") || '<p class="muted small">无事件。</p>'}</div></section>\`;
  const historyRows = (st.runs ?? []).map((r) => \`<tr><td><span class="mono">\${esc(r.workflow)} / \${esc(r.runId)}</span></td><td class="mono small">\${esc(r.cwd)}</td><td>\${badge(r.status === "running" ? "运行中" : r.status === "done" ? "已结束" : "失败", r.status === "running" ? "running" : r.status === "done" ? "done" : "error")}</td><td>\${r.runId === run.runId && r.workdir === run.workdir ? "当前视图" : \`<button class="link" data-action="hist" data-workdir="\${enc(r.workdir)}" data-runid="\${esc(r.runId)}">只读快照 →</button>\`}</td></tr>\`).join("");

  $("main").innerHTML = \`\${banner}
  <div class="runheading row spread"><div><p class="caps eyebrow">\${run.status === "running" ? "ACTIVE WORKFLOW" : run.status === "done" ? "LAST RUN" : "FAILED RUN"}</p><div class="row"><h1>\${esc(run.workflow)}</h1>\${badge(run.status === "running" ? "运行中" : run.status === "done" ? "已结束" : "运行失败", run.status === "running" ? "running" : run.status === "done" ? "done" : "error")}<span class="muted">→</span><strong>\${esc(cur ?? (run.status === "done" ? "完成" : "—"))}</strong></div><p class="sub muted small"><span class="mono">run \${esc(run.runId)}</span><span class="slash">·</span><span class="mono">\${esc(run.cwd)}</span></p></div><div class="runtime"><strong class="num">\${fm(elapsed)}</strong><p class="muted small">运行耗时\${S.offline ? " · 已冻结" : ""}</p><p class="small muted">同步 <span class="mono">\${ts(S.lastSync)}</span></p></div></div>
  \${paramStrip}\${pipeline}
  <div class="workspace">\${huntPanel}\${chainsPanel}</div>
  <div class="lowergrid">\${sessionsPanel}\${eventsPanel}</div>
  <details class="history"><summary>本进程所见 Runs · \${(st.runs ?? []).length}　<span class="muted">历史记录不关联当前运行池</span></summary><table><thead><tr><th>WORKFLOW / RUN</th><th>目标</th><th>状态</th><th>操作</th></tr></thead><tbody>\${historyRows}</tbody></table></details>
  <footer class="footer row spread wrap"><span>只读视图 · 无运行控制操作</span><span>3s 轮询 /api/state</span></footer>\`;
  window.scrollTo(0, scrollY);
}

function modal(title, body) { $("dialogtitle").textContent = title; $("dialogbody").innerHTML = body; $("inspector").showModal(); }

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  if (action === "config") { e.preventDefault(); S.configOpen = !S.configOpen; $("configdetail").hidden = !S.configOpen; el.setAttribute("aria-expanded", String(S.configOpen)); el.textContent = S.configOpen ? "收起配置 ↑" : "全部配置 ↓"; }
  else if (action === "stage") {
    e.preventDefault();
    const name = el.dataset.name;
    const desc = { onboard: "读取项目并建立画像，输出 profiler。", build: "理解构建与部署，输出 build-state。", research: "检索公开情报，输出 ADV 与 wiki。", compress: "将 onboard/build/research 压成初始化摘要。", hunt: "单会话逐轮精读；每轮小摘要，上下文占用 >60% 时压缩全部 hunt 历史。", chains: "HYP 按出生轮末梢 fork；verify 池承载整条链。沙箱步骤（资源容量）的等待与执行发生在链内部，同一会话不重复计数。" }[name] ?? "（无阶段说明）";
    modal(name, \`<p>\${desc}</p><p class="small muted">状态与耗时以流水线卡为准；阶段详情从定义与运行状态读取，不根据池是否存在推断完成。</p>\`);
  }
  else if (action === "rounds") {
    e.preventDefault();
    const d = S.lastGood?.detail?.state?.data?.roundHyps ?? {};
    const keys = Object.keys(d).sort((a, b) => Number(a.replace(/\\D+/g, "")) - Number(b.replace(/\\D+/g, "")));
    modal("逐轮 HYP 产出", \`<pre>\${keys.map((k) => \`\${k}  +\${arrLen(d[k])} HYP\`).join("\\n") || "（无）"}</pre><p>停轮：覆盖达到阈值 且 连续 x 轮 0 HYP（hunt_zero_rounds，默认 3）。轮次不默认封顶（除非显式给了 rounds）。</p>\`);
  }
  else if (action === "events") {
    e.preventDefault();
    const evs = (S.lastGood?.st.events ?? []).slice().reverse();
    modal("事件流 · 最新在上", evs.map((v) => \`<div class="event"><time>\${ts(v.ts)}</time><i class="dot"></i><span>\${esc(v.msg)}</span></div>\`).join("") || "<p>无事件。</p>");
  }
  else if (action === "hist") {
    e.preventDefault();
    try {
      const d = await j(\`/api/run?workdir=\${el.dataset.workdir}&runId=\${enc(el.dataset.runid)}\`);
      const st2 = d.state ?? {};
      const stages = Object.entries(st2.stages ?? {}).map(([k, v]) => \`\${k}:\${v}\`).join(" → ");
      const sess = Object.entries(st2.sessions ?? {}).map(([k, v]) => \`<div class="kv"><span class="muted">\${esc(k)}</span><a href="/session?file=\${enc(v)}" target="_blank" class="mono small">\${esc(v)} ↗</a></div>\`).join("");
      modal(\`历史只读快照 · \${el.dataset.runid}\`, \`<div class="row">\${badge("已结束", "done")}</div><p class="mono small">\${esc(stages)}</p><h3>会话文件</h3>\${sess || '<p class="muted small">无</p>'}<div class="notebox info">历史快照不展示当前 verify 池与沙箱容量。池实时状态仅关联本进程唯一活动 run。</div>\`);
    } catch { modal("历史快照", "<p>读取失败。</p>"); }
  }
  else if (action === "seshow") { const f = el.dataset.file; if (f) window.open("/session?file=" + enc(f), "_blank"); }
});
$("closedialog").addEventListener("click", () => $("inspector").close());
$("inspector").addEventListener("click", (e) => { if (e.target === $("inspector")) { const r = $("inspector").getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) $("inspector").close(); } });
$("theme").addEventListener("click", () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; $("theme").textContent = document.documentElement.dataset.theme === "dark" ? "浅色" : "深色"; });
// 渲染崩溃兜底：报错进页面，不留白屏（09-14 链阶段 undefined.length 实踩）
window.addEventListener("error", (e) => {
  const m = $("main");
  if (m && !m.textContent.trim()) m.innerHTML = \`<div class="banner"><span><strong>页面渲染异常</strong> · \${esc(e.message)}<br><span class="small muted">\${esc(String(e.filename).split("/").pop())}:\${e.lineno}——数据未丢失，等下一轮自刷或刷新页面。</span></span></div>\`;
});
setInterval(tick, 3000); tick();

</script></body></html>`;
