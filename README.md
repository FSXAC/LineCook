# LineCook

A minimalist single-page to-do editor with a built-in Gantt chart.

## Stack (dead-simple)

- Browser: plain HTML/CSS/JavaScript (no React, no build step)
- Server: Python (single file) for static hosting + persistence
- Storage: one JSON file on disk (single document)

## Run

1) Start the server:

`python server.py`

2) Open:

`http://127.0.0.1:8000`

The server writes state to `data/doc.json`.

## UX (MVP)

Layout:
- Left pane (~33%): hierarchical outline to-do list
- Right pane (~67%): Gantt chart; one row per visible task

Outline:
- Enter: add a task below
- Tab / Shift+Tab: indent / outdent
- Arrow Up/Down: move selection
- Double-click (or `F2` / `e`): edit task text
- Space (or `x`): toggle done (strike-through)
- Alt+Left / Alt+Right: collapse / expand subtree
- Backspace: delete selected task (deletes subtree)

Autosave:
- Any change triggers a debounced save to the server
- Reload restores the same state from disk

## Dates

Dates are parsed from the task text and stored as explicit `start`/`end` dates in ISO `YYYY-MM-DD` format.

Supported patterns:
1) One date: `YYYY-MM-DD` (start=end)
2) Range from today: `today - YYYY-MM-DD` (start=today)
3) Two dates: `YYYY-MM-DD - YYYY-MM-DD` or `YYYY-MM-DD to YYYY-MM-DD`
4) Duration: `YYYY-MM-DD 3d` (end = start + 3 days)

### Roll-up (parents derive from children)

Definitions:
- **Explicit dates**: `start` / `end` on a task (from parsing/editing)
- **Effective dates**: what the UI/Gantt renders after roll-up

Rules:
- Leaf task:
	- If only a start date exists, it is treated as a milestone (end=start).
- Parent task:
	- Child window is computed from children’s effective dates (min start, max end).
	- Explicit bounds win per-bound:
		- No explicit start/end: effective = child window
		- Explicit start only: effectiveStart = start, effectiveEnd = childMaxEnd (or start if none)
		- Explicit end only: effectiveStart = childMinStart (or end if none), effectiveEnd = end
		- Explicit start+end: effective = explicit

Warnings (red):
- Invalid effective range (start > end)
- Parent explicit range doesn’t cover the child window (inconsistent)

## Gantt chart

- Derived from the outline (done/collapsed state and visible rows)
- Autoscaled timeline range based on visible tasks’ effective dates
- Grid markings:
	- Minor: days
	- Major: weeks (week starts on Sunday)

## Persistence (single document)

- Server endpoints:
	- `GET /api/doc` -> `{ revision, updatedAt, doc }`
	- `PUT /api/doc` with `{ baseRevision, doc }`
- If `baseRevision` is stale, server returns `409` conflict

## Files

- `server.py` — Python server (static + API)
- `static/index.html` — UI shell
- `static/styles.css` — minimal brutal styling
- `static/app.js` — state, editor, date parsing, gantt rendering
- `data/doc.json` — persisted single document

