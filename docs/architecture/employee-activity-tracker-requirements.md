# Employee Activity + Shift + Attendance + Leave — requirements and architecture

**Phase:** Planning / documentation only  
**Date:** 23 September 2026  
**Status:** Requirements for a future enhancement. **Not implemented.** This file does not change application, database, scheduler, attendance, task, notification, or AWS behavior.  
**Depends on (current system):** [01-context-and-actors.md](./01-context-and-actors.md), [05-data-architecture.md](./05-data-architecture.md), [06-api-catalog.md](./06-api-catalog.md), [04-feature-code-map.md](./04-feature-code-map.md)

Labels used below:

| Label | Meaning |
|---|---|
| **Verified** | Observed in current source |
| **Required** | Decided for this enhancement; not in source yet |
| **Assumption** | Reasonable inference; not proven in repo and not explicitly decided |
| **Open** | Needs a human decision before implementation |

---

## 1. Purpose

This document is the implementation-facing requirements record for connecting **Admin-managed employee shifts** to **attendance**, **leave**, **scheduled task release**, **shift conflict handling**, and an **Employee / Admin Activity Tracker**.

The existing DGV Employee Portal already has:

- Single-tenant `@mydgv.com` identity (Cognito + UserAccess + UserProfile)
- Daily attendance with employee-chosen hardcoded shifts
- Leave requests with admin/auto-approval that can write attendance rows
- Excel task import (IMMEDIATE and SCHEDULED)
- A 5-minute EventBridge sweep that assigns or postpones SCHEDULED tasks using attendance
- Task Green / Orange / Red zones
- Portal login/heartbeat activity
- Admin Team Activity and Employee Tracking screens

The enhancement must **keep that product working**. It must not redesign Excel import, existing assignment notifications, +24-hour postponement, task zones, multi-assignee independence, or the existing scheduler architecture.

Payroll, overtime pay, keystroke/mouse/screenshot monitoring, and productivity scores are **out of scope**.

---

## 2. Existing System Components

All items in this section are **Verified** unless marked otherwise.

### 2.1 Employee management

| Area | Location | What exists |
|---|---|---|
| Directory | `frontend/src/pages/Admin/ManageUsers.jsx`, `GET/POST /admin/users` | List/create users, roles, activate/deactivate |
| Admin profile edit | `frontend/src/pages/Admin/AdminEmployeeProfile.jsx`, `/admin/save-user-profile` | Name, empId, department, designation, skill, manager, groupLead, phone, doj, role |
| Employee profile | `frontend/src/pages/Profile.jsx`, `GET/POST /user/profile` | Employee can edit a subset; empId / manager / groupLead are read-only |
| Identity | Cognito + `UserAccessTable` PK/SK = email | Roles `SUPER_ADMIN`, `ADMIN`, `MANAGER`, `EMPLOYEE`; status `ACTIVE` / `PENDING` / `BLOCKED` |
| Profile store | `UserProfileTable` PK `USER#{email}` SK `PROFILE` | Display and HR fields; **no shift field** |

There is **no organization/tenant entity**. There is **no Admin-assigned shift** on the employee.

### 2.2 Existing shift-related fields / configuration

Shifts today are **hardcoded clocks**, not a catalog, and are **chosen by the employee on that day's attendance**, not assigned by Admin.

Canonical backend map: `backend/lambda/common/shiftWindows.js` `SHIFT_TIMES`.

| Day type | Shift name | Start | End |
|---|---|---|---|
| Full Day | Morning Shift | 11:00 | 20:00 |
| Full Day | Afternoon Shift | 14:00 | 23:00 |
| Full Day | Evening Shift | 17:00 | 23:00 |
| Half Day | Morning Shift | 11:00 | 15:30 |
| Half Day | Afternoon Shift | 14:00 | 18:30 |
| Half Day | Evening Shift | 17:00 | 20:30 |

The same values are **duplicated** in `frontend/src/pages/Attendance.jsx`. Company timezone is `Asia/Kolkata` / `+05:30`. Cross-midnight windows are **not** implemented (all `out` times use the same attendance date key). Grace period is **not** implemented. Late minutes are **not** stored.

