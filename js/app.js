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

// ---- Core Algorithm ----

/**
 * Compute break time for a single employee.
 *
 * Rules:
 *   - Employees with work duration >= 6 hours (360 min) get a 1-hour break.
 *   - Break must start >= 1 hour after work start  (earliest = start + 60)
 *   - Break must end   <= 1 hour before work end   (latest start = end - 120)
 *   - Random start time (rounded to 15-min boundary) is chosen within this window.
 *
 * Proof that window is always valid for eligible employees:
 *   Minimum eligible shift = 360 min.
 *   window_size = (start + 240) - (start + 60) = 180 min > 0.
 *
 * Assumption: store hours 06:00-23:00, no shift crosses midnight.
 */
function computeBreak(emp) {
  const startMin = toMinutes(emp.start_time);
  const endMin   = toMinutes(emp.end_time);

  if (isNaN(startMin) || isNaN(endMin)) {
    console.warn(`[computeBreak] Invalid times for employee ${emp.id}:`, emp);
    return { ...emp, duration_min: NaN, eligible: false, break_start: null, break_end: null };
  }

  const durationMin = endMin - startMin;
  const eligible    = durationMin >= 360;

  const result = {
    id:           emp.id,
    name:         emp.name,
    start_time:   emp.start_time,
    end_time:     emp.end_time,
    duration_min: durationMin,
    eligible,
    break_start:  null,
    break_end:    null,
  };

  if (!eligible) return result;

  const earliestStart = startMin + 60;
  const latestStart   = endMin - 120;
  const windowSize    = latestStart - earliestStart; // always >= 180 min for eligible employees

  const rawOffset     = Math.random() * windowSize;
  const roundedOffset = Math.round(rawOffset / 15) * 15;
  const clampedOffset = Math.max(0, Math.min(roundedOffset, windowSize));

  const breakStartMin = earliestStart + clampedOffset;
  const breakEndMin   = breakStartMin + 60;

  // Development assertions (non-fatal)
  if (breakStartMin < startMin + 60)          console.warn(`[ASSERT] ${emp.id}: break starts too early`);
  if (breakEndMin   > endMin   - 60)          console.warn(`[ASSERT] ${emp.id}: break ends too late`);
  if (breakEndMin - breakStartMin !== 60)     console.warn(`[ASSERT] ${emp.id}: break is not 1 hour`);
  if (breakStartMin % 15 !== 0)               console.warn(`[ASSERT] ${emp.id}: break not on 15-min boundary`);

  result.break_start = toTimeString(breakStartMin);
  result.break_end   = toTimeString(breakEndMin);
  return result;
}

function assignAllBreaks(employees) {
  return employees.map(computeBreak);
}

// ---- DOM rendering ----

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
function updateStats(data) {
  const total      = data.length;
  const withBreak  = data.filter(e => e.eligible).length;
  const noBreak    = total - withBreak;

  document.getElementById('stats-label').textContent =
    `${withBreak} / ${total} 名に休憩を割り当て済み`;

  document.getElementById('summary-text').textContent =
    `休憩対象: ${withBreak}名（6時間以上勤務）  |  休憩なし: ${noBreak}名（6時間未満）`;
  document.getElementById('summary-banner').hidden = false;
}

// ---- Event handlers ----

function handleAssignClick() {
  scheduleData = assignAllBreaks(employeesData);
  renderTimeline(scheduleData, true);
  updateStats(scheduleData);
}

function handleResetClick() {
  scheduleData = [];
  renderTimeline(employeesData, false);
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
