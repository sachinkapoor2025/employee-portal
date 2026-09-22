# 11 — Phase 1 audit: Project-Level Access Control

**Date:** 21 September 2026  
**Mode:** Historical read-only source audit from Phase 1. It describes the **pre-ACL** codebase.  
**Live authorization:** OPEN/RESTRICTED WorkTasks ACL, UserAccess ADMIN/SUPER_ADMIN catalog mutate, deletion locks, and import view gates are implemented in later stages. Treat findings below as **historical** unless re-verified against current handlers. Document-project and leave-management authorization were **not** changed by project ACL work.

**Sources of truth:** `backend/template.yaml`, `backend/lambda/**`, `frontend/src/**`. Narrative files (`PROJECT-OVERVIEW.md`) used only when they match source.

**Confidence labels:** **Verified** (observed in source) · **Inferred** (reasonable from source, not proven in production) · **Unknown** (not in repo).

---

## 1. Executive summary

**Historical (Phase 1):** Project-level access control did not exist as an authorization model. Work projects were org-wide records. Any Cognito `Admin` group member can create, list (via the admin UI), mutate, and delete any work project. Any authenticated JWT caller can **list every project** and **list every non-archived task** unless they pass `mine`/`assignee` filters. Employees are restricted on **task detail/update** to assignees, not to project membership.

A `members` array is written on **create** (`handler.js`) and is **never used** for authorization, listing, or the create/edit UI. PATCH does not update `members` or `lead`. There is no membership table, no GSI for project members, and no GET `/projects/{id}`.

**Document “projects”** (`/documents/projects*`) are a **separate** S3-manifest product. They are not WorkTasks `ENTITY#PROJECT` records. Do not conflate them with this feature.

The system is **ready for implementation planning**, not for a drop-in feature. The MVP must add **backend enforcement** first; UI filtering alone would be insecure because list APIs already return full catalogs.

---

## 2. Verified current architecture

### 2.1 Repository

| Area | Location | Verified |
|---|---|---|
| Frontend | CRA React 19, `frontend/src/index.js` → `App.jsx` | Yes |
| Backend | AWS SAM, `backend/template.yaml`, Lambdas under `backend/lambda/` | Yes |
| Auth | Cognito Hosted UI; API Gateway Cognito authorizer; `getUser` | Yes |
| Data | DynamoDB PK/SK tables; no SQL migrations | Yes |
| Deploy | `.github/workflows/main.yml` push `dev`/`main`/`feature/*` → stack `mydgv-portal` `ap-south-1` | Yes |
| Tests | Backend: Node `assert` scripts in `backend/package.json`. Frontend: Jest via `react-scripts test` | Yes |

Env: names only (`WORK_TABLE`, `USER_ACCESS_TABLE`, `REACT_APP_*`). Values and secrets are not listed here.

### 2.2 Work vs document projects

| Kind | Storage | UI | Auth today |
|---|---|---|---|
| Work project | WorkTasks `PK=ENTITY#PROJECT` | `/admin/projects`, task create | Cognito Admin for mutate; JWT-only GET list |
| Document project | S3 manifests | Documents browsers | Cognito Admin (`projectsLogic.adminDenied`) |

**Finding:** Two different “project” concepts.  
**Evidence:** `handler.js` POST `/projects`; `documents/projectsLogic.js` `adminDenied`.  
**Confidence:** Verified.  
**Impact:** Membership on work projects will not automatically cover document folders.  
**Next:** Scope MVP to WorkTasks projects unless product explicitly includes documents.

---

## 3. Existing roles and authorization

### 3.1 Identity (Verified)

`backend/lambda/common/auth.js` `getUser`:

- Email from JWT claims.
- `isAdmin` = Cognito group **`Admin`** (not UserAccess.role).
- Domain `@mydgv.com` (`isAllowedEmail`, PreSignUp).

No server session store. SPA stores ID token in `localStorage` (`frontend/src/services/auth.js`).

### 3.2 Portal roles (Verified)

`backend/lambda/common/roles.js`:

| UserAccess.role | Cognito group | Admin SPA (`accessGateForRole`) |
|---|---|---|
| SUPER_ADMIN | Admin | ADMIN |
| ADMIN | Admin | ADMIN |
| MANAGER | Admin | ADMIN |
| EMPLOYEE | Employee | USER |

Lifecycle (activate/block/delete): **Super Admin only** (`canManageUserAccessLifecycle`).  
Role assignment of SUPER_ADMIN: Super Admin only (`canAssignPortalRole`).  
Statuses: `ACTIVE`, `PENDING`, `BLOCKED` (`access/handler.js`).