### 2.3 Attendance

| Item | Current behavior |
|---|---|
| Table | `AttendanceTable` PK = email, SK = `YYYY-MM-DD` |
| Who marks | Employee self-submit; Super Admin is exempt |
| Frequency | Once per day; locked by `submittedAt` (`attribute_not_exists(submittedAt)`) |
| Statuses on form | `Working`, `Leave`, `Holiday`, `WeeklyOff` |
| Shift on submit | Employee **selects** `dayType` + `shift`; backend copies hardcoded in/out into `checkInTime` / `checkOutTime` |
| Live punch | `action: checkIn` / `checkOut` exist on AttendanceFunction; main `Attendance.jsx` does **not** use them; `WorkingTimeWidget` is unwired |
| Correction | Employee cannot overwrite after submit |
| Scheduler use | `scheduledAttendance.js` Gets `{ PK: email, SK: dateKey }`. **No record → ASSIGN.** Leave/Holiday/WeeklyOff/PlannedOff/Absent → postpone +24h. Same-day Working must fit the attendance shift window |

### 2.4 Leave

| Item | Current behavior |
|---|---|
| Store | WorkTasks `ENTITY#LEAVE` / `LEAVE#{id}` and `USER#{email}` / `LEAVE#{id}` |
| UI | `/leave`, `/admin/leave` |
| Submit | Future and same-calendar-day leave are allowed (`until < 0` is the only past-date block). Same-day Planned Off needs an emergency reason. Multi-day with &lt; 3 days notice needs an emergency reason |
| Approval | Admin PUT `APPROVED` or `REJECTED`. Pending auto-approves after `LEAVE_APPROVAL_HOURS` (SAM: 5 hours) |
| Materialization | On approve/auto-approve, `applyAttendanceStatus` writes `Leave` (or Planned Off writes `PlannedOff`) for each date **immediately**, skipping days that already have `checkInTime` |
| Employee cancel of approved leave | Status `CANCELLED` exists in a constant list; PUT does **not** accept cancel. Leave UI only styles a CANCELLED badge |
| Task impact | Leave does **not** unassign already-assigned tasks (**Verified** late-Leave test). Unassigned SCHEDULED tasks postpone +24h if attendance is Leave |

### 2.5 Task model / statuses

WorkTasks canonical task: `PK ENTITY#TASK`, `SK TASK#{taskId}`. Assignment: `PK TASK#{taskId}`, `SK ASSIGNMENT#{email}`.

**Assignment / workflow statuses (Verified):** `BACKLOG`, `TODO`, `IN_PROGRESS`, `REVIEW`, `DONE`, `CANCELLED`.

There is **no** assignment status string `ASSIGNED`. `ASSIGNED` today is `assignmentState` on Excel SCHEDULED tasks (`PENDING` / `ASSIGNING` / `ASSIGNED` / `SKIPPED`), meaning “released to assignees,” not a kanban column.

Employees cannot set `CANCELLED`. Red-zone employees cannot change status. Employees cannot reopen `DONE`.

### 2.6 Task assignment / reassignment / editing

- Manual create: `POST /tasks` (Manage Tasks / Add Task)
- Excel: `POST /task-imports/*` (see §2.8)
- Edit / reassign: `PUT /tasks` in `projects/handler.js`; Admin Task Details Reassign UI
- Due-date change resets assignment zones via `resetEscalationForNewDeadline`
- PUT reassignment does **not** update SCHEDULED `pendingAssignees`

### 2.7 Existing task scheduler

Excel SCHEDULED rows create a hidden task at confirm (`assignmentState PENDING`, `scheduledAssignAt` = start DateTime IST). EventBridge `${Stack}-task-escalation` `rate(5 minutes)` → `runEscalationSweep` → `assignDueScheduledTasks`.

IMMEDIATE Excel rows assign at confirm with **no** attendance check.

### 2.8 Excel import (protected)

Columns: Task Title, Project, Assignee Email, Assignment Mode, Task Type, Priority, Start Date, Start Time, Deadline Date, Deadline Time, Description. No shift column. Confirm fails the batch if any row is invalid. Deterministic `taskId` from batch + row.

