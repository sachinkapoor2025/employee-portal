# 15 — Stage 1: Project ACL implementation plan

**Stage:** 1 plan (original document was planning-only). Later stages implemented OPEN/RESTRICTED ACL, catalog PATCH/DELETE UserAccess ADMIN/SUPER_ADMIN rules, membership APIs, and Stage 3G lifecycle/import integrity.  
**Date:** 21 September 2026  
**Status:** Historical plan plus later live behavior. Tables in §1 that say Cognito `isAdmin` for project mutate are **stale**; live PATCH/DELETE require ACTIVE UserAccess ADMIN/SUPER_ADMIN. Restricted project create remains **off** unless the existing env flag is enabled. Document/leave authorization is unchanged.  
**Supersedes for build:** [12](./12-project-acl-requirements.md) and [13](./13-project-acl-technical-design.md) where they conflict (Super Admin bypass, default RESTRICTED).  
**Audit facts:** [11-project-level-access-control-audit.md](./11-project-level-access-control-audit.md)  
**Path rule:** [14-employee-admin-path-separation.md](./14-employee-admin-path-separation.md)

No application, DynamoDB, AWS, or deploy changes in this stage.

Labels: **Verified** · **Proposed** (for later stages) · **Unknown** · **Open**.

---

## 1. Architecture audit (current system)

### 1.1 Authentication (Verified)

| Layer | Behavior |
|---|---|
| API | Cognito JWT authorizer (`template.yaml`) |
| Identity | `getUser()` → `email` (lowercased), `groups`, `isAdmin` if group `Admin` (`common/auth.js`) |
| Portal roles | UserAccess `SUPER_ADMIN` \| `ADMIN` \| `MANAGER` \| `EMPLOYEE` (`common/roles.js`) |
| Admin SPA gate | `accessGateForRole`: SUPER_ADMIN, ADMIN, **MANAGER** → `ADMIN` |
| Documents write helper | `canManageProjectDocuments`: SUPER_ADMIN or ADMIN **only** (excludes MANAGER) |
| Project/task mutate | Cognito `isAdmin` for most writes; **DELETE `/projects/{id}`** uses ACTIVE UserAccess ADMIN/SUPER_ADMIN |

The app uses **both** Cognito groups (API `isAdmin`) and UserAccess roles (access gate, lifecycle, some document rules).

### 1.2 Manager finding (Verified — Open for Project Admin eligibility)

Managers:

- Have Cognito **Admin** group (`cognitoGroupForRole`).
- Pass every current project/task **Admin** check (`user.isAdmin`).
- Are **not** treated as document-project writers (`canManageProjectDocuments`).
- Are **not** completion/Red email recipients (`isAdminOrSuperAdminRole` excludes MANAGER).

Business rule: Project Admin must be “active portal Admin or Super Admin” and “Employees must not be Project Admins.” It does **not** name MANAGER.

**Open Q1:** Allow MANAGER as Project Admin because they already mutate work projects, or exclude them to match `canManageProjectDocuments` / “Admin or Super Admin”?

**Proposed default for implementation (until Q1 resolved):** Project Admin eligibility = UserAccess `ADMIN` or `SUPER_ADMIN`, status `ACTIVE`. MANAGER and EMPLOYEE rejected. Document the choice in the implementing PR if Q1 is decided otherwise.

### 1.3 Projects (Verified)

| Action | Module | AuthZ |
|---|---|---|
| GET `/projects` | `handleListProjects` — no `user` | JWT only; full catalog |
| POST `/projects` | `handler.js` ~1068 | `isAdmin`; writes unused `members[]`; no `accessMode` |
| PATCH `/projects/{id}` | `handlePatchProject` | ACTIVE UserAccess ADMIN/SUPER_ADMIN (Stage 3F); name/client/description/status only |
| DELETE `/projects/{id}` | `handleDeleteProject` | ACTIVE UserAccess ADMIN/SUPER_ADMIN + name confirm; Cognito `isAdmin` is not sufficient; Project Admin not required |
| GET by id | — | **Does not exist** |
| `createdBy` / `lead` | stored on create | **Never used as ACL** |
| `members` | `body.members \|\| []` | **Unused** after write |

`accessMode` is **not** read or written today. Missing attribute in production is **Unknown**; code would not interpret it until implemented. **Safest compatibility:** treat missing `accessMode` as `OPEN` in new helpers (no migration).

### 1.4 Tasks and related routes (Verified)

