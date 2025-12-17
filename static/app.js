(() => {
  /** @typedef {{id:string,title:string,done:boolean,collapsed:boolean,parentId:string|null,order:number,start:string|null,end:string|null}} Task */

  const DAY_MS = 24 * 60 * 60 * 1000;
  const DAY_WIDTH_PX = 20; // keep in sync with --day-w

  /** @type {{revision:number, updatedAt:string, doc:{tasks:Task[]}} | null} */
  let serverDoc = null;

  /** @type {{ tasks: Task[], selectedId: string|null, editingId: string|null, save:{status:'loading'|'idle'|'saving'|'error'|'conflict', message:string|null} }} */
  let state = {
    tasks: [],
    selectedId: null,
    editingId: null,
    save: { status: 'loading', message: null },
  };

  let saveTimer = null;
  let suppressScrollSync = false;

  const elStatus = document.getElementById('status');
  const elOutlineScroll = document.getElementById('outlineScroll');
  const elGanttScroll = document.getElementById('ganttScroll');
  const elGanttHeader = document.getElementById('ganttHeader');

  function setStatus(text, kind = 'normal') {
    elStatus.textContent = text;
    elStatus.classList.toggle('warn', kind === 'warn');
  }

  function uuid() {
    // Good enough for a local single-user doc.
    return 't' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  function todayISO() {
    const d = new Date();
    return toISODate(d);
  }

  function toISODate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function parseISODate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    // Validate round-trip
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    dt.setHours(0, 0, 0, 0);
    return dt;
  }

  function addDays(date, days) {
    const dt = new Date(date.getTime() + days * DAY_MS);
    dt.setHours(0, 0, 0, 0);
    return dt;
  }

  // Week starts on Sunday.
  function startOfWeek(date) {
    const dt = new Date(date);
    dt.setHours(0, 0, 0, 0);
    const day = dt.getDay(); // 0=Sun
    return addDays(dt, -day);
  }

  function endOfWeek(date) {
    return addDays(startOfWeek(date), 6);
  }

  function daysBetween(a, b) {
    const aa = new Date(a); aa.setHours(0,0,0,0);
    const bb = new Date(b); bb.setHours(0,0,0,0);
    return Math.round((bb.getTime() - aa.getTime()) / DAY_MS);
  }

  function getWeekNumber(d) {
    // Copy date so don't modify original
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    // Set to nearest Thursday: current date + 4 - current day number
    // Make Sunday's day number 7
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    // Get first day of year
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    // Calculate full weeks to nearest Thursday
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return weekNo;
  }

  /**
   * Parse dates from a task title.
   * Supports:
   * 1) YYYY-MM-DD
   * 2) today - YYYY-MM-DD
   * 3) YYYY-MM-DD - YYYY-MM-DD or YYYY-MM-DD to YYYY-MM-DD
   * 4) YYYY-MM-DD 3d (end = start + 3 days)
   *
   * Returns explicit start/end as ISO strings or null, plus cleaned title.
   */
  function parseDatesFromTitle(title) {
    let t = title;
    let start = null;
    let end = null;
    let cleaned = title;

    // today - YYYY-MM-DD
    {
      const m = t.match(/\btoday\b\s*[-–—]\s*(\d{4}-\d{2}-\d{2})\b/i);
      if (m) {
        const endDt = parseISODate(m[1]);
        if (endDt) {
          start = todayISO();
          end = toISODate(endDt);
          cleaned = t.replace(m[0], '').trim();
          return { start, end, cleaned };
        }
      }
    }

    // YYYY-MM-DD 3d
    {
      const m = t.match(/\b(\d{4}-\d{2}-\d{2})\b\s+(\d+)d\b/i);
      if (m) {
        const startDt = parseISODate(m[1]);
        const n = Number(m[2]);
        if (startDt && Number.isFinite(n)) {
          const endDt = addDays(startDt, n);
          start = toISODate(startDt);
          end = toISODate(endDt);
          cleaned = t.replace(m[0], '').trim();
          return { start, end, cleaned };
        }
      }
    }

    // Two dates: YYYY-MM-DD - YYYY-MM-DD OR YYYY-MM-DD to YYYY-MM-DD
    {
      const m = t.match(/\b(\d{4}-\d{2}-\d{2})\b\s*(?:-|to)\s*\b(\d{4}-\d{2}-\d{2})\b/i);
      if (m) {
        const a = parseISODate(m[1]);
        const b = parseISODate(m[2]);
        if (a && b) {
          start = toISODate(a);
          end = toISODate(b);
          cleaned = t.replace(m[0], '').trim();
          return { start, end, cleaned };
        }
      }
    }

    // Single date
    {
      const m = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
      if (m) {
        const d = parseISODate(m[1]);
        if (d) {
          start = toISODate(d);
          end = toISODate(d);
          cleaned = t.replace(m[0], '').trim();
          return { start, end, cleaned };
        }
      }
    }

    return { start: null, end: null, cleaned: title };
  }

  function sortSiblingsByDate(parentId) {
    const effMap = computeEffectiveDates(state.tasks);
    const siblings = state.tasks.filter(t => t.parentId === parentId);

    siblings.sort((a, b) => {
      const ea = effMap.get(a.id);
      const eb = effMap.get(b.id);
      const startA = ea ? ea.effectiveStart : null;
      const startB = eb ? eb.effectiveStart : null;
      const endA = ea ? ea.effectiveEnd : null;
      const endB = eb ? eb.effectiveEnd : null;

      // Sort by start date (earliest first), then end date, then original order.
      // Tasks with no start date go to the bottom.
      if (startA && !startB) return -1;
      if (!startA && startB) return 1;
      if (startA && startB) {
        if (startA !== startB) return startA.localeCompare(startB);
      }

      if (endA && !endB) return -1;
      if (!endA && endB) return 1;
      if (endA && endB) {
        if (endA !== endB) return endA.localeCompare(endB);
      }

      return a.order - b.order;
    });

    let changed = false;
    siblings.forEach((t, i) => {
      if (t.order !== i) {
        t.order = i;
        changed = true;
      }
    });

    if (changed) {
      scheduleSave();
      render();
    }
  }

  function sortTasksInPlace(tasks) {
    tasks.sort((a, b) => {
      if (a.parentId !== b.parentId) return (a.parentId || '').localeCompare(b.parentId || '');
      return a.order - b.order;
    });
  }

  function getChildren(tasksById, parentId) {
    /** @type {Task[]} */
    const children = [];
    for (const t of tasksById.values()) {
      if (t.parentId === parentId) children.push(t);
    }
    children.sort((a, b) => a.order - b.order);
    return children;
  }

  function buildIndex(tasks) {
    /** @type {Map<string, Task>} */
    const byId = new Map();
    for (const t of tasks) byId.set(t.id, t);
    return byId;
  }

  function computeVisibleList(tasks) {
    const byId = buildIndex(tasks);
    /** @type {Task[]} */
    const roots = tasks.filter(t => t.parentId === null).slice().sort((a,b)=>a.order-b.order);

    /** @type {{task:Task, depth:number}[]} */
    const out = [];

    function walk(task, depth) {
      out.push({ task, depth });
      if (task.collapsed) return;
      const children = getChildren(byId, task.id);
      for (const c of children) walk(c, depth + 1);
    }

    for (const r of roots) walk(r, 0);
    return out;
  }

  function computeEffectiveDates(tasks) {
    const byId = buildIndex(tasks);

    /** @type {Map<string, string[]>} */
    const childrenById = new Map();
    for (const t of tasks) {
      if (t.parentId) {
        if (!childrenById.has(t.parentId)) childrenById.set(t.parentId, []);
        childrenById.get(t.parentId).push(t.id);
      }
    }
    for (const ids of childrenById.values()) {
      ids.sort((a, b) => (byId.get(a).order - byId.get(b).order));
    }

    /** @type {Map<string, {effectiveStart: string|null, effectiveEnd: string|null, warnInvalid:boolean, warnInconsistent:boolean}>} */
    const eff = new Map();

    function compute(taskId) {
      if (eff.has(taskId)) return eff.get(taskId);
      const task = byId.get(taskId);
      const childIds = childrenById.get(taskId) || [];

      let childMinStart = null;
      let childMaxEnd = null;
      for (const cid of childIds) {
        const c = compute(cid);
        if (c.effectiveStart) {
          if (!childMinStart || c.effectiveStart < childMinStart) childMinStart = c.effectiveStart;
        }
        if (c.effectiveEnd) {
          if (!childMaxEnd || c.effectiveEnd > childMaxEnd) childMaxEnd = c.effectiveEnd;
        }
      }

      let effectiveStart = null;
      let effectiveEnd = null;

      const hasChildren = childIds.length > 0;
      const explicitStart = task.start;
      const explicitEnd = task.end;

      if (!hasChildren) {
        effectiveStart = explicitStart;
        effectiveEnd = explicitEnd;
        // If only one explicit date is available and it's start: milestone (end = start)
        if (effectiveStart && !effectiveEnd) effectiveEnd = effectiveStart;
        if (!effectiveStart && effectiveEnd) effectiveStart = effectiveEnd;
      } else {
        if (!explicitStart && !explicitEnd) {
          effectiveStart = childMinStart;
          effectiveEnd = childMaxEnd;
        } else if (explicitStart && !explicitEnd) {
          effectiveStart = explicitStart;
          effectiveEnd = childMaxEnd;
          if (!effectiveEnd) effectiveEnd = explicitStart; // milestone fallback
        } else if (!explicitStart && explicitEnd) {
          effectiveStart = childMinStart;
          effectiveEnd = explicitEnd;
          if (!effectiveStart) effectiveStart = explicitEnd;
        } else {
          effectiveStart = explicitStart;
          effectiveEnd = explicitEnd;
        }
      }

      let warnInvalid = false;
      let warnInconsistent = false;

      if (effectiveStart && effectiveEnd && effectiveStart > effectiveEnd) {
        warnInvalid = true;
      }

      if (hasChildren) {
        // If parent explicit range doesn't cover child window, warn.
        if (childMinStart && childMaxEnd) {
          const parentStart = effectiveStart;
          const parentEnd = effectiveEnd;
          if (parentStart && parentEnd) {
            if (parentStart > childMinStart || parentEnd < childMaxEnd) {
              if (task.start !== null || task.end !== null) warnInconsistent = true;
            }
          }
        }
      }

      const rec = { effectiveStart, effectiveEnd, warnInvalid, warnInconsistent, childMinStart, childMaxEnd };
      eff.set(taskId, rec);
      return rec;
    }

    for (const t of tasks) compute(t.id);
    return eff;
  }

  function pickTimeline(visible, effMap) {
    let minStart = null;
    let maxEnd = null;

    for (const { task } of visible) {
      const e = effMap.get(task.id);
      if (!e) continue;
      const s = e.effectiveStart;
      const en = e.effectiveEnd;
      if (s) {
        if (!minStart || s < minStart) minStart = s;
      }
      if (en) {
        if (!maxEnd || en > maxEnd) maxEnd = en;
      }
    }

    if (!minStart && !maxEnd) {
      return { empty: true };
    }

    // If only one bound exists overall, treat as milestone range.
    if (minStart && !maxEnd) maxEnd = minStart;
    if (!minStart && maxEnd) minStart = maxEnd;

    const rs = parseISODate(minStart);
    const re = parseISODate(maxEnd);
    const paddedStart = startOfWeek(rs);
    const paddedEnd = endOfWeek(re);

    const days = [];
    for (let d = new Date(paddedStart); d <= paddedEnd; d = addDays(d, 1)) {
      days.push(toISODate(d));
    }

    // weeks as start dates
    const weeks = [];
    for (let d = new Date(paddedStart); d <= paddedEnd; d = addDays(d, 7)) {
      weeks.push(toISODate(d));
    }

    return { empty: false, paddedStart: toISODate(paddedStart), paddedEnd: toISODate(paddedEnd), days, weeks };
  }

  function setHover(taskId, active) {
    const outlineRow = elOutlineScroll.querySelector(`.task-row[data-id="${CSS.escape(taskId)}"]`);
    const ganttRow = elGanttScroll.querySelector(`.gantt-row[data-id="${CSS.escape(taskId)}"]`);
    if (outlineRow) outlineRow.classList.toggle('hovered', active);
    if (ganttRow) ganttRow.classList.toggle('hovered', active);
  }

  function render() {
    const tasks = state.tasks;
    sortTasksInPlace(tasks);
    const visible = computeVisibleList(tasks);
    const effMap = computeEffectiveDates(tasks);

    renderOutline(visible, effMap);
    renderGantt(visible, effMap);

    const selectedRow = state.selectedId ? elOutlineScroll.querySelector(`[data-id="${CSS.escape(state.selectedId)}"]`) : null;
    if (!selectedRow && visible.length > 0) {
      state.selectedId = visible[0].task.id;
      renderOutline(visible, effMap);
    }
  }

  function renderOutline(visible, effMap) {
    const root = document.createElement('div');
    root.className = 'outline';

    for (const { task, depth } of visible) {
      const eff = effMap.get(task.id);
      const warn = eff?.warnInvalid || eff?.warnInconsistent;

      const row = document.createElement('div');
      row.className = 'task-row' + (task.id === state.selectedId ? ' selected' : '') + (warn ? ' warn' : '');
      row.dataset.id = task.id;
      row.addEventListener('mouseenter', () => setHover(task.id, true));
      row.addEventListener('mouseleave', () => setHover(task.id, false));

      const indent = document.createElement('div');
      indent.className = 'indent';
      indent.style.width = `${depth * 16}px`;

      const caret = document.createElement('div');
      caret.className = 'caret';
      caret.textContent = hasChildren(task.id) ? (task.collapsed ? '▸' : '▾') : '';
      caret.title = 'Collapse/expand';
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!hasChildren(task.id)) return;
        patchTask(task.id, { collapsed: !task.collapsed });
      });

      const checkbox = document.createElement('div');
      checkbox.className = 'checkbox' + (task.done ? ' done' : '');
      checkbox.textContent = task.done ? 'x' : '';
      checkbox.title = 'Toggle done';
      checkbox.addEventListener('click', (e) => {
        e.stopPropagation();
        patchTask(task.id, { done: !task.done });
      });

      const title = document.createElement('div');
      title.className = 'title' + (task.done ? ' done' : '');
      title.textContent = task.title || '';
      title.title = 'Click to edit';
      title.addEventListener('click', (e) => {
        e.stopPropagation();
        state.selectedId = task.id;
        state.editingId = task.id;
        render();
      });

      const badge = document.createElement('div');
      badge.className = 'badge' + (warn ? ' warn' : '');
      badge.textContent = formatEffBadge(eff);

      const delBtn = document.createElement('div');
      delBtn.className = 'del-btn';
      delBtn.textContent = '×';
      delBtn.title = 'Delete task';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSubtree(task.id);
      });

      row.addEventListener('click', () => {
        state.selectedId = task.id;
        if (state.editingId !== task.id) {
          state.editingId = !task.title ? task.id : null;
          render();
        }
      });

      row.append(indent, caret, checkbox);

      if (state.editingId === task.id) {
        const input = document.createElement('input');
        input.className = 'title-input';
        input.value = task.title;
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            commitEdit(task.id, input.value);
            addTaskBelow(task.id);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            commitEdit(task.id, input.value);
            selectRelative(-1);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            commitEdit(task.id, input.value);
            selectRelative(1);
          } else if (e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            commitEdit(task.id, input.value);
            state.editingId = task.id;
            if (e.shiftKey) outdentTask(task.id);
            else indentTask(task.id);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            state.editingId = null;
            render();
          }
        });
        input.addEventListener('blur', () => {
          commitEdit(task.id, input.value);
        });
        row.append(input);
      } else {
        row.append(title);
      }

      row.append(badge);

      if (eff && eff.warnInconsistent) {
        const fixBtn = document.createElement('div');
        fixBtn.textContent = '🔧';
        fixBtn.title = 'Fix dates';
        fixBtn.style.cursor = 'pointer';
        fixBtn.style.marginRight = '5px';
        fixBtn.style.fontSize = '12px';
        fixBtn.style.color = 'var(--muted)';
        fixBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const { cleaned } = parseDatesFromTitle(task.title);
          const s = eff.childMinStart;
          const en = eff.childMaxEnd;
          if (s && en) {
             const newTitle = cleaned.trim() + ' ' + s + ' - ' + en;
             patchTask(task.id, { title: newTitle, start: s, end: en });
          }
        });
        row.append(fixBtn);
      }

      row.append(delBtn);

      if (state.editingId === task.id) {
        const input = row.querySelector('input');
        requestAnimationFrame(() => {
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        });
      }

      root.appendChild(row);
    }

    elOutlineScroll.replaceChildren(root);

    function hasChildren(parentId) {
      return state.tasks.some(t => t.parentId === parentId);
    }

    function formatEffBadge(eff) {
      if (!eff) return '';
      const s = eff.effectiveStart;
      const e = eff.effectiveEnd;
      const warn = eff.warnInvalid || eff.warnInconsistent;

      if (!s && !e) return warn ? '!' : '';
      if (s && e && s === e) return `${s}` + (warn ? ' !' : '');
      if (s && e) return `${s} → ${e}` + (warn ? ' !' : '');
      if (s) return `${s}` + (warn ? ' !' : '');
      if (e) return `${e}` + (warn ? ' !' : '');
      return warn ? '!' : '';
    }
  }

  function renderGantt(visible, effMap) {
    const timeline = pickTimeline(visible, effMap);

    if (timeline.empty) {
      elGanttHeader.textContent = 'No dated tasks';
      elGanttScroll.textContent = '';
      return;
    }

    const days = timeline.days;
    const weeks = timeline.weeks;

    // Header
    const headerInner = document.createElement('div');
    headerInner.className = 'gantt-header-inner';

    const weekRow = document.createElement('div');
    weekRow.className = 'gantt-week-row';
    weekRow.style.gridTemplateColumns = `repeat(${weeks.length}, calc(var(--day-w) * 7))`;

    for (const w of weeks) {
      const cell = document.createElement('div');
      cell.className = 'gantt-week-cell';
      const dt = parseISODate(w);
      const weekNum = dt ? getWeekNumber(dt) : '';
      cell.textContent = `W${weekNum}`;
      weekRow.appendChild(cell);
    }

    const dayRow = document.createElement('div');
    dayRow.className = 'gantt-day-row';
    dayRow.style.gridTemplateColumns = `repeat(${days.length}, var(--day-w))`;

    for (const d of days) {
      const cell = document.createElement('div');
      cell.className = 'gantt-day-cell';
      cell.textContent = d.slice(-2);
      dayRow.appendChild(cell);
    }

    headerInner.append(weekRow, dayRow);
    elGanttHeader.replaceChildren(headerInner);

    // Body
    const grid = document.createElement('div');
    grid.className = 'gantt-grid';
    grid.style.width = `${days.length * DAY_WIDTH_PX}px`;

    const paddedStartDt = parseISODate(timeline.paddedStart);

    for (const { task } of visible) {
      const eff = effMap.get(task.id);
      const warn = eff?.warnInvalid || eff?.warnInconsistent;

      const row = document.createElement('div');
      row.className = 'gantt-row' + (warn ? ' warn' : '');
      row.dataset.id = task.id;
      row.addEventListener('mouseenter', () => setHover(task.id, true));
      row.addEventListener('mouseleave', () => setHover(task.id, false));

      // Minor daily grid
      const minor = document.createElement('div');
      minor.className = 'gantt-minor-grid';
      minor.style.gridTemplateColumns = `repeat(${days.length}, var(--day-w))`;
      for (let i = 0; i < days.length; i++) {
        const line = document.createElement('div');
        line.className = 'gantt-minor-line';
        const d = parseISODate(days[i]);
        if (d) {
          const day = d.getDay();
          if (day === 0 || day === 6) line.classList.add('weekend');
        }
        minor.appendChild(line);
      }

      // Major weekly lines
      const major = document.createElement('div');
      major.className = 'gantt-major-lines';
      major.style.gridTemplateColumns = `repeat(${weeks.length}, calc(var(--day-w) * 7))`;
      for (let i = 0; i < weeks.length; i++) {
        const line = document.createElement('div');
        line.className = 'gantt-major-line';
        major.appendChild(line);
      }

      row.append(minor, major);

      if (eff && (eff.effectiveStart || eff.effectiveEnd)) {
        let s = eff.effectiveStart || eff.effectiveEnd;
        let e = eff.effectiveEnd || eff.effectiveStart;

        if (s && !e) e = s; // milestone when only start
        if (e && !s) s = e;

        if (s && e) {
          // Clamp invalid display to at least 1 day.
          const startDt = parseISODate(s);
          const endDt = parseISODate(e);
          let leftDays = daysBetween(paddedStartDt, startDt);
          let widthDays = daysBetween(startDt, endDt) + 1;
          if (widthDays < 1) widthDays = 1;

          const bar = document.createElement('div');
          bar.className = 'bar' + (task.done ? ' done' : '') + (warn ? ' warn' : '');
          bar.style.left = `${leftDays * DAY_WIDTH_PX}px`;
          bar.style.width = `${widthDays * DAY_WIDTH_PX}px`;
          row.appendChild(bar);
        }
      }

      grid.appendChild(row);
    }

    // Today marker
    const today = todayISO();
    const todayDt = parseISODate(today);
    if (todayDt) {
      const x = daysBetween(paddedStartDt, todayDt) * DAY_WIDTH_PX;
      if (x >= 0 && x <= days.length * DAY_WIDTH_PX) {
        const line = document.createElement('div');
        line.className = 'today-line';
        line.style.left = `${x}px`;
        grid.appendChild(line);
      }
    }

    elGanttScroll.replaceChildren(grid);

    // Keep gantt header horizontally synced with gantt body.
    elGanttScroll.addEventListener('scroll', () => {
      headerInner.scrollLeft = elGanttScroll.scrollLeft;
    }, { passive: true });
  }

  function commitEdit(taskId, newTitle) {
    if (state.editingId !== taskId) return;
    state.editingId = null;
    if (!newTitle.trim()) {
      // If empty, delete it (cleanup).
      deleteSubtree(taskId);
      return;
    }

    const task = state.tasks.find(t => t.id === taskId);
    const parentId = task ? task.parentId : null;

    const parsed = parseDatesFromTitle(newTitle);
    if (parsed.start) {
      patchTask(taskId, { title: parsed.cleaned, start: parsed.start, end: parsed.end });
    } else {
      patchTask(taskId, { title: newTitle });
    }

    sortSiblingsByDate(parentId);
  }

  function patchTask(taskId, patch) {
    const t = state.tasks.find(x => x.id === taskId);
    if (!t) return;
    Object.assign(t, patch);
    scheduleSave();
    render();
  }

  function deleteSubtree(taskId) {
    const byId = buildIndex(state.tasks);
    /** @type {string[]} */
    const toDelete = [];

    function walk(id) {
      toDelete.push(id);
      for (const t of state.tasks) {
        if (t.parentId === id) walk(t.id);
      }
    }

    if (!byId.has(taskId)) return;
    walk(taskId);

    const remaining = state.tasks.filter(t => !toDelete.includes(t.id));

    if (remaining.length === 0) {
      // If deleting everything, ensure we keep at least one task.
      if (state.tasks.length === 1 && state.tasks[0].id === taskId) {
        // If it was the only task, just clear it.
        const t = state.tasks[0];
        t.title = '';
        t.done = false;
        t.start = null;
        t.end = null;
        t.collapsed = false;
      } else {
        // Otherwise reset to a fresh task.
        const id = uuid();
        state.tasks = [{
          id,
          title: '',
          done: false,
          collapsed: false,
          parentId: null,
          order: 0,
          start: null,
          end: null,
        }];
        state.selectedId = id;
        state.editingId = null;
      }
    } else {
      state.tasks = remaining;
      if (state.selectedId && toDelete.includes(state.selectedId)) {
        state.selectedId = null;
        state.editingId = null;
      }
    }

    normalizeOrders();
    scheduleSave();
    render();
  }

  function normalizeOrders() {
    // Ensure sibling orders are dense 0..n-1.
    const groups = new Map();
    for (const t of state.tasks) {
      const key = t.parentId || '__root__';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    for (const tasks of groups.values()) {
      tasks.sort((a, b) => a.order - b.order);
      tasks.forEach((t, i) => { t.order = i; });
    }
  }

  function moveTask(taskId, direction) {
    const t = state.tasks.find(x => x.id === taskId);
    if (!t) return;
    const siblings = state.tasks.filter(x => x.parentId === t.parentId).slice().sort((a,b)=>a.order-b.order);
    const idx = siblings.findIndex(x => x.id === taskId);
    const nextIdx = idx + direction;
    if (nextIdx < 0 || nextIdx >= siblings.length) return;
    const other = siblings[nextIdx];
    const tmp = t.order;
    t.order = other.order;
    other.order = tmp;
    normalizeOrders();
    scheduleSave();
    render();
  }

  function indentTask(taskId) {
    const visible = computeVisibleList(state.tasks);
    const idx = visible.findIndex(x => x.task.id === taskId);
    if (idx <= 0) return;
    const t = state.tasks.find(x => x.id === taskId);
    const prev = visible[idx - 1].task;
    if (!t || !prev) return;

    // Make prev the new parent.
    t.parentId = prev.id;
    t.order = getChildren(buildIndex(state.tasks), prev.id).length; // append
    normalizeOrders();
    scheduleSave();
    render();
  }

  function outdentTask(taskId) {
    const t = state.tasks.find(x => x.id === taskId);
    if (!t || !t.parentId) return;
    const parent = state.tasks.find(x => x.id === t.parentId);
    const grand = parent ? parent.parentId : null;

    t.parentId = grand;
    // Place after parent in new sibling list
    const siblings = state.tasks.filter(x => x.parentId === grand).slice().sort((a,b)=>a.order-b.order);
    const parentIdx = parent ? siblings.findIndex(x => x.id === parent.id) : siblings.length - 1;

    // Shift orders to make room.
    for (const s of siblings) {
      if (s.order > parentIdx) s.order += 1;
    }
    t.order = parentIdx + 1;

    normalizeOrders();
    scheduleSave();
    render();
  }

  function toggleCollapse(taskId, collapse) {
    const t = state.tasks.find(x => x.id === taskId);
    if (!t) return;
    const hasChildren = state.tasks.some(x => x.parentId === taskId);
    if (!hasChildren) return;
    t.collapsed = collapse;
    scheduleSave();
    render();
  }

  function addTaskBelow(taskId) {
    const visible = computeVisibleList(state.tasks);
    const idx = visible.findIndex(x => x.task.id === taskId);
    const current = idx >= 0 ? visible[idx].task : null;
    const parentId = current ? current.parentId : null;

    const siblings = state.tasks.filter(t => t.parentId === parentId).slice().sort((a,b)=>a.order-b.order);
    const currentIdx = current ? siblings.findIndex(x => x.id === current.id) : siblings.length - 1;

    for (const s of siblings) {
      if (s.order > currentIdx) s.order += 1;
    }

    const id = uuid();
    state.tasks.push({
      id,
      title: '',
      done: false,
      collapsed: false,
      parentId,
      order: currentIdx + 1,
      start: null,
      end: null,
    });

    normalizeOrders();
    state.selectedId = id;
    state.editingId = id;
    scheduleSave();
    render();
  }

  function toggleDone(taskId) {
    const t = state.tasks.find(x => x.id === taskId);
    if (!t) return;
    t.done = !t.done;
    scheduleSave();
    render();
  }

  function scheduleSave() {
    if (!serverDoc) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void saveNow();
    }, 600);
    if (state.save.status !== 'saving') {
      state.save.status = 'idle';
      state.save.message = null;
      setStatus('editing…');
    }
  }

  async function saveNow() {
    if (!serverDoc) return;
    state.save.status = 'saving';
    state.save.message = null;
    setStatus('saving…');

    try {
      const res = await fetch('/api/doc', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseRevision: serverDoc.revision, doc: { tasks: state.tasks } }),
      });

      if (res.status === 409) {
        const payload = await res.json();
        state.save.status = 'conflict';
        state.save.message = 'conflict';
        setStatus('conflict (reload page)', 'warn');
        // Keep local state; user can reload.
        return;
      }

      if (!res.ok) {
        state.save.status = 'error';
        setStatus('save error', 'warn');
        return;
      }

      serverDoc = await res.json();
      state.save.status = 'idle';
      setStatus('saved');
    } catch {
      state.save.status = 'error';
      setStatus('save error', 'warn');
    }
  }

  async function load() {
    setStatus('loading…');
    state.save.status = 'loading';
    try {
      const res = await fetch('/api/doc');
      serverDoc = await res.json();
      state.tasks = Array.isArray(serverDoc?.doc?.tasks) ? serverDoc.doc.tasks : [];

      // Backfill required fields for older docs.
      for (const t of state.tasks) {
        if (typeof t.done !== 'boolean') t.done = false;
        if (typeof t.collapsed !== 'boolean') t.collapsed = false;
        if (!('start' in t)) t.start = null;
        if (!('end' in t)) t.end = null;
      }

      normalizeOrders();
      state.save.status = 'idle';
      setStatus('ready');
      render();
    } catch {
      setStatus('load error', 'warn');
      state.save.status = 'error';
    }
  }

  function onKeyDown(e) {
    // If editing, let the input listener handle it (or default behavior).
    if (state.editingId) return;

    if (e.key === 'Tab') {
      e.preventDefault();
      const hovered = document.querySelector('.task-row:hover');
      const targetId = hovered ? hovered.dataset.id : state.selectedId;
      if (targetId) {
        if (e.shiftKey) outdentTask(targetId);
        else indentTask(targetId);
      }
      return;
    }

    if (!state.selectedId) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      addTaskBelow(state.selectedId);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectRelative(-1);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectRelative(1);
      return;
    }

    if (e.key === ' ' || e.key === 'x') {
      e.preventDefault();
      toggleDone(state.selectedId);
      return;
    }

    if (e.key === 'Backspace') {
      e.preventDefault();
      deleteSubtree(state.selectedId);
      return;
    }

    if (e.key === 'F2' || e.key === 'e') {
      e.preventDefault();
      state.editingId = state.selectedId;
      render();
      return;
    }

    if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault();
      moveTask(state.selectedId, -1);
      return;
    }

    if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      moveTask(state.selectedId, 1);
      return;
    }

    if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      toggleCollapse(state.selectedId, true);
      return;
    }

    if (e.altKey && e.key === 'ArrowRight') {
      e.preventDefault();
      toggleCollapse(state.selectedId, false);
      return;
    }
  }

  function selectRelative(delta) {
    const visible = computeVisibleList(state.tasks);
    const idx = visible.findIndex(x => x.task.id === state.selectedId);
    if (idx < 0) return;
    const next = Math.max(0, Math.min(visible.length - 1, idx + delta));
    state.selectedId = visible[next].task.id;
    render();
    scrollSelectedIntoView();
  }

  function scrollSelectedIntoView() {
    if (!state.selectedId) return;
    const row = elOutlineScroll.querySelector(`[data-id="${CSS.escape(state.selectedId)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
  }

  function syncScroll(from, to) {
    if (suppressScrollSync) return;
    suppressScrollSync = true;
    to.scrollTop = from.scrollTop;
    suppressScrollSync = false;
  }

  function setupScrollSync() {
    elOutlineScroll.addEventListener('scroll', () => syncScroll(elOutlineScroll, elGanttScroll), { passive: true });
    elGanttScroll.addEventListener('scroll', () => syncScroll(elGanttScroll, elOutlineScroll), { passive: true });
  }

  document.addEventListener('keydown', onKeyDown);
  setupScrollSync();
  void load();
})();