### 2.9 Existing postponement

`nextScheduleFields` adds **exactly 24 hours** to `scheduledAssignAt` (and to start/due if nobody is assigned yet). Original clocks stored once: `originalStartDate`, `originalDueDate`, `originalScheduledAssignAt`. Super-admin postpone email. No max count. Not next working day.

### 2.10 Existing notifications

In-app WorkTasks `NOTIFY#` plus some SES email. Task assignment / Orange / Red are in-app (`TASK_ASSIGNED`, `TASK_ORANGE`, `TASK_RED`) with reminder dedupe keys. Postpone emails to Super Admins. Leave submit/approve/reject/auto-approve. Document S3 feed. **No Shift Conflict type today.**

### 2.11 Existing Team Activity / Employee Activity / View Activity

| Surface | Route | Data |
|---|---|---|
| Team Activity | `/admin/activity` | ActivityLog day rollup: lastSeen, eventCount, logins, devices, locations |
| Employee Tracking | `/admin/employees/:email/track` | Tabs: Overview, Attendance, Tasks, Documents, Leave, Training, Performance, Activity |
| Employee Tracking hub | `/admin/employee-tracking` | Directory into tracking |
| Attendance Activity | `/admin/attendance-activity` | Day roster |
| Weekly Attendance | `WeeklyAttendanceHistory.jsx` | Employee week strip; Holiday displayed as “Absent”; no late minutes |
| Employee dashboard | `/` | Open tasks, pending leave, announcements — **not** a shift/activity tracker |
| Portal presence | `POST /activity` login + 5-minute heartbeat | IP, device, browser, page, `sessionMinutes`; **not** working hours |

Heartbeat / lastSeen must **not** be described as productive time.

### 2.12 Database tables / entities involved

| Table | Relevance |
|---|---|
| `UserAccessTable` | Active employee identity / role |
| `UserProfileTable` | Employee profile; **will need shift assignment history** (new) |
| `AttendanceTable` | Daily status, current `shift` / `dayType` / check-in-out |
| `WorkTasksTable` | Tasks, assignments, leave, import, notifications, task activity |
| `ActivityLogTable` | Portal presence events + day summary |
| `UsersTable` | SAM-defined; **no Lambda consumers** |
| `PerformanceTable` | Unused by real metrics |

No Shift catalog table exists today.

---

## 3. Shift Management Requirements

**Required.**

### 3.1 Shift catalog

- Provide initial shifts: **Morning**, **Afternoon**, **Evening**.
- Admin (and Super Admin) can create additional shifts.
- Each shift has:
  - Name
  - Start time
  - End time
  - Grace period (minutes)
- Shifts **may cross midnight**.
- Company timezone remains Asia/Kolkata unless a later decision changes it.
- Deactivating or renaming a shift must not rewrite historical attendance or historical employee-shift rows (**Required** historical applicability).

### 3.2 What this replaces

The hardcoded `SHIFT_TIMES` maps in `shiftWindows.js` and `Attendance.jsx` become **defaults / seed data**, not the long-term source of truth. Runtime start/end/grace must come from the shift catalog (and the employee’s **applicable** assignment for that instant).

### 3.3 Out of scope

- Payroll rules tied to shift
- Automatic overtime pay from end time
- Employee self-service shift creation

---

## 4. Employee Shift Assignment

**Required.**

| Rule | Detail |
|---|---|
| Who assigns | Admin / Super Admin only |
| Who cannot change it | Employee. Employee may **view** the assigned shift (read-only) |
| Standing assignment | The employee has an applicable shift for a given instant, not a free daily picker |
| Historical applicability | Changing shift later must leave previous periods reconstructable (effective-from / effective-to or equivalent versioned rows) |
| Block while active tasks exist | Admin **cannot** change an employee’s shift while that employee has any **active** assignment |
| Active task | **Required mapping:** an assignment whose status is `TODO` or `IN_PROGRESS`, plus any assignment that is released and not `DONE` / `CANCELLED`. Business wording also says `ASSIGNED`. See §18 — existing code has no kanban status `ASSIGNED` |
| Completed | `DONE` does not block shift change |
| Cancel | Employee cannot cancel tasks. Only Admin can cancel |
| Operator sequence | Admin resolves/reassigns/cancels active work first, then changes shift |

