# 13 — Project-Level Access Control: technical design

**Superseded for implementation:** Use [15-project-acl-stage1-plan.md](./15-project-acl-stage1-plan.md). Phase 2 assumed Super Admin bypass and default RESTRICTED; Stage 1 business policy does not.

**Phase:** 2 (planning / design only)  
**Date:** 21 September 2026  
**Status:** Phase 2 draft. **Not live behavior.** Catalog DELETE now uses `deletionLockId` / `deletionLockAt` and task create uses a TransactWrite ConditionCheck on the catalog item.  
**Companion:** [12-project-acl-requirements.md](./12-project-acl-requirements.md)

Do not treat this document as live behavior.

---

## 1. Membership data model

### 1.1 Existing DynamoDB (Verified)

- Work projects live on **WorkTasks** (`WORK_TABLE`): `PK=ENTITY#PROJECT`, `SK=PROJECT#{projectId}`.
- No WorkTasks GSI. No membership table. No FK constraints.
- `PROJECT#{projectId}` + `SK=TASK#{taskId}` already holds **task copies**.
- `USER#{email}` already holds leave copies, notifications, `TIME#` entries.
- Create writes unused `members: body.members || []`. PATCH does not update `members` or `lead`.
- **Do not** invent a new SAM table for MVP.

### 1.2 Proposed source of truth

**Not** the legacy `members` array.

**Proposed items on the same WorkTasks table:**

| Purpose | PK | SK | `type` | Notes |
|---|---|---|---|---|
| Membership | `PROJECT#{projectId}` | `MEMBER#{email}` | `PROJECT_MEMBER` | Coexists with `TASK#` under same PK; Query `begins_with(SK, MEMBER#)` |
| User → projects | `USER#{email}` | `PROJECT_MEMBER#{projectId}` | `PROJECT_MEMBER` | Query `begins_with(SK, PROJECT_MEMBER#)`; no collision with `TIME#`, `LEAVE#`, `NOTIFY#` (**Verified** prefixes) |

**Proposed attributes on membership item:** `projectId`, `email`, `status` (`ACTIVE` \| `REVOKED`), `addedAt`, `addedBy`, `updatedAt`. No project-specific role in MVP (doc 12).

