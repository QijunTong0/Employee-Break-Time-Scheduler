// ---- Store hours constants ----
const STORE_START_MIN = 360;   // 06:00
const STORE_END_MIN   = 1380;  // 23:00
const STORE_RANGE_MIN = 1020;  // 17 hours

// ---- State ----
let employeesData = []; // Raw JSON array loaded from data/employees.json
let scheduleData  = []; // Enriched array with computed break times

// ---- Utility functions ----

/**
 * Convert "HH:MM" string to total minutes from midnight.
 * e.g. "09:30" -> 570
 */
function toMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Convert total minutes from midnight to "HH:MM" string.
 * e.g. 570 -> "09:30"
 */
function toTimeString(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/**
 * Format a duration in minutes to a human-readable "Xh YYm" string.
 * e.g. 510 -> "8h 30m"
 */
function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/**
 * Convert a time in minutes to a left-position percentage within the store hour range.
 */
function toPct(minutes) {
  return ((minutes - STORE_START_MIN) / STORE_RANGE_MIN * 100).toFixed(3);
}

/**
 * Convert a duration in minutes to a width percentage within the store hour range.
 */
function durationToPct(durationMin) {
  return (durationMin / STORE_RANGE_MIN * 100).toFixed(3);
}

// ---- Optimization: workCount array ----

// 15-min slot count for store hours 06:00-23:00 (1020 min / 15 = 68 slots)
const NUM_SLOTS = 68;

/**
 * Convert minutes-from-midnight to a slot index (0 = 06:00, 67 = 22:45).
 * All times must be on 15-min boundaries.
 */
function toSlot(minutes) {
  return (minutes - STORE_START_MIN) / 15;
}

/**
 * Build the initial workCount array from employee schedules (no breaks applied).
 * workCount[k] = number of employees working during 15-min slot k.
 */
function buildWorkCount(employees) {
  const wc = new Int32Array(NUM_SLOTS);
  for (const emp of employees) {
    const startSlot = toSlot(toMinutes(emp.start_time));
    const endSlot   = toSlot(toMinutes(emp.end_time));   // exclusive
    for (let k = startSlot; k < endSlot; k++) wc[k]++;
  }
  return wc;
}

/**
 * Compute the sum-of-squares loss L = Σ W(t)².
 * Minimizing this is equivalent to minimizing Var(W) since the mean is fixed.
 */
function computeLoss(workCount) {
  let loss = 0;
  for (const w of workCount) loss += w * w;
  return loss;
}

/**
 * Add or remove a 1-hour break from workCount.
 * delta = -1 to apply break (employee goes on break → fewer workers).
 * delta = +1 to remove break (restore workCount before re-optimizing).
 */
function applyBreak(workCount, breakStartMin, delta) {
  const k0 = toSlot(breakStartMin);
  workCount[k0]     += delta;
  workCount[k0 + 1] += delta;
  workCount[k0 + 2] += delta;
  workCount[k0 + 3] += delta;
}

/**
 * Find the optimal break start (minutes) for one employee given current workCount.
 *
 * Key insight: placing the break at slot k0 changes the loss by:
 *   ΔL = Σ_{j=0}^{3} [(W[k0+j]-1)² - W[k0+j]²] = 4 - 2·Σ W[k0+j]
 *
 * Minimizing ΔL ⟺ maximizing Σ W[k0+j] over the 4 slots (1 hour).
 * → "place the break where the most people are working"
 */
function bestBreakStart(emp, workCount) {
  const earliest = toMinutes(emp.start_time) + 60;
  const latest   = toMinutes(emp.end_time)  - 120;

  let bestScore = -Infinity;
  let bestB     = earliest;

  for (let b = earliest; b <= latest; b += 15) {
    const k0    = toSlot(b);
    const score = workCount[k0] + workCount[k0+1] + workCount[k0+2] + workCount[k0+3];
    if (score > bestScore) { bestScore = score; bestB = b; }
  }
  return bestB;
}

/**
 * Assign break times using Greedy + Coordinate Descent to minimize Σ W(t)².
 *
 * Algorithm:
 *   1. Build initial workCount (all employees working, no breaks).
 *   2. Greedy pass: assign each eligible employee the 1-hour window
 *      that currently has the most workers (highest ΔL reduction).
 *   3. Coordinate descent: repeatedly re-optimize each employee's break
 *      (remove their current break, find new best, re-apply) until no
 *      improvement occurs or MAX_ITER is reached.
 *
 * @param {Array} employees - Raw employee array from JSON
 * @returns {{ results: Array, initialLoss: number, finalLoss: number }}
 */
function assignAllBreaks(employees) {
  const workCount = buildWorkCount(employees);
  const initialLoss = computeLoss(workCount);

  // Build result objects (ineligible employees have null breaks)
  const results = employees.map(emp => {
    const startMin    = toMinutes(emp.start_time);
    const endMin      = toMinutes(emp.end_time);
    const durationMin = endMin - startMin;
    return {
      id: emp.id, name: emp.name,
      start_time: emp.start_time, end_time: emp.end_time,
      duration_min: durationMin,
      eligible:    durationMin >= 360,
      break_start: null, break_end: null,
    };
  });

  const eligible = results.filter(e => e.eligible);

  // Step 1: Greedy pass
  for (const emp of eligible) {
    const b = bestBreakStart(emp, workCount);
    emp.break_start = toTimeString(b);
    emp.break_end   = toTimeString(b + 60);
    applyBreak(workCount, b, -1);
  }

  // Step 2: Coordinate descent
  const MAX_ITER = 30;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    let improved = false;
    for (const emp of eligible) {
      const currentB = toMinutes(emp.break_start);
      applyBreak(workCount, currentB, +1);   // temporarily remove
      const newB = bestBreakStart(emp, workCount);
      if (newB !== currentB) improved = true;
      applyBreak(workCount, newB, -1);        // apply best (or same)
      emp.break_start = toTimeString(newB);
      emp.break_end   = toTimeString(newB + 60);
    }
    if (!improved) break;
  }

  return { results, initialLoss, finalLoss: computeLoss(workCount), workCount };
}