**Assumption:** `REVIEW` and `BACKLOG` should also block shift change because they are open work. **Open** until confirmed.

**Assumption:** Hidden SCHEDULED tasks still in `assignmentState PENDING` (no `ASSIGNMENT#` row for that email) do **not** count as active for that employee. **Open** until confirmed.

**Required UX:** If Admin attempts a shift change while blocked, the UI must list blocking tasks and point to existing Task Edit / Reassign (do not invent a second reassignment product).

---

## 5. Attendance Requirements

**Required**, building on current AttendanceTable.

| Rule | Detail |
|---|---|
| Shift picker | **Removed** for employees. Show assigned shift read-only |
| Employee chooses | Attendance / work status only (Working, Leave overlay as today, Holiday, WeeklyOff — exact status list **Open** if adding Absent as a submittable status) |
| No attendance record | Must **not** block scheduled task assignment |
| No attendance record | Must **not** auto-create Absent |
| Clock | Submission uses **server-side time** (Lambda `Date.now()` / company TZ), not a client-editable punch clock for “on time vs late” |
| Before shift start | Classify as before-shift / early |
| Within grace | On time / within grace |
| After grace | Late |
| Late display | Show **actual minutes from scheduled shift start** (not from grace end unless product later says otherwise — **Open** if minutes-after-grace is preferred) |
| Once per day lock | Preserve current `submittedAt` one-shot submit unless a later phase explicitly adds correction |
| Super Admin | Remain attendance-exempt unless a later decision changes it |
| Payroll | **Not** part of this implementation |

**Verified conflict to resolve in Phase 2:** today Working submit **writes shift-templated** `checkInTime`/`checkOutTime`. **Required:** do not invent actual checkout at submit (see §7). Stored expected shift window and actual checkout must be distinguishable.

Attendance rows should snapshot the **applicable shift identity and window** (shift id/name, start, end, grace) so later catalog edits do not rewrite history.

---

## 6. Half-Day Requirements

**Required.**

- Half day is **First Half** and **Second Half**, not three hardcoded half-day shift names.
- Timing is **derived from the applicable assigned shift**, not from current `SHIFT_TIMES` Half Day rows (11:00–15:30 etc.).
- Example **Assumption** (confirm before code): for a shift 11:00–20:00 (9 hours), first half is 11:00 through midpoint, second half is midpoint through 20:00. Midpoint and inclusivity of the boundary **Open**.
- Cross-midnight shifts: first/second half must be computed on the shift **window**, not the calendar date alone.
- Scheduler same-day fit for a half-day Working day must use the **half window**, not the full shift.

---

## 7. Checkout / Worked Beyond Shift

**Required.**

| Rule | Detail |
|---|---|
| Expected checkout | Shift end (or half-day end) is the **expected** checkout time |
| Do not invent actual checkout | Do not copy shift end into `checkOutTime` as if the employee left then |
| Employee checkout | Employee may record checkout (reuse/adapt existing check-out API if it can store actual time without breaking historical templated rows) |
| Worked beyond shift | Employee may report that they worked past shift end and provide a description/reason |
| Purpose | Informational / activity data only |
| Not | Payroll, overtime calculation, or automatic extra pay |

**Verified:** current Working submit already writes templated in/out. Phase 2 must stop presenting those times as actual punches for new records while remaining honest about old rows (see §15).

---

## 8. Leave Requirements

**Required**, extending current leave — not a replacement workflow.

| Rule | Current (**Verified**) | This enhancement (**Required**) |
|---|---|---|
| Future leave | Allowed | Keep |
| Approval | Admin, plus 5-hour auto-approve | Keep Admin approval. Auto-approve policy **Open** (keep vs disable) |
| Effective date | Attendance Leave rows written **at approval time** for the whole range | Approved leave becomes effective **on the applicable date** so that day’s status is available to scheduler/activity. Do not require a second employee submit |
| Same-day leave | Allowed any time that calendar day | Allowed **only before the employee’s shift starts** |
| Cancel confirmed future leave | Not implemented | Employee may cancel confirmed future leave **before shift start** on each remaining day / remaining range as specified in implementation |
| Audit | Leave copies overwritten in place on status change | Preserve history; do not silently destroy records (append status history or immutable events) |
| Already assigned tasks | Not revoked | **Must not** auto-revoke/reassign |