All on ProjectsFunction `handler.js` unless noted.

| Route | Current authZ |
|---|---|
| GET `/tasks` | JWT; unscoped = all non-archived; `mine`/`assignee` optional filters |
| POST `/tasks` | Admin; `projectId` required; assignees ACTIVE (blocked check) |
| PUT `/tasks` | Admin **or** assignee; Admin may reassign |
| DELETE `/tasks` | Admin (archive) |
| GET `/tasks/{id}` | `canViewTask`: Admin **or** assignee |
| comments / activity / attachments | After `canViewTask` (or extra Admin/assignee on upload) |
| attachment-download-url | Admin or assignee or own profile prefix |
| POST/GET `/time-entries` | JWT; Admin may GET `?email=` |
| Task import upload/preview/confirm/history | Admin |
| Scheduled activation | EventBridge → `assignDueScheduledTasks` (no end-user JWT) |
| Escalation / Red email | Schedule; Admin emails from UserAccess |

`canViewTask` (`handler.js` 127–131): **any** Cognito Admin sees **any** task.

Employee UI uses `GET /tasks?mine=true` and `/work/:taskId` (**Verified** doc 14). That does not bind the unscoped list API.

### 1.5 DynamoDB (Verified)

WorkTasks: PK+SK only, **no GSI** (`template.yaml` WorkTasksTable). No `TransactWrite` usage in `backend/lambda` (search). Dual membership copies would be **new** TransactWrite or paired Puts.

Existing SK prefixes under `PROJECT#{id}`: `TASK#`. Under `USER#{email}`: leave, notify, `TIME#`. Proposed `MEMBER#` and `PROJECT_MEMBER#` do **not** collide (**Verified** prefixes).

Canonical identity: **lowercased email** (`getUser`, assignment SK `ASSIGNMENT#{email}`).

### 1.6 Frontend (Verified)

- `CreateProjectModal`: name, client, description; restriction/members **absent**.
- `ManageProjects`: list/filter/archive/delete; no member UI.
- `ManageTasks`: `fetchProjects()` + `fetchUsers()` + `selectableTaskAssignees` (ACTIVE only).
- `Work.jsx`: `mine=true`.
- No client-side project ACL.

### 1.7 Gaps vs this policy (Verified current vs required later)

| ID | Existing | Required (RESTRICTED) | OPEN / future |
|---|---|---|---|
| G1 | GET `/projects` any JWT | Filter by membership / Project Admin | **Must fix before prod ACL** if employees can call it; even OPEN should not dump to employees (**hardening**; currently catalog leak) |
| G2 | GET `/tasks` unscoped any JWT | Hide other projects’ restricted tasks; employee unscoped should not be org dump | Employee unscoped filter is **hardening for all modes**; required before prod |
| G3 | Admin sees all tasks (`canViewTask`) | Project Admin visibility `ASSIGNED_ONLY` \| `ALL_PROJECT_TASKS`; non-admin-member Admin 403 | OPEN: keep today’s Admin-global |
| G4 | Unused `members[]` | First-class MEMBER + PROJECT_ADMIN items | Do not treat array as ACL |
| G5 | Super Admin = other Admin | No bypass | OPEN unchanged |
| G6 | Import any Admin → any project name | Must be Project Admin of that project + assignees ∈ members | OPEN: keep current Admin import |
| G7 | Dashboard counts all projects | Optional later | Not a name leak |

**Must implement before production deployment of RESTRICTED:** G1 (at least Admin-only or filtered list), G2 (restricted filtering + employee unscoped), G3 on restricted tasks, G4 writes, G5, G6, assignment checks, comments/attachments/time-entries on restricted tasks.

**Optional future for OPEN:** stop employee GET `/projects`; force employee GET `/tasks` to assignee-only even when `mine` omitted.

---

## 2. Final ACL policy (approved business rules)

