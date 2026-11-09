// Workspace client. Actions are data-action attributes plus one delegated listener
// so model and user strings are never placed in inline JavaScript.
const API = '';
let token = localStorage.getItem('ae_token') || '';
let user = null, usage = null, cases = [], current = null, mode = 'signup', ncSourceType = 'text', pendingSource = null;

async function api(path, method = 'GET', body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, data };
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

function setMode(m) {
  mode = m === 'login' ? 'login' : 'signup';
  tabLogin.classList.toggle('active', mode === 'login');
  tabSignup.classList.toggle('active', mode === 'signup');
  nameField.classList.toggle('hidden', mode !== 'signup');
  authBtn.textContent = mode === 'login' ? 'Log in' : 'Create account';
  authErr.textContent = '';
  const forgotRow = document.getElementById('forgotRow');
  if (forgotRow) forgotRow.classList.toggle('hidden', mode !== 'login');
  const forgotBox = document.getElementById('forgotBox');
  if (forgotBox) forgotBox.classList.add('hidden');
  const forgotMsg = document.getElementById('forgotMsg');
  if (forgotMsg) forgotMsg.textContent = '';
}
function openAuth(m, subtitle) {
  authModal.classList.remove('hidden');
  document.getElementById('authSubtitle').textContent = subtitle || 'Log in or create your free account. First 5 cases free — no card.';
  setMode(m || 'signup');
  setTimeout(() => { (mode === 'signup' ? f_name : f_email).focus(); }, 60);
}
function closeAuth() { authModal.classList.add('hidden'); if (authErr) authErr.textContent = ''; }

async function submitAuth() {
  authErr.textContent = '';
  const email = f_email.value.trim(), password = f_password.value, name = f_name.value.trim();
  if (!email || !password) { authErr.textContent = 'Email and password are required.'; return; }
  if (mode === 'signup' && !name) { authErr.textContent = 'Please enter your name.'; return; }
  const path = mode === 'login' ? '/api/login' : '/api/signup';
  const r = await api(path, 'POST', mode === 'login' ? { email, password } : { email, password, name });
  if (!r.ok) { authErr.textContent = r.data.error || 'Something went wrong.'; return; }
  token = r.data.token; localStorage.setItem('ae_token', token);
  closeAuth();
  await boot();
}

async function requestReset() {
  const msg = document.getElementById('forgotMsg');
  const email = f_email.value.trim();
  if (!email) { if (msg) msg.textContent = 'Enter your email above first.'; return; }
  if (msg) msg.textContent = 'Sending…';
  const r = await api('/api/request-password-reset', 'POST', { email });
  if (msg) msg.textContent = r.data.message || r.data.error || 'Something went wrong.';
}

async function logout() {
  try { await api('/api/logout', 'POST', {}); } catch { /* still drop the local token */ }
  token = '';
  localStorage.removeItem('ae_token');
  location.reload();
}

async function boot() {
  const me = await api('/api/me');
  if (!me.ok) {
    token = ''; localStorage.removeItem('ae_token'); user = null; usage = null;
    renderTop(); guestLanding();
    return;
  }
  user = me.data;
  renderTop();
  await refreshUsage();
  await handleCheckoutReturn();
  await loadCases();
  if (pendingSource) { const s = pendingSource; pendingSource = null; await createAndAssess(s); }
  else if (cases.length) selectCase(cases[0].id);
  else showEmpty();
}

async function handleCheckoutReturn() {
  const params = new URLSearchParams(location.search);
  if (!params.get('checkout')) return;
  const sid = params.get('session_id');
  history.replaceState({}, '', '/app');
  if (params.get('checkout') === 'success' && sid) {
    await api('/api/checkout-confirm', 'POST', { sessionId: sid });
  }
  await refreshUsage();
}