**Proposed attributes on project item (ENTITY#PROJECT):** `accessMode` (`OPEN` \| `RESTRICTED`). Missing `accessMode` = OPEN for legacy (**D3**).

Keep writing `createdBy` / `lead` as today. They are **not** ACL unless a migration uses them as backfill (**Proposed**).

### 1.3 Operations (Proposed)

| Need | Access pattern |
|---|---|
| Access check | GetItem project (mode) + GetItem `PROJECT#id` / `MEMBER#email` or Super Admin D1 |
| List members | Query `PK=PROJECT#id`, `begins_with MEMBER#`, filter `ACTIVE` |
| List my projects | Query `PK=USER#email`, `begins_with PROJECT_MEMBER#`, then Get/BatchGet project items; Admins also see OPEN via existing `ENTITY#PROJECT` query filtered in process |
| Add member | Put both items; `status=ACTIVE`; condition unique SK |
| Revoke | Set both copies `REVOKED` (keep row for audit) or Delete both; **Proposed:** REVOKED keep |
| Integrity | Same overlay/condition style as task persist where races matter; uniqueness = PK+SK |

**Scalability:** Member counts are expected small (tens–low hundreds). OPEN list still queries all `ENTITY#PROJECT` for Admins (**Verified** current list). Filtering RESTRICTED in memory after Query is acceptable until project count is large (**Inferred**).

### 1.4 Rejected for MVP

- New `Users` table usage (unused **Verified**).
- GSI (would be SAM change; only if “all restricted projects” listing is too slow).
- Treating create-only `members[]` as ACL (**Verified** unused).

---

## 2. API authorization matrix

AuthN for all: existing Cognito authorizer (**Verified**). Missing JWT email: keep 401 where handlers already do.

Unauthorized authenticated user: **Proposed** 403 `{ error: "Forbidden" }` (**D9**).

`canAccessProject(user, project)` **Proposed:**

1. No project → 404 (existing delete/patch).
2. `accessMode` missing or `OPEN` → Cognito Admin for mutate; **list:** see Tightening GET `/projects` below.
3. `RESTRICTED` → Super Admin if D1, else ACTIVE membership item.
4. UserAccess not ACTIVE → deny (except perhaps in-flight assignee D10).

### 2.1 GET `/projects`

| | |
|---|---|
| **Current (Verified)** | JWT; returns all projects for `status` filter; no `isAdmin` |
| **Proposed AuthZ** | Cognito Admin **or** D7 employee members. Filter: OPEN (Admins) ∪ RESTRICTED where member (∪ Super Admin all if D1) |
| **Queries** | `ENTITY#PROJECT` Query **or** member user-copy Query then Gets |
| **Compat** | Employee clients calling GET `/projects` today would lose the full catalog (**breaking**, required for F1) |
| **Tests** | Employee 403/empty; non-member Admin omits restricted; member Admin includes |

### 2.2 POST `/projects`

| | |
|---|---|
| **Current** | Cognito Admin; writes `members` unused |
| **Proposed** | Cognito Admin (D4). Default `accessMode=RESTRICTED` (D6). Put project + membership for creator + each ACTIVE requested member |
| **Tests** | Non-admin 403; creator MEMBER item exists; inactive user rejected |

### 2.3 PATCH `/projects/{projectId}`

| | |
|---|---|
| **Current** | Admin; name/client/description/status only |
| **Proposed** | `canAccessProject` for mutate. Add optional `accessMode`, `membersAdd` / `membersRemove` **or** replace `members` emails. **Proposed new body fields** (not new SAM paths) |
| **Compat** | Existing archive/restore bodies still work |
| **Tests** | Non-member 403 on restricted; add/remove member; cannot add BLOCKED |

### 2.4 DELETE `/projects/{id}`

| | |
|---|---|
| **Current (Stage 3E)** | Authenticate; normalize caller email; load UserAccess; require **ACTIVE ADMIN or SUPER_ADMIN**. Cognito `isAdmin` is **not** sufficient. Project Admin and regular membership are **not** required. Same rule for OPEN and RESTRICTED. Name confirmation required. Load project-side copies and canonical tasks; lookup failure **500** with no mutation; any task **409 `PROJECT_HAS_TASKS`** with no mutation. Empty project: tombstone → dual ACL cleanup → verify → catalog delete. **DELETING** retries use the same authorization and name confirmation. Missing project **404** (no OPEN fallback, no ACL repair). Cleanup failure **500**. Orphan repair is operational, not part of DELETE. |
| **Tests** | ADMIN/SUPER_ADMIN empty OPEN/RESTRICTED; non-PA ADMIN/SUPER_ADMIN on RESTRICTED; Cognito admin without/inactive/PENDING/BLOCKED UserAccess 403; MANAGER/EMPLOYEE 403; lookup 500; client role/status ignored; 409 leaves state unchanged; DELETING retry auth + confirm |

### 2.5 GET `/projects/{id}`

| | |
|---|---|
| **Current (Verified)** | **Does not exist** |
| **Proposed MVP** | **Defer.** Clients use filtered list. Optional later GET with same `canAccessProject` |

### 2.6 GET `/tasks`

| | |
|---|---|
| **Current** | JWT; optional `projectId` / `mine` / `assignee`; unscoped = all tasks |
| **Proposed** | After load, drop tasks whose project is RESTRICTED and `!canAccessProject` and `!(D10 assignee)`. `mine=true`: still assignee filter **then** same rule (assigned restricted tasks remain for the assignee) |
| **Compat** | Admin task board without `mine` no longer shows other teams’ restricted work |
| **Tests** | Unscoped employee ≠ org dump; `projectId` restricted 403 or empty for non-member |

### 2.7 GET `/tasks/{id}`, comments, attachments, download

| | |
|---|---|
| **Current** | Admin **or** `taskAssignedTo` |
| **Proposed** | Keep assignee access (D10). Admin access **only if** `canAccessProject` or OPEN. Non-member Admin 403 on restricted even if `isAdmin` |
| **Tests** | Non-member Admin 403; assignee 200; member Admin 200 |

### 2.8 PUT `/tasks` (status/assignees)

| | |
|---|---|
| **Current** | Admin or assignee; Admin may add assignees; BLOCKED newcomers rejected |
| **Proposed** | Same plus `canAccessProject` for Admin paths. New assignees on RESTRICTED must be members (D8) |
| **Tests** | Assign outsider 400; member Admin can assign member |

### 2.9 POST `/tasks`

| | |
|---|---|
| **Current** | Admin; `projectId` required |
| **Proposed** | Admin + `canAccessProject`; assignees ⊂ members if RESTRICTED |
| **Tests** | Task on restricted without membership 403 |

### 2.10 Task import (`/task-imports*`)

| | |
|---|---|
| **Current** | Admin; rows resolve `projectId` by name (`taskImportParse.js`) |
| **Proposed** | Preview/confirm: each row’s project must be OPEN or member-accessible. Fail row or batch if not (prefer row-level PARTIAL, existing import statuses) |
| **MVP** | Required for restricted projects or import becomes an ACL bypass |
| **Tests** | Import into restricted project as non-member does not create tasks |

### 2.11 Time entries GET/POST

| | |
|---|---|
| **Current** | JWT; POST any `taskId`; Admin GET others’ email |
| **Proposed** | Resolve task → `canAccessProject` or assignee D10 |
| **MVP** | Yes if time entries expose titles/projectId (**Verified** they store `projectId`) |

### 2.12 Notifications / Red / completion email

| | |
|---|---|
| **Current** | Assignee + portal Admin/Super Admin emails; not project-scoped |
| **Proposed MVP** | **Defer** changing recipient sets (**risk:** leaking restricted titles to all Admins via email). Flag as Stage 8 / D11 |
| **D11 Needs approval** | Restrict admin emails to project member Admins + Super Admin |

### 2.13 GET `/admin/dashboard`

| | |
|---|---|
| **Current** | Admin; `totalProjects` / tasks are **org-wide** counts |
| **Proposed MVP** | **Defer** (counts remain global) **or** count only accessible projects |
| **Risk** | Counts reveal how many restricted projects exist, not their names |

---

## 3. Task access policy (Proposed)

**Verified:** POST `/tasks` requires `projectId`. A task without a project cannot be created through that API. Historical items with empty `projectId` are **Unknown**.

**Proposed policy (defaults; D2/D8/D10):**

1. Project membership **does not** automatically grant employees every task in the project (D2 assigned-only).
2. Cognito Admin **members** (and Super Admin if D1) may list/manage **all** tasks in that project (admin operations).
3. Assignees may access **their** assignment even if not members (D10), to avoid breaking current My Tasks.
4. New assignments on RESTRICTED projects must be members (D8).
5. OPEN projects: keep current Admin-global task visibility **except** GET `/tasks` unscoped should still not be an employee catalog (F2 fix applies to all modes).

**Employee GET `/tasks` unscoped:** **Proposed** always apply assignee filter (`mine` semantics) even if client omits `mine`. That closes F2 regardless of project mode.

---

## 4. Legacy and empty `members`

**Verified:** `members` is unused; production values **Unknown**.

Do **not** enable ACL from that array without migration.

### Approach A — `accessMode` OPEN default (recommended default)

- Missing `accessMode` ⇒ OPEN.
- OPEN: Admins keep global mutate; GET `/projects` still **Admin-only** (fixes F1) but lists all OPEN + permitted RESTRICTED.
- New creates: RESTRICTED (D6) + membership items.
- **Pros:** No lockout; no Dynamo backfill required to ship.  
- **Cons:** Sensitive old projects stay visible to every Admin until someone sets RESTRICTED. Unrestricted Admin access continues for OPEN indefinitely unless ops convert them.

### Approach B — Backfill RESTRICTED from `createdBy` / `lead`

- Script (future, not run now): for each project, set RESTRICTED; MEMBER for `createdBy`, `lead`, and unique `members[]` emails that are ACTIVE.
- **Pros:** Faster confidentiality.  
- **Cons:** Wrong `lead`, departed users, empty `createdBy` ⇒ lockout; **Unknown** data quality. Needs Super Admin D1.

**Recommendation:** Ship **A**. Optionally later B as a reviewed one-off. Convert high-sensitivity projects in UI (PATCH `accessMode` + members) without a global script.

If create payload includes `members` today, **Proposed:** ignore for ACL on old items; on new POST, materialize membership items from that array **in addition to** creator.

---

## 5. Frontend integration plan (not implemented)

**Verified UI:** `CreateProjectModal` name/client/description; `ManageProjects` + `ManageTasks` share it; assignees via `fetchUsers` + `selectableTaskAssignees`; `Work.jsx` uses `mine=true`.

**Proposed:**

| Screen | Change |
|---|---|
| `CreateProjectModal` | Optional access mode toggle; multi-select ACTIVE users (copy ManageTasks assignee UX); show creator as locked member |
| `ManageProjects` | Pass `accessMode` / members into create/edit; hide actions on 403; keep archive/delete confirm |
| `ManageTasks` | Project dropdown from filtered GET `/projects`; assignees filtered to members when restricted |
| `Work.jsx` | No membership UI; relies on API `mine` + server filter |
| `api.js` | Send `accessMode`, `members` on create/PATCH |
| Unauthorized | Existing `err.message` in page error state; 403 on list → empty + message |
| Theme | Reuse `formInput`, `formLabel`, `Modal` |

Do not add a new design system.

---

## 6. Security and validation plan

**Proposed model:** JWT + Cognito Admin for create + `accessMode` + ACTIVE `PROJECT_MEMBER` + optional Super Admin bypass.

**Revocation:** REVOKED member fails `canAccessProject` on next request.

**Logging:** Existing `appendActivity` on tasks; **Proposed:** activity line on member add/remove (`Needs approval` if new audit surface). ComingSoon `/admin/audit-logs` is **not** a real API (**Verified** gap).

**Validation tests (future Stage 7):**

- Unit: `canAccessProject` OPEN/RESTRICTED/revoked/Super Admin.
- Handler: F1/F2 closed; import bypass closed; PATCH members.
- Frontend: modal sends members; ManageTasks assignee filter.
- No production pentest in this phase.

---

## 7. Architecture impact

| Module | Why | Existing | Proposed | Risk | MVP |
|---|---|---|---|---|---|
| `handler.js` | All HTTP gates | Admin/assignee | Call shared helper | High if missed route | Yes |
| `projectManage.js` | List/patch/delete | List unauthenticated-as-admin | Filter + member writes | List perf | Yes |
| New `projectAccess.js` (proposed helper) | Single policy | None | New file | Cycle with handler | Yes |
| `CreateProjectModal.jsx` | Member UX | 3 fields | Picker | Duplicate assignee UX | Yes |
| `ManageProjects.jsx` | Edit members | CRUD | Mode + members | 403 UX | Yes |
| `ManageTasks.jsx` | Project/assignee | All ACTIVE users | Restrict assignees | Admins confused | Yes |
| `api.js` | Payloads | name/client/desc | Extra fields | Old clients | Yes |
| `Work.jsx` | Employee tasks | `mine=true` | Server-side unscoped fix | Little UI | Server yes / UI defer |
| `taskImport*.js` | Bypass | Admin + name match | Project access per row | Partial imports | Yes |
| `escalation` / notify | Email leak | All Admins | D11 | Confidential titles | **Defer** (D11) |
| `activity/handler.js` | Counts | Org-wide | Optional filter | Dashboard numbers | **Defer** |
| `documents/projectsLogic.js` | Wrong product | Admin S3 | **No change** | Scope creep | **Exclude** |
| `template.yaml` | New table/GSI | None needed | **No change** if helper-only | Accidental table | **No** unless GSI later |
| Tests listed in audit §8 | Regressions | Project manage / tasks | New cases | False confidence | Yes |

---

## 8. Proposed implementation stages (do not execute now)

| Stage | Work | Exit |
|---|---|---|
| **1** | `accessMode` + MEMBER item helpers; no handler behavior change except feature-flag off **or** write-only on create | Items documented; unit tests for keys |
| **2** | `projectAccess.js`: `canAccessProject`, list filter, ACTIVE UserAccess | Pure tests |
| **3** | GET `/projects` Admin + filter; unscoped GET `/tasks` employee=assignee-only; restricted drop | F1/F2 tests red→green |
| **4** | POST membership materialize; PATCH add/remove/`accessMode`; delete/archive checks | Member CRUD tests |
| **5** | Task GET/PUT/POST/import/time-entries | No Admin bypass of restricted |
| **6** | CreateProjectModal + ManageProjects + ManageTasks + api.js | UX + 403 messages |
| **7** | Full backend `npm test` + frontend project/task tests + authorization cases | CI green |
| **8** | Docs 05/06/07 updates; D11 notify/dashboard; deploy readiness on `dev` | Sign-off |

Each stage should be a reviewable PR. Push to `dev` deploys production (**Verified** workflow).

---

## 9. Ready for implementation approval?

**Yes, pending business decisions D1–D11** (especially D1, D2, D3, D6).

Technical approach is compatible with the existing WorkTasks single-table design and does not require a new table or Document Projects.

**Unknown:** production `members` contents; volume of projects; whether any tasks lack `projectId`.