| Rule | Policy |
|---|---|
| Modes | `OPEN` \| `RESTRICTED` |
| Create default | Restriction **OFF** → persist `accessMode=OPEN` (or omit; readers treat missing as OPEN) |
| Missing `accessMode` | **OPEN**. No migration, no conversion UI in current scope |
| OPEN | Existing project/task workflow and existing backend Admin/assignee rules. No membership required. No restricted member validation |
| RESTRICTED | Backend only. Active **regular member** or **Project Admin**. Super Admin **no** automatic bypass |
| Super Admin | Must be explicit regular member and/or Project Admin |
| Project Admin vs member | Independent. Admin need not be a regular member. Removing regular membership keeps Project Admin. Member is not auto Admin |
| Project Admin eligibility | Active UserAccess **ADMIN** or **SUPER_ADMIN** (Q1 Managers). Never EMPLOYEE |
| Who manages Project Admins | Portal-admin access **and** (for RESTRICTED) an existing Project Admin, or **OPEN** any eligible portal Admin creating the first admin set — see §3.3 |
| Who manages regular members | Same portal-admin + Project Admin on RESTRICTED |
| Multiple Project Admins | Supported |
| Visibility | Per Project Admin: `ASSIGNED_ONLY` \| `ALL_PROJECT_TASKS`. Backend enforced |
| Restricted assignees | Active **regular** members only |
| Inactive users | No new assignment (already true for blocked newcomers on PUT/POST) |
| Documents | Out of scope |
| Scheduled tasks | Do not migrate existing; **new** activation on RESTRICTED must still validate membership at assign time (**Proposed**) |

**Creator:** **Proposed** (policy implies transfer of creator admin): on create, caller becomes a Project Admin with default visibility `ALL_PROJECT_TASKS`, not auto regular member. **Open Q2** if product wants creator also as regular member.

---

## 3. Data model proposal (not applied)

### 3.1 Project item (`ENTITY#PROJECT` / `PROJECT#{id}`)

Add optional `accessMode`: `OPEN` | `RESTRICTED`.  
Do not use legacy `members[]` as ACL. May still accept POST `members` as a hint to create MEMBER items later (**Proposed**).

### 3.2 Regular member

```
PK = PROJECT#{projectId}
SK = MEMBER#{normalizedEmail}
type = PROJECT_MEMBER
email, projectId, status = ACTIVE | REVOKED
addedAt, addedBy, updatedAt
```

User copy:

```
PK = USER#{normalizedEmail}
SK = PROJECT_MEMBER#{projectId}
type = PROJECT_MEMBER
(same status / timestamps / projectId)
```

Fits current table: unique PK+SK, Query `begins_with MEMBER#` vs `TASK#`.

### 3.3 Project Admin (separate)

```
PK = PROJECT#{projectId}
SK = PROJECT_ADMIN#{normalizedEmail}
type = PROJECT_ADMIN
email, projectId, status = ACTIVE | REVOKED
taskVisibility = ASSIGNED_ONLY | ALL_PROJECT_TASKS
addedAt, addedBy, updatedAt
```

User copy:

```
PK = USER#{normalizedEmail}
SK = PROJECT_ADMIN#{projectId}
```

`PROJECT_ADMIN#` vs `PROJECT_MEMBER#` on the user partition does not collide.

**Identity:** `escalation.normalizeEmail` / `getUser` lowercase. Cognito sub is **not** used on WorkTasks today (**Verified**).

### 3.4 Visibility

Stored only on **PROJECT_ADMIN** items (`taskVisibility`). Regular members have no visibility enum (employees see assigned work via existing assignee rules). Change via PATCH (Project Admin manager). Enforce in `canViewTask` / list filter.

### 3.5 Writes

**Proposed:** `TransactWriteItems` (2–4 items) when add/remove member or Project Admin so user-copy cannot diverge. Table already supports transactions; code does not use them yet (**Verified** none). Fallback: Put both + retry; document inconsistency window.

Condition: `attribute_not_exists(PK)` on create; `status <> REVOKED` as needed.

No new GSI. No new SAM table.

### 3.6 Evaluation helpers (Proposed module `projectAccess.js`)

- `projectAccessMode(project)` → OPEN if missing.
- `isRegularMember(ddb, projectId, email)`
- `getProjectAdmin(ddb, projectId, email)` → item or null
- `canManageRestrictedProject(user, project)` → Project Admin ACTIVE + portal ADMIN/SUPER_ADMIN (Q1)
- `canViewRestrictedProject(user, project)` → regular member OR Project Admin
- `taskVisibleTo(user, project, task)` → OPEN: today’s `canViewTask`; RESTRICTED: assignee (always if assignment exists) OR (Project Admin && ALL_PROJECT_TASKS) OR (Project Admin && ASSIGNED_ONLY && assignee)

Load UserAccess on mutations and RESTRICTED checks (ACTIVE + role).

---

## 4. API authorization matrix