function renderTop() {
  if (!user) {
    topRight.innerHTML = `<button type="button" class="btn btn-ghost btn-sm" data-action="open-auth" data-mode="login">Log in</button><button type="button" class="btn btn-primary btn-sm" data-action="open-auth" data-mode="signup">Sign up</button>`;
    return;
  }
  let pill = '';
  if (usage) {
    if (usage.plan === 'trial') {
      const rem = usage.trial.remaining;
      pill = `<div class="usage-pill ${rem <= 1 ? 'warn' : ''}"><span class="dot"></span>Free trial · ${usage.trial.used}/${usage.trial.limit} used</div>`;
    } else {
      const extra = usage.overageCases ? ' · +' + usage.overageCases + ' overage, not billed' : '';
      pill = `<div class="usage-pill"><span class="dot"></span>Core · ${usage.casesProcessed}/${usage.includedPerMonth} this month${extra} · ${esc(usage.estimatedAmountDue)}</div>`;
    }
  }
  const sub = usage && usage.plan === 'trial'
    ? `<button type="button" class="btn btn-amber btn-sm" data-action="subscribe">Subscribe · $20/mo</button>` : '';
  topRight.innerHTML = `${pill}${sub}<span style="color:var(--slate)">${esc(user.name)}</span><button type="button" class="btn btn-ghost btn-sm" data-action="logout">Log out</button>`;
}

async function refreshUsage() { const r = await api('/api/usage'); if (r.ok) usage = r.data; renderTop(); }
async function subscribe() {
  const r = await api('/api/create-checkout-session', 'POST', {});
  if (!r.ok) { alert(r.data.error || 'Subscription failed'); return; }
  if (r.data.url) { window.location.href = r.data.url; return; }
  if (r.data.plan) usage = r.data;
  await refreshUsage(); if (current) renderCase();
}

async function loadCases() {
  const r = await api('/api/cases'); cases = r.ok ? r.data.cases : []; renderCaseList();
}
function renderCaseList() {
  caseList.innerHTML = cases.map((c) => `
    <div class="case-item ${current && current.id === c.id ? 'active' : ''}" data-action="select-case" data-case-id="${esc(c.id)}">
      <div class="ref">${esc(c.caseRef)}</div>
      <div class="ttl">${esc(c.title)}</div>
      <span class="badge b-${badgeClass(c.status)}">${statusLabel(c.status)}</span>
    </div>`).join('') || `<p style="color:var(--slate);font-size:13px">No cases yet.</p>`;
}
const badgeClass = (s) => s === 'cleared' ? 'cleared' : s === 'in_review' || s === 'ai_drafted' ? 'review' : 'pending';
const statusLabel = (s) => ({ pending:'Pending', ai_drafted:'AI drafted', in_review:'In review', cleared:'Cleared' }[s] || s);

async function selectCase(id) {
  if (!id) return;
  const r = await api('/api/cases?id=' + encodeURIComponent(id));
  if (!r.ok) return;
  current = r.data; renderCaseList(); renderCase();
}

function filePickerHtml() {
  return `
    <label>Source document</label>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
      <input type="file" id="nc_file" accept=".pdf,.doc,.docx,.txt,.eml,.csv,.md,.json,.png,.jpg,.jpeg,.webp,.gif,.tif,.tiff" style="display:none" />
      <button type="button" class="btn btn-ghost btn-sm" data-action="pick-file">📎 Choose file…</button>
      <span id="nc_filestatus" style="font-size:12.5px;color:var(--slate)"></span>
    </div>`;
}