// ---- DOM rendering ----

/**
 * Render the workcount row.
 * Shows the number of working employees per 15-min slot as plain numbers,
 * centered at the midpoint of each slot.
 * @param {Int32Array} workCount
 */
function renderWorkCountRow(workCount) {
  const track    = document.getElementById('workcount-track');
  const maxCount = Math.max(...workCount, 1);

  track.innerHTML = '';
  for (let k = 0; k < NUM_SLOTS; k++) {
    const count = workCount[k];
    const ratio = count / maxCount;
    const color = ratio >= 0.85 ? '#ef4444'
                : ratio >= 0.60 ? '#f97316'
                : '#9ca3af';

    const slotStart = toTimeString(STORE_START_MIN + k * 15);
    const slotEnd   = toTimeString(STORE_START_MIN + (k + 1) * 15);

    const el = document.createElement('div');
    el.style.color      = color;
    el.style.fontWeight = ratio >= 0.85 ? '700' : '400';
    el.textContent      = count;
    el.title            = `${slotStart}–${slotEnd}: ${count}名`;
    track.appendChild(el);
  }
}

/**
 * Build the time axis header with hour marks from 06:00 to 23:00.
 */
function buildTimeAxis() {
  const axis = document.getElementById('time-axis');
  axis.innerHTML = '';

  for (let h = 6; h <= 23; h++) {
    const leftPct = ((h * 60 - STORE_START_MIN) / STORE_RANGE_MIN * 100).toFixed(3);
    const mark = document.createElement('div');
    mark.className = 'hour-mark';
    mark.style.left = leftPct + '%';
    mark.textContent = String(h).padStart(2, '0') + ':00';
    axis.appendChild(mark);
  }
}

/**
 * Render employee rows as a horizontal timeline (Gantt chart style).
 *
 * @param {Array}   data     - Employee objects (raw or enriched with break times)
 * @param {boolean} assigned - true after break assignment; false for initial load
 */