Unauthorized: **403** `{ error: "Forbidden" }` unless noted. **401** if no email.

| Method | Endpoint | Actor | OPEN | RESTRICTED | Permission | Validation | Exposure if unchanged |
|---|---|---|---|---|---|---|---|
| GET | `/projects` | Any JWT | **Today: all projects.** **Prod ACL:** Cognito Admin sees all OPEN + own RESTRICTED; employee empty/403 | Only member or Project Admin | Portal Admin list + membership | status query | **High** catalog leak |
| POST | `/projects` | Cognito Admin | Create OPEN by default | If client sets RESTRICTED, write admins/members | `isAdmin` | name; optional members ACTIVE | — |
| PATCH | `/projects/{id}` | Cognito Admin | Any Admin (today) | Project Admin only | Mutate + member/admin lists | name unique; role eligibility | Non-member Admin edits |
| DELETE | `/projects/{id}` | ACTIVE UserAccess ADMIN or SUPER_ADMIN | Same | Same; Project Admin **not** required | Confirm name; 409 if tasks; DELETING retry same auth; missing project 404 (no OPEN fallback) | confirmName | — |
| GET | `/tasks` | Any JWT | **Today: all tasks.** **Hardening:** employees assignee-only | Drop tasks user cannot `taskVisibleTo` | List | mine/assignee | **High** |
| GET | `/tasks?projectId=` | Any JWT | All project tasks if JWT | Empty/403 if cannot view project | Project view | — | **High** |
| POST | `/tasks` | Admin | Today | Project Admin; assignees ∈ ACTIVE members | Create | projectId, blocked users | Assign outsiders |
| PUT | `/tasks` | Admin or assignee | Today | Assignee: own status; Admin: Project Admin; new assignees ∈ members | Update | BLOCKED | Reassign outsiders |
| DELETE | `/tasks` | Admin | Today | Project Admin | Archive | — | — |
| GET/POST | `/tasks/{id}` and comments/activity/attachments | `canViewTask` | Today Admin or assignee | `taskVisibleTo` | View/comment | — | Admin reads all |
| POST | download/upload attachment | Admin or assignee | Today | `taskVisibleTo` | — | s3 key | — |
| GET/POST | `/time-entries` | JWT / Admin | Today | Task must be `taskVisibleTo` | — | — | Time on hidden tasks |
| POST | `/task-imports/*` | Admin | Today | Each row project: Project Admin; assignees members | Import | parse | **Bypass** |
| GET | import history | Admin | Today | **Open Q3:** all imports vs only accessible projects | — | — | Batch metadata |
| Schedule | escalation / scheduled assign | System | Unchanged | Activation: skip if assignee not ACTIVE member (SKIPPED, existing skip pattern) | — | — | Assign inactive/outsider |
| GET | `/admin/dashboard` | Admin | Org counts | **Defer** | `isAdmin` | — | Counts only |
| * | `/documents/projects*` | Admin | Unchanged | Unchanged | Out of scope | — | Separate product |

No GET `/projects/{id}` today; **Proposed** defer or add later with same view rule.

---

## 5. Technical implementation plan (later stages — do not execute now)

### Helpers

`backend/lambda/projects/projectAccess.js` (+ tests): mode, member, Project Admin, visibility, UserAccess ACTIVE/role.

### Project access evaluation

Get project item; missing mode → OPEN; RESTRICTED → Get MEMBER and PROJECT_ADMIN keys (not scan).

### Task visibility

Replace `canViewTask` internals: if OPEN, keep current; if RESTRICTED, apply §3.6. List GET `/tasks` maps each task through the same function (batch Get project + admin item; cache per request).

### API changes

Filter GET `/projects` by caller. POST persist `accessMode` default OPEN; if RESTRICTED, TransactWrite creator PROJECT_ADMIN. PATCH accept `accessMode`, `membersAdd`/`membersRemove`, `projectAdminsAdd`/`Remove` with `taskVisibility`. Do not add SAM routes unless needed.

### Frontend (Stage 6)

`CreateProjectModal`: restriction toggle **default off**; when on, member multi-select + Project Admin multi-select (portal Admin/Super Admin only) + visibility per admin. `ManageProjects` edit same. `ManageTasks`: if selected project RESTRICTED, assignees from regular members only; hide projects user cannot see (API already filtered). `Work.jsx`: no toggle; server list/detail. Reuse Modal/theme; follow doc 14 (no employee `GET /admin/users`).