**Finding:** Project APIs do **not** distinguish SUPER_ADMIN vs ADMIN vs MANAGER. All three are `user.isAdmin === true` if they have the Cognito Admin group.  
**Evidence:** `handler.js` POST `/projects` `if (!user.isAdmin)`; `projectManage.handlePatchProject` / `handleDeleteProject`.  
**Confidence:** Verified.  
**Impact:** Product “authorized administrator” must be defined as Cognito Admin, UserAccess role, or a new permission.  
**Next:** Decide MVP actor set before coding.

### 3.3 Frontend gate (Verified)

`App.jsx` `RequireAuth` `adminOnly` requires localStorage view role `ADMIN`. That is **not** API authorization. Employee view cannot open `/admin/projects`; an Admin-group JWT in employee view still has Admin APIs if called directly.

---

## 4. Existing project and task architecture

### 4.1 Project APIs (Verified)

Wired on ProjectsFunction (`docs/architecture/06-api-catalog.md` + `handler.js`):

| Method | Path | Handler | AuthZ |
|---|---|---|---|
| GET | `/projects` | `handleListProjects` | JWT only — **no `isAdmin`** |
| POST | `/projects` | inline in `handler.js` | `user.isAdmin` |
| PATCH | `/projects/{projectId}` | `handlePatchProject` | `user.isAdmin` |
| DELETE | `/projects/{projectId}` | `handleDeleteProject` | **Stage 3E:** ACTIVE UserAccess ADMIN or SUPER_ADMIN. Cognito `isAdmin` is not sufficient. Project Admin membership is not required. Same for OPEN and RESTRICTED. |

No GET-by-id. List queries `PK = ENTITY#PROJECT` and filters status (`ACTIVE` default, `ARCHIVED`, `ALL`).

**Create item attributes** (`handler.js` ~1067–1079): `projectId`, `name`, `client`, `lead` (default caller email), `members` (`body.members \|\| []`), `status`, `description`, `createdAt`, `createdBy`.

**PATCH fields** (`handlePatchProject`): `name`, `client`, `description`, `status` (ACTIVE/ARCHIVED). **Not** `members`, **not** `lead`.

**Delete:** ACTIVE UserAccess ADMIN or SUPER_ADMIN; name confirmation; 409 `PROJECT_HAS_TASKS` before any mutation if copies or matching canonical tasks exist; empty tombstone then ACL cleanup then catalog delete. **DELETING** retries use the same authorization. Missing project 404 (no OPEN fallback). Archive is PATCH status. Cognito `isAdmin` alone is not sufficient. Project Admin membership is not required. Orphan ACL repair is a separate operational concern.

**Ownership:** `createdBy` / `lead` stored; **never checked** on list/update/delete.

### 4.2 Membership (Verified)

`members` appears in:

- Write: `handler.js` create only.
- Test seed: `projectManage.test.js` empty array.
- **Not** in `CreateProjectModal`, `ManageProjects`, or PATCH.

**Finding:** No project membership or project permission model. `members` is unused storage.  
**Confidence:** Verified.  
**Impact:** MVP cannot “enable” an existing ACL; it must introduce one.  
**Next:** Define member item shape (array on project vs `PROJECT#{id}` / `MEMBER#{email}` items).

### 4.3 Tasks (Verified)

- Canonical `ENTITY#TASK` / `TASK#{id}` plus copy `PROJECT#{projectId}` / `TASK#{id}`.
- Assignments `TASK#{id}` / `ASSIGNMENT#{email}` with own status/zone.
- Create/archive: Admin.
- GET `/tasks`: any JWT; optional `projectId`, `mine`, `assignee`. **Without `mine`/`assignee`, returns all non-archived tasks.**
- GET `/tasks/{id}`, comments, attachments, PUT status: Admin **or** assignee (`taskAssignedTo`).
- Excel import: Admin. Assignees are **task** assignees, not project members.

Employee UI (`Work.jsx`) uses `fetchTaskList({ mine: "true" })`. That is **client convention**, not enforcement of project scope.

### 4.4 Frontend (Verified)

| Surface | File | Behavior |
|---|---|---|
| Project list/CRUD | `ManageProjects.jsx` `/admin/projects` | Status filter, create/edit modal, archive/restore/delete with name confirm |
| Create/edit form | `CreateProjectModal.jsx` | Fields: **name, client, description** only |
| Task create | `ManageTasks.jsx` | Can open same modal, then `createTask` with `projectId` + multi-assignee from `fetchUsers()` filtered `ACTIVE` (`selectableTaskAssignees`) |
| My Tasks | `Work.jsx` | Assigned tasks only (query param) |
| Design | `theme.js`, `components/ui/Modal.jsx` | Shared formInput/formLabel/Modal |

Project creation is **not** required to live inside task create; both pages share the modal.

---

## 5. Existing database structure

**Technology:** DynamoDB, no migration files, no foreign keys, no GSI on WorkTasks.