function guestLanding() {
  current = null; ncSourceType = 'text'; renderCaseList();
  mainPanel.innerHTML = `
    <div class="landing">
      <div class="hero">
        <div class="eyebrow">✦ AI-assisted pharmacovigilance</div>
        <h1>From an adverse-event source document to a structured assessment — in seconds.</h1>
        <p class="lede">Paste or upload an adverse-event report and the engine drafts a complete ICSR-style assessment — seriousness, MedDRA coding, causality, expectedness and reporting timeline — each with its clinical reasoning and guideline references. You review and approve every field. <strong>First 5 cases free, no card.</strong></p>
      </div>
      <div class="features">
        <div class="feature"><div class="fi">🧬</div><h4>Structured PV draft</h4><p>Seriousness, MedDRA (LLT→PT→SOC), WHO-UMC causality, expectedness & the reporting clock.</p></div>
        <div class="feature"><div class="fi">📚</div><h4>Guideline-referenced</h4><p>Decisions cite ICH E2A / E2B(R3) / E2D, 21 CFR 314.80, EU GVP Module VI, WHO-UMC.</p></div>
        <div class="feature"><div class="fi">🧑‍⚕️</div><h4>Human-in-the-loop</h4><p>Decision support only — you accept or override each field; the AI never files a report.</p></div>
        <div class="feature"><div class="fi">🔒</div><h4>Private by design</h4><p>Files are parsed in your browser; only the extracted text is sent for assessment.</p></div>
      </div>
      <div class="card" style="max-width:760px;margin:18px auto 0">
        <h2>Try it — process a case</h2>
        ${filePickerHtml()}
        <label>Extracted / pasted text</label>
        <textarea id="nc_text" placeholder="Paste the adverse-event narrative, or upload a file above to auto-extract..."></textarea>
        <label>Case title (optional)</label>
        <input id="nc_title" placeholder="e.g. Headache after Cardizem XL" />
        <button type="button" class="btn btn-primary full" data-action="guest-run">🚀 Run AI assessment</button>
        <div class="err" id="nc_err"></div>
      </div>
    </div>`;
}
function guestRun() {
  const title = document.getElementById('nc_title').value.trim();
  const sourceText = document.getElementById('nc_text').value.trim();
  if (!sourceText) { document.getElementById('nc_err').textContent = 'Add a source document or paste text first.'; return; }
  pendingSource = { title, sourceText, sourceType: ncSourceType };
  openAuth('signup', 'Create your free account to run this assessment and see the result. First 5 cases free — no card.');
}
async function createAndAssess(s) {
  mainPanel.innerHTML = `<div class="empty">🧠 Running AI assessment…</div>`;
  const c = await api('/api/cases', 'POST', { title: s.title, sourceText: s.sourceText, sourceType: s.sourceType });
  if (!c.ok) { showEmpty(); alert(c.data.error || 'Failed to create case'); return; }
  const a = await api('/api/assess', 'POST', { caseId: c.data.id });
  await refreshUsage();
  await loadCases();
  await selectCase(c.data.id);
  if (a.status === 402) alert(a.data.error || 'Trial exhausted — subscribe to continue.');
}

function newCase() {
  if (!user) { guestLanding(); return; }
  current = null; ncSourceType = 'text'; renderCaseList();
  mainPanel.innerHTML = `
    <div class="card">
      <h2>New case</h2>
      <p class="hint">Upload a source document — PDF, Word, image/scan, email or text — or paste the text. Files are read in your browser; only the extracted text is sent. The AI then drafts a structured assessment you review.</p>
      ${filePickerHtml()}
      <label>Extracted / pasted text</label>
      <textarea id="nc_text" placeholder="Paste the narrative, or upload a file above to auto-extract..."></textarea>
      <label>Case title (optional)</label>
      <input id="nc_title" placeholder="e.g. Headache after Cardizem XL" />
      <button type="button" class="btn btn-primary full" data-action="create-case">Create case</button>
      <div class="err" id="nc_err"></div>
    </div>`;
}
async function createCase() {
  const title = document.getElementById('nc_title').value.trim();
  const sourceText = document.getElementById('nc_text').value.trim();
  if (!sourceText) { document.getElementById('nc_err').textContent = 'Source text is required — upload a file or paste text.'; return; }
  const r = await api('/api/cases', 'POST', { title, sourceText, sourceType: ncSourceType });
  if (!r.ok) { document.getElementById('nc_err').textContent = r.data.error || 'Failed'; return; }
  await loadCases(); await selectCase(r.data.id);
}
function showEmpty() { mainPanel.innerHTML = `<div class="empty">Select a case, or create your first one.</div>`; }