### Import / schedule

Preview/confirm: Project Admin on each `projectId`; row fail if assignee not member. `assignDueScheduledTasks`: membership check; SKIPPED if not member (do not rewrite historical scheduled rows).

### Notifications / dashboard

**Defer** recipient narrowing and dashboard count changes unless D11-style leak is accepted as must-fix. **Open Q4:** Red/completion emails to all portal Admins leak restricted titles.

### Errors

403 Forbidden; 400 invalid assignee; 409 name conflict unchanged.

### Rollback

Feature is additive attributes/items. Rollback code treats unknown types as ignore; missing mode OPEN. Removing helpers restores old `canViewTask` (Admin sees all).

### Tests (required)

See §6.

---

## 6. Test plan (future)

| Case | Expect |
|---|---|
| OPEN missing `accessMode` | Treated OPEN; Admin mutate; no member required |
| OPEN new explicit | Same as today for Admin/assignee |
| RESTRICTED non-member Admin | 403 list item, PATCH, DELETE, GET task (unless assignee Q/D10 — policy: assignee must be member so no outsider assignee) |
| RESTRICTED Super Admin not on project | **403** (no bypass) |
| Super Admin as Project Admin | Allowed |
| Super Admin as regular member only | View as member; not Project Admin powers |
| EMPLOYEE as Project Admin | 400 |
| MANAGER as Project Admin | 400 until Q1 yes |
| Inactive UserAccess | Cannot add member/admin; cannot new-assign |
| Regular member not Admin | No PATCH project; employee task if assigned |
| Project Admin not regular member | Can PATCH; ASSIGNED_ONLY sees only own assignments |
| Remove regular membership, keep Project Admin | Still Admin; cannot assign self as assignee unless re-added as member |
| Two Project Admins | Both manage members |
| Visibility ALL vs ASSIGNED_ONLY | List/detail differ |
| Restricted POST/PUT/import assign non-member | 400 |
| Unauthorized PATCH | 403 |
| Import + reassignment paths | Covered |
| Employee GET `/tasks` without mine | Must not return others’ restricted (and **should** not return others’ OPEN — hardening) |
| GET `/projects` employee | Not full catalog |
| Existing projects no new fields | OPEN compatibility |
| Frontend toggle default off | Create payload OPEN |

---

## 7. Frontend impact summary

| File | Later change |
|---|---|
| `CreateProjectModal.jsx` | Toggle default OFF; members; Project Admins + visibility |
| `ManageProjects.jsx` | Edit ACL fields; 403 message |
| `ManageTasks.jsx` | Filtered projects; member-only assignees |
| `api.js` | `accessMode`, member/admin arrays |
| `Work.jsx` / TaskDetails | Rely on 403; no admin directory on `/work` (doc 14) |

---

## 8. Backend impact summary

MVP: `handler.js`, `projectManage.js`, new `projectAccess.js`, `taskImportConfirm.js` / parse, scheduled assign, tests.  
Defer: `redAdminNotify` / completion recipients, `activity/handler.js` counts, documents, `template.yaml` GSI.

---

## 9. Recommended later stages

1. Helpers + item shapes + unit tests (no HTTP change).  
2. GET `/projects` + GET `/tasks` filtering (close G1/G2 for RESTRICTED + employee catalog).  
3. POST/PATCH membership and Project Admins + visibility.  
4. Task GET/PUT/POST/comments/attachments/time-entries `taskVisibleTo`.  
5. Import + scheduled assign.  
6. Frontend.  
7. Full test matrix §6.  
8. Docs 05/06/07; Q4 notify; deploy on `dev` only after review (`dev` = production).

---

## 10. Unresolved questions

| ID | Question | Suggested default |
|---|---|---|
| Q1 | Can MANAGER be Project Admin? | **No** (ADMIN/SUPER_ADMIN only) |
| Q2 | Is creator auto regular member? | **No**; creator is Project Admin only |
| Q3 | Import history visible for restricted batches to non-member Admins? | Hide or 403 detail |
| Q4 | Restrict SES/in-app admin fan-out for restricted tasks? | Defer; accept leak until Stage 8 |
| Q5 | First Project Admin on new RESTRICTED: must caller be eligible Admin? | Yes; POST already `isAdmin` |

---

## 11. Confirmation

This stage **did not** modify application source, frontend behavior, DynamoDB data, SAM/AWS, or workflows. Only architecture markdown and the pack index.