**Users:** UserAccess (`PK=email`, `SK=email`, `role`, `status`); UserProfile (`USER#{email}` / `PROFILE`). SAM `UsersTable` has **no Lambda consumers** (`05-data-architecture.md`).

**Projects:** items on WorkTasks as above. Not a separate table.

**Tasks / assignments:** WorkTasks keys in §4.3.

**Membership table:** **None.**

**Indexes for project access:** **None.** Listing members would be a scan of `members` on each project item or a new item collection.

**Live table contents:** **Unknown** (not dumped). Some production projects may have empty `members` or omitted attribute.

---

## 6. Current project access behavior

| Action | Who can (Verified) |
|---|---|
| List all work projects | Any JWT (API). Admin SPA is the only UI. |
| Create project | Cognito Admin |
| Edit name/client/description/status | Any Cognito Admin, any project |
| Delete/archive | Any Cognito Admin, any project (with confirm) |
| See all tasks in a project | Any JWT calling `GET /tasks?projectId=` |
| See all tasks org-wide | Any JWT `GET /tasks` |
| Open task details | Admin or assignee |
| Assign people to a **task** | Admin; ACTIVE users only (`blockedNewAssignees`) |
| Assign people to a **project** | UI: no. API create: optional unused `members` |
| Document folder projects | Cognito Admin writes; not WorkTasks membership |

---

## 7. Security findings

### F1 — GET `/projects` is not Admin-gated

- **Finding:** `handleListProjects` takes no `user`. Handler GET `/projects` does not check `isAdmin`.
- **Evidence:** `projectManage.js` 389–398; `handler.js` 1055–1061.
- **Confidence:** Verified.
- **Impact:** Any authenticated employee can retrieve all project names, clients, leads, members, descriptions, createdBy.
- **Next:** Require Admin **or** membership for list; never rely on hiding `/admin/projects`.

### F2 — GET `/tasks` is a full catalog without `mine`

- **Finding:** Unfiltered list returns all non-archived tasks.
- **Evidence:** `handler.js` 1123–1198.
- **Confidence:** Verified.
- **Impact:** Project ACL on create UI is useless if employees can list every task.
- **Next:** Default employee list to assignee-only; Admin list still too wide for project ACL unless filtered by membership.

### F3 — Admin is global, not per-project

- **Finding:** Any Admin mutates any project.
- **Evidence:** PATCH/DELETE `user.isAdmin` only.
- **Confidence:** Verified.
- **Impact:** “Sensitive project” cannot be hidden from other Admins/Managers today.
- **Next:** Explicit product rule: Super Admin override vs member-only Admins.

### F4 — `members` is not an ACL

- **Finding:** Stored on create, unused, not patchable, not in UI.
- **Evidence:** `handler.js` 1074; `handlePatchProject` field list; `CreateProjectModal.jsx` EMPTY_FORM.
- **Confidence:** Verified.
- **Impact:** Do not treat existing `members` as granted access.
- **Next:** New write path + enforcement; migrate empty arrays.

### F5 — Documents vs work projects

- **Finding:** Document projects are Admin-only S3 trees, independent of work `projectId`.
- **Evidence:** `documents/projectsLogic.js` `adminDenied`.
- **Confidence:** Verified.
- **Impact:** Files under Documents ≠ work-project confidentiality.
- **Next:** Separate epic unless IDs are unified (they are not today).

### F6 — JWT vs UserAccess

- **Finding:** Blocked users: GET `/access` BLOCKED, but Lambdas generally trust JWT `isAdmin`/`email` unless they call UserAccess (task assign blocked check does).
- **Evidence:** `assignee` blocked check in `handler.js`; most project routes do not re-read UserAccess.
- **Confidence:** Verified for assign; **Inferred** that blocked Admins with a live JWT can still call project APIs until token expires.
- **Impact:** Membership should re-check ACTIVE status.
- **Next:** Reuse `loadUserAccessStatus` / UserAccess Get on member mutations and access checks.

No production penetration testing was performed.

---

## 8. Affected modules (implementation planning)

| Module | Why |
|---|---|
| `backend/lambda/projects/handler.js` | Create/list/tasks/comments/attachments; add membership checks |
| `backend/lambda/projects/projectManage.js` | PATCH members/lead; list filter; delete still Admin/super? |
| `backend/template.yaml` | Possible GSI or env; unlikely new table if single-table |
| `frontend/.../CreateProjectModal.jsx` | Member picker |
| `frontend/.../ManageProjects.jsx` | Pass members; edit membership |
| `frontend/.../ManageTasks.jsx` | Project dropdown + assignees subset of members |
| `frontend/src/services/api.js` | Payload fields |
| `frontend/src/utils/taskStatus.js` | Assignee filter |
| `backend/lambda/projects/taskImport*.js` | Import into a project should respect members |
| `backend/lambda/projects/escalation.js` + notify | Recipients today are assignees + portal Admins, not project members |
| `backend/lambda/activity/handler.js` | Dashboard project counts (`countActiveProjects`) |
| `backend/lambda/documents/*` | Only if MVP includes document trees (**recommend exclude**) |
| Tests | `projectManage.test.js`, `ManageProjects.test.jsx`, `CreateProjectModal.test.jsx`, `ManageTasks.test.jsx`, handler/import tests |