function renderTimeline(data, assigned = false) {
  const body = document.getElementById('timeline-body');
  body.innerHTML = '';

  data.forEach((emp, idx) => {
    const startMin    = toMinutes(emp.start_time);
    const endMin      = toMinutes(emp.end_time);
    const durationMin = endMin - startMin;

    // Work bar positioning
    const workLeft  = toPct(startMin);
    const workWidth = durationToPct(durationMin);
    const workTitle = `${emp.name} (${emp.id})\n勤務: ${emp.start_time} – ${emp.end_time}  ${formatDuration(durationMin)}`;

    // Break bar positioning (only when assigned and eligible)
    let breakBarHTML = '';
    if (assigned && emp.eligible && emp.break_start) {
      const breakStartMin = toMinutes(emp.break_start);
      const breakLeft  = toPct(breakStartMin);
      const breakWidth = durationToPct(60);
      const breakTitle = `休憩: ${emp.break_start} – ${emp.break_end}`;
      breakBarHTML = `<div class="bar bar-break"
        style="left:${breakLeft}%;width:${breakWidth}%"
        title="${breakTitle}"></div>`;
    }

    const row = document.createElement('div');
    row.className = 'timeline-row' + (idx % 2 === 1 ? ' row-odd' : '');

    const durationStr = formatDuration(durationMin);
    const metaStr = assigned
      ? (emp.eligible ? `${emp.id} · ${durationStr} · 休憩あり` : `${emp.id} · ${durationStr} · 休憩なし`)
      : `${emp.id} · ${durationStr}`;

    row.innerHTML = `
      <div class="name-cell">
        <span class="emp-name">${emp.name}</span>
        <span class="emp-meta">${metaStr}</span>
      </div>
      <div class="time-track">
        <div class="bar bar-work"
          style="left:${workLeft}%;width:${workWidth}%"
          title="${workTitle}"></div>
        ${breakBarHTML}
      </div>
    `;
    body.appendChild(row);
  });
}

/**
 * Update the stats label and summary banner after break assignment.
 */
function updateStats(data, initialLoss, finalLoss) {
  const total     = data.length;
  const withBreak = data.filter(e => e.eligible).length;
  const noBreak   = total - withBreak;

  document.getElementById('stats-label').textContent =
    `${withBreak} / ${total} 名に休憩を割り当て済み`;

  document.getElementById('summary-text').textContent =
    `休憩対象: ${withBreak}名（6時間以上勤務）  |  休憩なし: ${noBreak}名（6時間未満）` +
    `  |  損失（Σ W²）: ${initialLoss.toLocaleString()} → ${finalLoss.toLocaleString()}`;
  document.getElementById('summary-banner').hidden = false;
}

// ---- Event handlers ----

function handleAssignClick() {
  const { results, initialLoss, finalLoss, workCount } = assignAllBreaks(employeesData);
  scheduleData = results;
  renderTimeline(scheduleData, true);
  updateStats(scheduleData, initialLoss, finalLoss);
  renderWorkCountRow(workCount);
}

function handleResetClick() {
  scheduleData = [];
  renderTimeline(employeesData, false);
  renderWorkCountRow(buildWorkCount(employeesData));
  document.getElementById('stats-label').textContent = '';
  document.getElementById('summary-banner').hidden = true;
}

// ---- Data loading ----

/**
 * Load employees from JSON via fetch().
 * Requires an HTTP server — run: npm start
 */
function loadEmployees() {
  fetch('./data/employees.json')
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(data => {
      employeesData = data;
      buildTimeAxis();
      renderTimeline(employeesData, false);
      renderWorkCountRow(buildWorkCount(employeesData));
      document.getElementById('btn-assign').disabled = false;
      document.getElementById('btn-reset').disabled  = false;
    })
    .catch(err => {
      const el = document.getElementById('error-msg');
      el.innerHTML = `
        <strong>データの読み込みに失敗しました。</strong><br>
        <code>fetch()</code> は <code>file://</code> プロトコルでは動作しません。<br>
        以下のコマンドでローカルサーバを起動してください：<br>
        <code>npm install</code> の後に <code>npm start</code><br>
        その後ブラウザで <code>http://localhost:8080</code> を開いてください。<br>
        <small style="opacity:0.7">詳細: ${err.message}</small>
      `;
      el.hidden = false;
      document.getElementById('timeline-body').innerHTML =
        '<div class="loading-placeholder">データを読み込めませんでした。</div>';
    });
}

// ---- Initialization ----

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-assign').addEventListener('click', handleAssignClick);
  document.getElementById('btn-reset').addEventListener('click', handleResetClick);
  loadEmployees();
});