Leave materialization should still produce a day’s availability signal the scheduler can read (attendance status `Leave` or an equivalent dated leave fact). Prefer writing/updating the attendance day **when that date becomes current**, or writing a dated leave fact that the scheduler already understands — without wiping employee-submitted Working for days that already have actual check-in (**Verified** leave overlay already skips `checkInTime`).

Planned Off remains a separate current path; whether it follows the same “before shift start” rule is **Open**.

---

## 9. Task Scheduler Rules

**Required** changes are limited to **how availability and shift fit are evaluated** for **not-yet-assigned** SCHEDULED work. The EventBridge 5-minute sweep, Excel confirm, deterministic IDs, PENDING hidden tasks, and +24h postpone **remain**.

### 9.1 Protected scheduler architecture

Do **not** replace:

- Excel IMMEDIATE vs SCHEDULED
- Hidden PENDING until `scheduledAssignAt`
- `assignDueScheduledTasks` / `classifyScheduledAssignees` / per-email decisions
- +24-hour postponement for Leave / Holiday / Weekly Off / Absent / PlannedOff
- IMMEDIATE import assigning without attendance
- Multi-assignee independence

### 9.2 For a task that has **not** yet been assigned (pending email)

1. Determine the **applicable employee shift** for `scheduledAssignAt` (Admin-assigned historical shift, not the attendance picker).
2. Evaluate attendance / availability for that company date.
3. Leave / Holiday / Weekly Off / Absent: existing **+24h postponement**.
4. **No attendance record does not block assignment.**
5. Working (or equivalent present) continues toward assignment.
6. Same-day task must **completely fit** inside the applicable shift window (see §10).
7. If it fits → assign normally (existing assignment + existing assignment notifications).
8. If it does not fit → **SHIFT CONFLICT** (see §10). Do **not** +24h-loop that conflict.
9. Shift Conflict must **not** enter Green → Orange → Red progression.
10. Shift Conflict must **not** cause endless +24h postponement.

### 9.3 For an **already assigned** task

- Do **not** automatically postpone, revoke, or reassign because the employee later takes leave or changes attendance.
- Multi-day assigned tasks stay assigned; original start/due remain.
- Attendance/leave belong in **activity**, not rewritten task history.

### 9.4 Shift source for window checks

Replace `windowMsFromRecord(attendance.dayType, attendance.shift)` as the **primary** window with the **assigned shift applicable at `scheduledAssignAt`**. Attendance status still decides postpone vs continue. If Working, fit is against the **assigned** shift (and half-day slice if that day is half).

---

## 10. Same-Day Task / Shift Conflict

**Required.**

A task is same-day when start and due fall on the same **shift window** / company interpretation used for fit (today: same company calendar day in `isSameCompanyDay`; cross-midnight shifts **must** treat the window as start→end even if the end date key is the next calendar day).

**Fit rule:** `taskStart >= shiftStart AND taskDue <= shiftEnd` (complete containment). Equality at the boundary is valid (example: due 8:00 PM on an 11:00–20:00 shift).

| Example | Employee shift | Task | Result |
|---|---|---|---|
| Valid | 11:00–20:00 | 17:00–20:00 | Assign |
| Conflict | 11:00–20:00 | 18:00–22:00 | SHIFT CONFLICT |
| Conflict | 11:00–20:00 | 10:00–12:00 | SHIFT CONFLICT |

**SHIFT CONFLICT handling:**

- Do not postpone +24h.
- Do not start Orange/Red on that pending assignment.
- Keep the work out of the employee’s normal task list until Admin resolves (similar to today’s pending scheduled hide, or a dedicated conflict state — **Open** exact `assignmentState` name).
- Notify **Admin and Super Admin** (new notification type). Recipients/templates for **existing** types stay unchanged.
- Admin resolves with **existing** Task Edit / Reassign (`PUT /tasks`, Task Details). No second reassignment system.
- After Admin changes timing or assignee, evaluate the resulting pending/new assignment against **that** employee’s applicable shift (repeat fit or assign).