const FIELDS = [
  ['seriousness','Seriousness'], ['meddraPt','MedDRA Preferred Term'], ['meddraCode','MedDRA Code'],
  ['soc','System Organ Class'], ['causality','Causality'], ['expectedness','Expectedness'],
  ['regulatoryRequired','Regulatory Reporting Required'], ['regulatoryTimeline','Reporting Timeline'], ['narrative','Narrative'],
];
const GLOSSARY = {
  seriousness: 'Does the event meet a regulatory "serious" criterion — death, life-threatening, hospitalization or its prolongation, persistent/significant disability, congenital anomaly, or otherwise medically important. Drives reporting urgency.',
  meddraPt: 'The standardized medical term for the event from MedDRA (the dictionary regulators require for coding adverse events), e.g. "Anaphylactic reaction".',
  meddraCode: 'The numeric MedDRA code for the Preferred Term.',
  soc: 'System Organ Class — the top-level MedDRA category the term rolls up to, e.g. "Immune system disorders".',
  causality: 'How likely the product caused the event, on the WHO-UMC scale: certain / probable / possible / unlikely / unassessable.',
  expectedness: 'Whether the event is already described in the product\'s safety labeling (Expected) or not (Unexpected). Serious + Unexpected usually triggers expedited reporting.',
  regulatoryRequired: 'Whether this case must be reported to health authorities.',
  regulatoryTimeline: 'The reporting deadline — typically 7 days for fatal/life-threatening and 15 days for other serious/unexpected cases.',
  narrative: 'A concise clinical summary of the case.',
};
const rationaleFor = (a, key) => (a && a.rationale && a.rationale[key]) || '';

function decisionFor(fieldKey) {
  if (!current || !current.assessment) return null;
  const id = current.assessment.id;
  const d = (current.fieldDecisions || []).filter((x) => x.fieldKey === fieldKey && x.assessmentId === id);
  return d.length ? d[0] : null;
}