**Backward compatibility:** Existing projects have no members. Options: treat empty `members` as “legacy open to all Admins” vs “open to all Admins + all employees” vs require backfill. Empty-array meaning must be explicit or all historical projects become invisible.

**Frontend vs backend:** UI-only filtering is **not** sufficient (F1, F2).

**Performance:** Membership-as-array on project item is fine for small teams; querying “projects for user X” needs either scan/filter or `USER#{email}` / `PROJECT#{id}` copies plus Query. WorkTasks has **no GSI**.

---

## 9. Unknowns and information gaps

| Item | Why unknown |
|---|---|
| Production `members` contents | No Dynamo dump |
| Whether product wants Managers excluded from global Admin project power | Not in code |
| Whether Super Admin must see all projects | Not specified |
| Whether employee members may open `/admin/projects` or only `/work` filtered by project | Product |
| SES/Cognito live config | Outside this audit |
| Exact count of projects/tasks in prod | Not in repo |

---

## 10. Recommendations for Project-Level Access Control MVP

1. **Define actors:** e.g. Super Admin always; other Admins/Managers/Employees only if on the member list (ACTIVE UserAccess).
2. **Enforce on the API first:** GET `/projects`, GET `/tasks` (including `?projectId=`), GET/PUT task, comments, attachments, import confirm, PATCH/DELETE project.
3. **Persist membership as first-class data:** either validated `members[]` + PATCH, or `PK=PROJECT#{id}`, `SK=MEMBER#{email}` with `roleOnProject`. Do not rely on unused create-only `members`.
4. **UI:** Extend `CreateProjectModal` with the same ACTIVE-user multi-select pattern as `ManageTasks` assignees (`fetchUsers` + `selectableTaskAssignees`). Keep Modal/theme conventions. Optionally restrict task assignees to project members.
5. **Legacy projects:** migration or documented default for missing/empty `members`.
6. **Keep document projects out of MVP** unless product unifies IDs.
7. **Tests:** employee JWT cannot list other projects/tasks; non-member Admin cannot PATCH another project; member employee can read allowed task; Super Admin override if required.
8. **Do not** implement in this phase (Phase 1 complete).

---

## Finding register (compact)

| ID | Finding | Evidence | Confidence | Impact | Next |
|---|---|---|---|---|---|
| F1 | GET `/projects` JWT-only | `handler.js` 1055–1061 | Verified | Data leak of all projects | AuthZ on list |
| F2 | GET `/tasks` unscoped | `handler.js` 1123–1198 | Verified | Data leak of all tasks | Scope lists |
| F3 | Admin is global | PATCH/DELETE `isAdmin` | Verified | No per-project Admin isolation | Membership + override policy |
| F4 | `members` unused | create vs modal vs PATCH | Verified | False sense of ACL | New model |
| F5 | Two “project” types | WorkTasks vs S3 docs | Verified | Wrong scope | MVP = work projects |
| F6 | Blocked JWT | assign checks UserAccess; project mutate does not | Verified / Inferred | Stale Admin tokens | ACTIVE check on access |
| F7 | PATCH ignores members/lead | `handlePatchProject` | Verified | Cannot update roster | PATCH members |
| F8 | No GET project by id | SAM + handler | Verified | Clients use list | Optional GET for members |
| F9 | No membership GSI | WorkTasks GSI none | Verified | “My projects” Query needs new keys | Design access pattern |
| F10 | UI has no member picker | `CreateProjectModal.jsx` | Verified | UX integration point | Extend modal |

---

## Inspection log

Inspected: `roles.js`, `auth.js`, `access/handler.js`, `admin/handler.js`, `projects/handler.js`, `projectManage.js`, `projectManage.test.js`, task import/notify paths (Admin-only), `documents/projectsLogic.js`, `activity/handler.js`, `template.yaml` (tables, ProjectsFunction), `App.jsx`, `ManageProjects.jsx`, `CreateProjectModal.jsx`, `ManageTasks.jsx`, `Work.jsx`, `api.js`, `auth.js` (frontend), `taskStatus.js`, architecture docs 04–07, `PROJECT-OVERVIEW.md`.

Not inspected: live AWS DynamoDB items, SES identities, CloudFront DNS, production JWT contents.