Multi-day tasks are **not** required to fit the due instant into the assign-day shift (**Verified** today). That rule **stays** unless §18 changes it.

---

## 11. Multi-Day Task Rules

**Required** = preserve current semantics unless noted.

- One task record, not one generated task per day.
- Assign on the start/release day if availability allows (including no attendance record).
- After assignment, later Leave/absence does not pause, move due, or split the task.
- Original start and deadline stay put.
- Per leftover pending assignee, existing duration replay (`scheduledAssignAt` + original duration) remains for postpone cases that are **not** Shift Conflict.
- Activity may show leave/attendance on middle days without rewriting task activity lines.

---

## 12. Task Reassignment / Timing Change

**Required.**

- Reuse `PUT /tasks` and Admin Task Details.
- Employees still cannot cancel; Admin can `CANCELLED`.
- When Admin changes **due/start** or **assignee**:
  - Existing due-date zone reset for **normal** assigned work remains.
  - If the target is still unassigned SCHEDULED / Shift Conflict, re-run **shift fit** against the **new** assignee’s applicable shift and the **new** times.
  - If it fits, assign/notify using **existing** assignment notification behavior.
  - If it does not fit, remain/return Shift Conflict and notify Admin/Super Admin again (dedupe **Open** so edits do not spam).
- Do not rewrite historical `originalStartDate` / postpone fields as a side effect of shift catalog edits.
- Do not create duplicate task IDs for reassignment.

**Verified gap:** PUT today ignores `pendingAssignees`. Phase 5 must wire Edit/Reassign into the scheduled/conflict pending list **without** replacing Excel identity or assignment SK `ASSIGNMENT#{email}`.

---

## 13. Notification Rules

**Required.**

| Existing | Policy |
|---|---|
| Excel / scheduled `TASK_ASSIGNED` | Unchanged |
| Orange / Red | Unchanged; Shift Conflict must not enter this path |
| Postpone Super Admin email | Unchanged for Leave/Holiday/WeeklyOff/Absent +24h |
| Leave notifications | Unchanged except new cancel/effective-date events if needed |
| Dedup keys / templates / recipients for those types | Unchanged |

**New:** Shift Conflict → Admin and Super Admin. Channel (in-app vs email) **Open**; default **Assumption:** in-app + email to Admin/Super Admin, not to the employee, until decided.

Do not send assignment notifications until the task is actually assigned.

---

## 14. Activity Tracker Requirements

**Required.** Combine facts. Do **not** invent a score.

### 14.1 Data sources

1. **Attendance** — status, expected shift window, late minutes, early/grace, checkout if present, worked-beyond reason  
2. **Tasks** — assignment, status changes, completion, postpone, Shift Conflict, reassignment (existing task activity + new conflict events)  
3. **Portal activity / presence** — login, heartbeat, lastSeen, page, device, IP  

Heartbeat `sessionMinutes` is **presence**, not working hours.

### 14.2 Weekly Attendance (evolve existing widget)

Show employees against days of the week with:

- Attendance status
- Assigned/applicable shift
- Timing (expected start; actual checkout if any; late minutes)
- Do not map Holiday to “Absent” without a product decision (**Verified** weekly widget currently maps Holiday → Absent)

### 14.3 My Activity (employee)

Employee should see:

- Assigned shift
- Attendance for the period
- Lateness
- Task activity (their assignments)
- Portal activity (presence)
- Worked-beyond-shift explanation

Logical fit: employee nav beside Attendance / Leave / Profile. There is **no** My Activity page today.

### 14.4 Admin Activity

Help management see attendance, task lifecycle, and portal presence.

Logical fit: extend `/admin/activity`, `/admin/employees/:email/track`, and `/admin/attendance-activity` rather than a fourth unrelated app.

**Must not:** ranking, productivity score, charged-hours from heartbeat, or Performance stub as the source of truth.

---