function renderCase() {
  const c = current; if (!c) return;
  const a = c.assessment;
  let html = `
    <div class="row" style="justify-content:space-between;margin-bottom:8px">
      <div><div style="font-size:12px;color:var(--slate);font-weight:600">${esc(c.caseRef)}</div>
      <h2 style="font-size:19px;color:var(--white)">${esc(c.title)}</h2></div>
      <span class="badge b-${badgeClass(c.status)}">${statusLabel(c.status)}</span>
    </div>
    <div class="disclaimer">⚠ Decision support only — the AI draft is not a regulatory action. A qualified reviewer reviews and approves every case before any downstream use.</div>
    <div class="card"><h2>Source document</h2><div class="hint" style="margin:0">${esc(c.sourceText)}</div></div>`;

  if (!a) {
    const blocked = usage && usage.plan === 'trial' && usage.trial.remaining <= 0;
    html += `<div class="card"><h2>AI assessment</h2>
      <p class="hint">Run the AI engine to draft the structured assessment.</p>
      ${blocked ? `<div class="banner banner-warn">Your free trial is used up. Subscribe to Core to process this case.</div>
        <button type="button" class="btn btn-amber" data-action="subscribe">Subscribe · $20/mo</button>`
        : `<button type="button" class="btn btn-primary" id="assessBtn" data-action="run-assess">🚀 Run AI assessment</button>`}
      <div class="err" id="assessErr"></div></div>`;
    mainPanel.innerHTML = html;
    return;
  }

  html += `<div class="card">
    <div class="row" style="justify-content:space-between;align-items:flex-start;gap:12px">
      <h2 style="border:0;margin:0">AI-drafted assessment · <span style="color:var(--slate);font-weight:500">${esc(draftStamp(a))}</span></h2>
      <button type="button" class="btn btn-primary" id="rerunBtn" data-action="run-assess" style="white-space:nowrap;box-shadow:0 0 0 1px var(--teal)">↻ Re-run AI analysis</button>
    </div>
    <p class="hint">Review each field. Accept the AI value or override it. Low-confidence fields are flagged. Re-run starts a new draft; earlier accepts and overrides stay on the previous draft.</p>`;

  for (const [key, label] of FIELDS) {
    const aiVal = key === 'authorities' ? (a.authorities || []).join(', ') : a[key];
    const conf = (a.confidence && a.confidence[key]) || null;
    const dec = decisionFor(key);
    const needs = conf === 'low' && !dec;
    const rat = rationaleFor(a, key);
    html += `<div class="field ${dec ? 'decided' : ''} ${needs ? 'needs' : ''}">
      <div class="field-top">
        <span class="field-label">${label}<span class="info-i" title="${esc(GLOSSARY[key] || '')}">i</span></span>
        ${conf ? `<span class="conf conf-${conf}">${conf} confidence</span>` : ''}
      </div>
      <div class="field-val">${esc(dec ? dec.finalValue : aiVal)}</div>
      ${rat ? `<details class="why"><summary>Why?</summary><div class="why-body">${esc(rat)}</div></details>` : ''}`;
    if (dec) {
      html += `<div class="field-actions"><span class="field-status ${dec.decisionType === 'override' ? 'over' : 'ok'}">
        ${dec.decisionType === 'override' ? '✎ Overridden' : '✓ Accepted'}</span>
        <button type="button" class="btn btn-ghost btn-sm" data-action="start-override" data-field="${esc(key)}">Change</button></div>`;
    } else {
      html += `<div class="field-actions">
        <button type="button" class="btn btn-primary btn-sm" data-action="accept" data-field="${esc(key)}" data-ai="${esc(aiVal)}">Accept</button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="start-override" data-field="${esc(key)}">Override</button></div>`;
    }
    html += `<div class="override-box" id="ov_${esc(key)}">
      <textarea id="ovval_${esc(key)}">${esc(dec ? dec.finalValue : aiVal)}</textarea>
      <input id="ovreason_${esc(key)}" placeholder="Reason for override (optional)" style="margin-top:7px" />
      <button type="button" class="btn btn-primary btn-sm" style="margin-top:8px" data-action="save-override" data-field="${esc(key)}" data-ai="${esc(aiVal)}">Save override</button>
    </div></div>`;
  }
  html += `</div>`;

  const refs = (a.references || []);
  if (refs.length) {
    html += `<div class="card"><h2>Guideline &amp; regulatory references</h2>
      <p class="hint">Standards the AI drew on for these decisions — verify against current versions.</p>
      <ul style="list-style:none;padding:0;margin:0">` +
      refs.map((r) => `<li style="padding:9px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:13.5px;color:var(--white);font-weight:600">${esc(r.citation)}</div>
        <div style="font-size:12px;color:var(--slate);margin-top:2px">${esc(r.relevance)}</div></li>`).join('') +
      `</ul></div>`;
  }

  html += `<div class="card"><h2>Download &amp; export</h2>
    <p class="hint">Download the reviewed case as a printable file, or request a regulatory-format export.</p>
    <div style="display:flex;flex-wrap:wrap;gap:8px">
      <button type="button" class="btn btn-primary" data-action="download-case">⬇ Download case</button>
      <button type="button" class="btn btn-ghost" data-action="request-export" data-format="E2B (R3)">E2B (R3) →</button>
      <button type="button" class="btn btn-ghost" data-action="request-export" data-format="CIOMS I">CIOMS I →</button>
      <button type="button" class="btn btn-ghost" data-action="request-export" data-format="MedWatch 3500A">MedWatch 3500A →</button>
      <button type="button" class="btn btn-ghost" data-action="request-export" data-format="PSUR / PBRER">PSUR / PBRER →</button>
    </div>
    <p style="font-size:11.5px;color:var(--slate);margin-top:10px">E2B(R3), CIOMS, MedWatch and PSUR are add-on modules in the full AE Connect platform — click to request access and we'll set you up.</p></div>`;

  mainPanel.innerHTML = html;
}
function currentModelVersion() { return (current && current.assessment && current.assessment.modelVersion) || 'ai'; }
function draftStamp(a) {
  const model = (a && a.modelVersion) || currentModelVersion();
  const prompt = (a && a.promptVersion) || '';
  return prompt ? `model ${model} · prompt ${prompt}` : `model ${model}`;
}