## 15. Historical Data Requirements

**Required.**

- Old attendance rows that used templated shift in/out remain readable.
- New rows must not pretend those templated times were live punches if a discriminator is added (`source: TEMPLATE` vs `ACTUAL` or equivalent) — **Assumption** on field name.
- Employee shift changes are versioned; reporting a past date uses the shift applicable **that day**.
- Leave status changes keep an audit trail.
- Task start/due are not rewritten because an Admin later changes a shift definition or an employee’s future shift.
- Completed tasks stay completed; their `completedAt` / `completedZone` stay.
- ActivityLog events are append-only as today.
- Backfill of late minutes for historical templated rows is **out of scope** unless a later phase says otherwise (**Assumption**).

---

## 16. Explicitly Protected Existing Functionality

Do **not** redesign or regress:

1. Excel task import/distribution (columns, preview/confirm, IMMEDIATE vs SCHEDULED, idempotent task IDs)
2. Existing task scheduler architecture (5-minute sweep, PENDING hide, lease, per-email classify)
3. Existing task assignment notifications (type, recipients, dedup)
4. Existing postponement notifications
5. Existing notification templates / recipients / deduplication for current types
6. Existing task zones (Green / Orange / Red from due date)
7. Existing multi-assignee independence
8. Existing task lifecycle statuses and employee Red-zone lock
9. +24-hour postponement for non-conflict unavailability
10. IMMEDIATE Excel assignment without attendance
11. No-attendance-record **does not block** assignment (this matches current ASSIGN on `NOT_MARKED` and is now an explicit product rule)
12. Already-assigned tasks not revoked by later leave

The **only** intentional scheduler behavior change for unassigned same-day unfit tasks is: **Shift Conflict instead of `OUTSIDE_SHIFT` +24h postpone.**

---

## 17. Implementation Phases

Do not implement these in the documentation session. Suggested order so the current portal keeps working:

### Phase 1 — Shift foundation

- Shift catalog (seed Morning / Afternoon / Evening with current clocks as initial values + configurable grace)
- Admin CRUD for additional shifts
- Cross-midnight window helpers
- Employee shift assignment with history
- Block shift change while active tasks exist
- Employee read-only shift on profile/attendance (UI may still be incomplete until Phase 2)

### Phase 2 — Attendance integration

- Remove employee shift picker
- Server-side classification: early / within grace / late minutes
- Stop inventing actual checkout on Working submit
- Employee checkout + worked-beyond reason
- Snapshot applicable shift on the attendance row
- Half-day First/Second derived from assigned shift

### Phase 3 — Leave

- Same-day leave only before shift start
- Employee cancel of confirmed future leave before shift start
- Effective-on-date materialization for scheduler/activity
- Leave audit history
- Do not revoke assigned tasks

### Phase 4 — Scheduler integration

- Pending SCHEDULED work uses **assigned** shift for fit
- Keep +24h for Leave/Holiday/WeeklyOff/Absent
- Keep no-record → assign
- Cross-midnight fit
- Do not change Excel import

### Phase 5 — Shift Conflict + existing reassignment

- Conflict state, exclude from Orange/Red
- Notify Admin / Super Admin
- Wire existing Edit/Reassign to re-evaluate fit
- No duplicate reassignment product

### Phase 6 — Activity Tracker

- My Activity
- Weekly Attendance evolution
- Admin Activity composition (attendance + tasks + presence)
- No productivity score

### Phase 7 — Final hardening / regression

- Excel import regression
- Postpone / notify / zone regression
- Multi-assignee regression
- Historical row compatibility
- Super Admin attendance exemption
- Confirm no payroll coupling

---

## 18. Open Questions / Assumptions

### 18.1 Must decide before Phase 1–2 code

1. **What is “ASSIGNED” as an active task?** Existing assignment statuses are `TODO`, `IN_PROGRESS`, `REVIEW`, `BACKLOG`, `DONE`, `CANCELLED`. Recommendation **Assumption:** treat any non-`DONE` / non-`CANCELLED` assignment row as active for shift-change blocking, including `REVIEW` and `BACKLOG`.
2. Do **PENDING** scheduled tasks (hidden, no assignment row) block shift change? **Assumption:** no.
3. Do **Shift Conflict** items block shift change? **Assumption:** yes — Admin should resolve them first.
4. Who may manage the shift catalog and assign shifts — Admin only, or also Manager / Super Admin? **Assumption:** same portal admins who manage users (`ADMIN` + `SUPER_ADMIN`); Manager **Open**.
5. Initial Morning/Afternoon/Evening clocks: keep **Verified** 11:00–20:00 / 14:00–23:00 / 17:00–23:00, or replace on seed? Grace default minutes **Open** (not in code today).
6. Late minutes: from shift start, or from end of grace?
7. Half-day midpoint formula, especially for odd-length and overnight shifts.
8. Is **Absent** a status employees can submit, or only a scheduler/legacy value?

### 18.2 Must decide before Phase 3

9. Keep **5-hour leave auto-approve**?
10. Cancel: cancel entire remaining range vs day-by-day?
11. Planned Off: same “before shift start” rule as leave?
12. If approved leave exists for today but the employee already submitted Working with check-in — leave overlay already skips those days. Keep that?

### 18.3 Must decide before Phase 5

13. Exact persistence for Shift Conflict (`assignmentState`, reason code, task-level vs per-assignee). **Assumption:** per pending email, like today’s postpone list.
14. Should conflict tasks appear on a dedicated Admin queue, or only via notification + Task Details by id?
15. Shift Conflict notify: in-app, email, or both; include Manager?
16. After Admin edits times so the task fits, assign immediately or wait until `scheduledAssignAt`?

### 18.4 Activity

17. Weekly Attendance: stop mapping Holiday → Absent?
18. My Activity date range default (today vs week vs month)?
19. Whether checkout is required to close the day or optional.

### 18.5 Assumptions already used in this document

- Company timezone stays Asia/Kolkata.
- Excel columns stay unchanged (no shift column).
- IMMEDIATE import stays attendance-agnostic.
- No-attendance continues to **allow** assignment (aligned with current `NOT_MARKED` → ASSIGN).
- Portal heartbeat is presence, never “hours worked.”
- Payroll remains out of scope.
- Existing `UsersTable` / `PerformanceTable` are not the store for this feature.

---

## Appendix A — Current vs future behavior (scheduler fit)

| Situation (unassigned SCHEDULED, due now) | Today (**Verified**) | This enhancement (**Required**) |
|---|---|---|
| No attendance | ASSIGN | ASSIGN (explicitly kept) |
| Leave / Holiday / WeeklyOff / Absent | Postpone +24h | Postpone +24h |
| Working, same-day, fits window | ASSIGN | ASSIGN, window from **assigned** shift |
| Working, same-day, does not fit | Postpone +24h `OUTSIDE_SHIFT` | **SHIFT CONFLICT** (no +24h loop) |
| Working, multi-day | ASSIGN without due-in-window check | Keep |
| Already assigned, later Leave | No change | No change |
| Employee-picked shift | Yes | No; Admin-assigned shift |

---

## Appendix B — Suggested code touch points (not a change list)

Documentation only. Future phases are expected to touch, among others:

- `backend/lambda/common/shiftWindows.js`
- `backend/lambda/projects/scheduledAttendance.js`
- `backend/lambda/projects/taskImportConfirm.js` (conflict branch only)
- `backend/lambda/projects/handler.js` (PUT re-eval, cancel remains admin)
- `backend/lambda/attendance/handler.js`
- `backend/lambda/leave/handler.js`
- `frontend/src/pages/Attendance.jsx`
- `frontend/src/pages/Leave.jsx`
- `frontend/src/pages/Admin/AdminEmployeeProfile.jsx` / `ManageUsers.jsx`
- `frontend/src/pages/Admin/TaskDetails.jsx`
- `frontend/src/components/WeeklyAttendanceHistory.jsx`
- `frontend/src/pages/Admin/TeamActivity.jsx` / `EmployeeTracking.jsx`
- SAM: new shift persistence (table or WorkTasks entities) — **Open** which store

Do not treat this appendix as authorization to modify those files in the documentation phase.