function downloadCase() {
  const c = current; if (!c || !c.assessment) return;
  const a = c.assessment;
  const rows = FIELDS.map(([key, label]) => {
    const aiVal = key === 'authorities' ? (a.authorities || []).join(', ') : a[key];
    const dec = decisionFor(key);
    const finalVal = dec ? dec.finalValue : aiVal;
    const review = dec ? (dec.decisionType === 'override' ? 'Overridden' + (dec.reason ? ' — ' + dec.reason : '') : 'Accepted') : 'AI draft (not yet reviewed)';
    const conf = (a.confidence && a.confidence[key]) || '';
    const rat = rationaleFor(a, key);
    return `<tr><th>${esc(label)}</th><td>${esc(finalVal)}${rat ? `<div style="color:#718096;font-size:11px;margin-top:4px">${esc(rat)}</div>` : ''}</td><td>${esc(review)}${conf ? ' · ' + esc(conf) + ' conf' : ''}</td></tr>`;
  }).join('');
  const allReviewed = FIELDS.every(([key]) => {
    const dec = decisionFor(key);
    return !!dec && (dec.decisionType === 'accept' || dec.decisionType === 'override');
  });
  const disc = allReviewed
    ? 'Decision support only — this AI-assisted draft is not a regulatory action; it was reviewed and approved by a qualified user. AE Connect by QORO Intelligence.'
    : 'DRAFT — Decision support only. This file is not a regulatory action and has not been fully reviewed for the current assessment. AE Connect by QORO Intelligence.';
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(c.caseRef)} — AE Connect</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1a202c;max-width:760px;margin:32px auto;padding:0 20px;line-height:1.5}
h1{font-size:20px;margin:0 0 2px}.ref{color:#718096;font-size:12px;font-weight:700;letter-spacing:.03em}
.meta{color:#718096;font-size:12px;margin-bottom:18px}h2{font-size:14px;margin:22px 0 6px}
.src{background:#f7fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;white-space:pre-wrap;font-size:13px}
table{width:100%;border-collapse:collapse;margin-top:8px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:13px;vertical-align:top}
thead th{color:#4a5568}tbody th{width:210px;color:#4a5568;font-weight:600}
.disc{color:#718096;font-size:11px;margin-top:22px;border-top:1px solid #e2e8f0;padding-top:10px}</style></head>
<body>
<div class="ref">${esc(c.caseRef)}</div>
<h1>${esc(c.title)}</h1>
<div class="meta">AE Connect · AI-assisted assessment · ${esc(draftStamp(a))} · generated ${new Date().toLocaleString()}${allReviewed ? '' : ' · DRAFT'}</div>
<h2>Source document</h2>
<div class="src">${esc(c.sourceText)}</div>
<h2>Structured assessment</h2>
<table><thead><tr><th>Field</th><th>Final value</th><th>Review</th></tr></thead><tbody>${rows}</tbody></table>
${(a.references && a.references.length) ? `<h2>Guideline &amp; regulatory references</h2><ul>${a.references.map(function(r){return '<li><strong>' + esc(r.citation) + '</strong> — ' + esc(r.relevance) + '</li>';}).join('')}</ul>` : ''}
<div class="disc">${esc(disc)}</div>
</body></html>`;
  const url = URL.createObjectURL(new Blob([doc], { type: 'text/html' }));
  const link = document.createElement('a');
  link.href = url; link.download = `${c.caseRef}.html`;
  document.body.appendChild(link); link.click(); document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function requestExport(format) {
  window.open('https://aeconnect.io/contact?export=' + encodeURIComponent(format), '_blank');
}

async function runAssess() {
  const btn = document.getElementById('assessBtn') || document.getElementById('rerunBtn');
  const rerun = btn && btn.id === 'rerunBtn';
  if (btn) { btn.disabled = true; btn.textContent = rerun ? 'Re-running…' : 'Assessing…'; }
  const setErr = (t) => { const e = document.getElementById('assessErr'); if (e) e.textContent = t; else alert(t); };
  const r = await api('/api/assess', 'POST', { caseId: current.id });
  if (r.status === 402) { await refreshUsage(); setErr(r.data.error); renderCase(); return; }
  if (!r.ok) { setErr(r.data.error || 'Assessment failed'); if (btn) { btn.disabled = false; btn.textContent = rerun ? '↻ Re-run AI analysis' : '🚀 Run AI assessment'; } return; }
  await refreshUsage(); await selectCase(current.id); await loadCases();
}

async function accept(key, aiVal) {
  const r = await api('/api/field-decision', 'POST', { caseId: current.id, fieldKey: key, decisionType: 'accept', aiValue: String(aiVal) });
  if (r.ok) await selectCase(current.id); else alert(r.data.error || 'Failed');
}
function startOverride(key) {
  if (!key) return;
  const box = document.getElementById('ov_' + key);
  if (box) box.style.display = box.style.display === 'block' ? 'none' : 'block';
}
async function saveOverride(key, aiVal) {
  const finalValue = document.getElementById('ovval_' + key).value;
  const reason = document.getElementById('ovreason_' + key).value;
  const r = await api('/api/field-decision', 'POST', { caseId: current.id, fieldKey: key, decisionType: 'override', aiValue: String(aiVal), finalValue, reason });
  if (r.ok) await selectCase(current.id); else alert(r.data.error || 'Failed');
}

const CDN = {
  pdfjs: {
    url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    integrity: 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e',
  },
  pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  mammoth: {
    url: 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
    integrity: 'sha384-nFoSjZIoH3CCp8W639jJyQkuPHinJ2NHe7on1xvlUA7SuGfJAfvMldrsoAVm6ECz',
  },
  tesseract: {
    url: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js',
    integrity: 'sha384-1zP4ZOtlk2FXAOiUArpMuWf7INJJKe/ROfYFAVSeUa11DEfXdKWGiPI3dVma2Gt0',
  },
};
const _scripts = {};
function loadScript(spec) {
  const url = spec.url;
  if (_scripts[url]) return _scripts[url];
  _scripts[url] = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = url;
    s.crossOrigin = 'anonymous';
    if (spec.integrity) s.integrity = spec.integrity;
    s.onload = () => res();
    s.onerror = () => rej(new Error('Could not load ' + url));
    document.head.appendChild(s);
  });
  return _scripts[url];
}
function fstatus(msg) { const el = document.getElementById('nc_filestatus'); if (el) el.textContent = msg; }

async function onFileChosen(file) {
  if (!file) return;
  const name = file.name, ext = (name.split('.').pop() || '').toLowerCase();
  const titleEl = document.getElementById('nc_title');
  if (titleEl && !titleEl.value.trim()) titleEl.value = name.replace(/\.[^.]+$/, '');
  try {
    let text = '';
    if (['txt', 'eml', 'csv', 'md', 'json'].includes(ext) || (file.type || '').startsWith('text/')) {
      fstatus('Reading ' + name + '…'); text = await file.text(); ncSourceType = ext === 'eml' ? 'email' : 'text';
    } else if (ext === 'pdf') {
      text = await extractPdf(file); ncSourceType = 'pdf';
    } else if (ext === 'docx' || ext === 'doc') {
      fstatus('Extracting Word document…'); await loadScript(CDN.mammoth);
      text = (await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value || ''; ncSourceType = 'word';
    } else if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'tif', 'tiff'].includes(ext) || (file.type || '').startsWith('image/')) {
      text = await ocrImage(file); ncSourceType = 'image';
    } else { fstatus('Unsupported file type — paste the text instead.'); return; }
    text = (text || '').trim();
    document.getElementById('nc_text').value = text;
    fstatus(text ? `✓ Extracted ${text.length} characters from ${name}` : 'No text found — if this is a scan, upload it as an image for OCR.');
  } catch (e) { fstatus('Extraction failed: ' + (e.message || e)); }
}

async function extractPdf(file) {
  fstatus('Loading PDF engine…'); await loadScript(CDN.pdfjs);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const parts = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    fstatus(`Reading PDF page ${p}/${pdf.numPages}…`);
    const tc = await (await pdf.getPage(p)).getTextContent();
    parts.push(tc.items.map((i) => i.str).join(' '));
  }
  let text = parts.join('\n').trim();
  if (text.length < 20) { fstatus('No embedded text — running OCR on scanned pages…'); text = await ocrPdf(pdf); }
  return text;
}

async function ocrPdf(pdf) {
  await loadScript(CDN.tesseract);
  const worker = await window.Tesseract.createWorker('eng');
  const out = [];
  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      fstatus(`OCR page ${p}/${pdf.numPages}…`);
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width; canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      out.push((await worker.recognize(canvas)).data.text);
    }
  } finally { await worker.terminate(); }
  return out.join('\n').trim();
}

async function ocrImage(file) {
  fstatus('Loading OCR engine…'); await loadScript(CDN.tesseract);
  const worker = await window.Tesseract.createWorker('eng', 1, {
    logger: (m) => { if (m.status === 'recognizing text') fstatus('OCR… ' + Math.round(m.progress * 100) + '%'); },
  });
  try { return (await worker.recognize(file)).data.text || ''; }
  finally { await worker.terminate(); }
}

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const el = target.closest('[data-action]');
  if (!el) return;
  const action = el.getAttribute('data-action');
  if (action === 'auth-backdrop') {
    if (target === el) closeAuth();
    return;
  }
  if (action === 'close-auth') { closeAuth(); return; }
  if (action === 'set-mode') { setMode(el.getAttribute('data-mode') || 'signup'); return; }
  if (action === 'submit-auth') { submitAuth(); return; }
  if (action === 'toggle-forgot') {
    document.getElementById('forgotBox')?.classList.toggle('hidden');
    return;
  }
  if (action === 'request-reset') { requestReset(); return; }
  if (action === 'open-auth') { openAuth(el.getAttribute('data-mode') || 'login'); return; }
  if (action === 'logout') { logout(); return; }
  if (action === 'subscribe') { subscribe(); return; }
  if (action === 'new-case') { newCase(); return; }
  if (action === 'select-case') { selectCase(el.getAttribute('data-case-id')); return; }
  if (action === 'pick-file') { document.getElementById('nc_file')?.click(); return; }
  if (action === 'guest-run') { guestRun(); return; }
  if (action === 'create-case') { createCase(); return; }
  if (action === 'run-assess') { runAssess(); return; }
  if (action === 'accept') { accept(el.getAttribute('data-field'), el.getAttribute('data-ai') ?? ''); return; }
  if (action === 'start-override') { startOverride(el.getAttribute('data-field')); return; }
  if (action === 'save-override') { saveOverride(el.getAttribute('data-field'), el.getAttribute('data-ai') ?? ''); return; }
  if (action === 'download-case') { downloadCase(); return; }
  if (action === 'request-export') { requestExport(el.getAttribute('data-format') || ''); return; }
});

document.addEventListener('change', (event) => {
  const t = event.target;
  if (t instanceof HTMLInputElement && t.id === 'nc_file') onFileChosen(t.files && t.files[0]);
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  if (authModal.classList.contains('hidden')) return;
  const ae = document.activeElement;
  if (ae && (ae.id === 'f_email' || ae.id === 'f_password' || ae.id === 'f_name')) {
    event.preventDefault();
    submitAuth();
  }
});

boot();
