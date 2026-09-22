# 12 — Project-Level Access Control: requirements and actors

**Superseded for implementation:** Stage 1 approved policy and plan are in [15-project-acl-stage1-plan.md](./15-project-acl-stage1-plan.md). This file is a Phase 2 draft; several defaults (Super Admin bypass, RESTRICTED-by-default) were **rejected**.

**Phase:** 2 (planning / design only)  
**Date:** 21 September 2026  
**Status:** Phase 2 draft. **Not the live policy.** Stage 1+ implementation followed [15](./15-project-acl-stage1-plan.md) and later stages; do not treat Super Admin bypass or RESTRICTED-by-default as current behavior.  
**Depends on:** [11-project-level-access-control-audit.md](./11-project-level-access-control-audit.md) (historical audit)  
**Companion:** [13-project-acl-technical-design.md](./13-project-acl-technical-design.md)

Application, schema, and AWS were **not** changed in this phase.

Labels: **Verified** (source) · **Proposed** (design) · **Unknown** · **Needs approval**.

---

## 1. Feature objective

**Proposed:** Restrict WorkTasks **work projects** (and their protected APIs) so that sensitive project information and permitted operations are available only to authorized users. Authorization is enforced **in Lambda**, not only in the SPA.

**Verified need:** Phase 1 — no project ACL; Cognito Admin mutates any project; GET `/projects` and unscoped GET `/tasks` are JWT catalogs.

---

## 2. MVP scope

**In (Proposed):**

- Access **mode** per work project: `OPEN` (legacy-compatible) vs `RESTRICTED`.
- **Membership** as first-class WorkTasks items (not the unused create-only `members` array as ACL).
- Backend checks on project list/create/update/archive/delete and on task list/detail/update/create/import for `RESTRICTED` projects.
- Create/edit UI: select ACTIVE users as members (same picker pattern as task assignees).
- Super Admin **break-glass** is a proposed default (**Needs approval**, D1).

**Explicit exclusions (Proposed / Verified documents):**

- Document-folder “projects” (`documents/projectsLogic.js`, S3 manifests). **Verified** separate product.
- New DynamoDB table in SAM (**Proposed:** reuse `WORK_TABLE` only).
- Frontend-only hiding of admin nav.
- Payroll, expertise, performance placeholders.
- Changing SES / notification recipient policy beyond “do not leak restricted project titles to non-members” (**Needs approval** if notify copy includes project names for non-members).

---

## 3. User stories (Proposed)

| ID | Actor | Story | Acceptance sketch |
|---|---|---|---|
| US1 | Admin | Create a restricted project and pick members | POST succeeds; creator is a member; GET `/projects` as a non-member Admin does not include it |
| US2 | Admin member | Edit name/client/description and membership | PATCH allowed; non-member Admin gets 403 |
| US3 | Super Admin | Recover a locked project | Bypass membership if D1 approved |
| US4 | Employee member, assigned | See and update own assignment | GET/PUT task as today for assignees |
| US5 | Employee member, not assigned | Does **not** see other people’s tasks (if D2 = assigned-only) | GET `/tasks?projectId=` does not return others’ tasks |
| US6 | Employee non-member | Cannot list restricted project or its tasks | 200 empty / 403 as specified |
| US7 | Any JWT | Cannot use GET `/projects` as an org-wide dump | List is authorized and filtered |
| US8 | Admin | Archive/delete still requires name confirm | Existing delete/archive rules preserved for permitted actors |

---

## 4. Functional requirements (Proposed)

1. Creating a project may set access mode and an initial member list. Creator is always recorded (`createdBy` already **Verified**).
2. Restricted projects allow listed operations only for authorized principals (matrix in doc 13).
3. Open projects keep today’s Admin-global mutate behavior until migrated (**Needs approval** D3).
4. Membership add/remove is an Admin-member (or Super Admin) operation; members must be ACTIVE UserAccess users with `@mydgv.com`.
5. Revoked membership immediately fails subsequent API checks (no SPA cache as source of truth).
6. Task create on a restricted project: assignees must be project members (**Needs approval** D8 if import must differ).
7. Empty unused `members` on old items is **not** an ACL (**Verified** unused).

---

## 5. Non-functional

- Same stack/table (`WORK_TABLE`). No GSI required if user-copy items support “my projects” Query.
- Authorization helper must be unit-tested; handler tests for 403 vs 200.
- List queries must not scan unrelated tables.
- Do not log member emails in excess of existing operational logs.

---

## 6. Security requirements (Proposed)

- Cognito JWT still required (existing API authorizer, **Verified**).
- Re-check UserAccess `ACTIVE` on membership mutations and on access checks for restricted projects.
- 403 `{ error: "Forbidden" }` for authenticated-but-unauthorized (match existing task detail). Do not 404-hide unless product requires it (**Needs approval** D9).
- Least privilege for employees: membership ≠ full task dump unless D2 says otherwise.
- Backend enforcement on every listed route; UI is convenience.

---

## 7. Backward compatibility (Proposed)

- Existing POST fields `name`, `client`, `lead`, `members`, `status`, `description` remain accepted.
- `members` on create may be **accepted and copied into membership items**, but ACL source of truth is membership items + `accessMode`, not the orphan array.
- Tasks still require `projectId` on create (**Verified** `handler.js` 1203–1205).
- Archive/delete confirmation copy unchanged for permitted users.

---

## 8. Acceptance criteria (Proposed)

- Non-member Cognito Admin cannot GET a restricted project in `/projects` or PATCH it (unless D1 Super Admin). **Stage 3E DELETE:** ACTIVE UserAccess ADMIN or SUPER_ADMIN may delete OPEN and RESTRICTED projects **without** Project Admin or regular membership. Cognito `isAdmin` alone is not sufficient. MANAGER cannot delete.
- Non-member cannot GET `/tasks?projectId={restricted}`.
- Unscoped GET `/tasks` does not return restricted-project tasks to unauthorized callers.
- Employee My Tasks (`mine=true`) still returns **assigned** tasks, including restricted projects they are assigned to.
- Create UI can save members; tests cover modal + API.
- Document APIs unchanged.
- Legacy OPEN projects still listed to Admins as today until migrated.

---

## 9. Actor and role matrix

### 9.1 Existing authorization (Verified)

| Actor | How identified | Project mutate | GET `/projects` | GET `/tasks` unscoped | Task GET/PUT |
|---|---|---|---|---|---|
| Cognito Admin (SUPER_ADMIN, ADMIN, MANAGER in UserAccess, if group Admin) | `getUser().isAdmin` | Any project | Any JWT including employees | All tasks | Admin or assignee |
| Cognito Employee | `isAdmin === false` | 403 | **Allowed (full list)** | **All tasks** | Assignee only |
| `createdBy` / `lead` | Attributes on item | **Not checked** | n/a | n/a | n/a |
| `members[]` | Create payload | **Not checked** | n/a | n/a | n/a |
| Document Admin | same `isAdmin` | Document trees only | n/a | n/a | n/a |

Portal roles **Verified** in `roles.js`. Project APIs **do not** branch on SUPER_ADMIN vs MANAGER.

### 9.2 Proposed system-wide roles (unchanged)

Keep UserAccess `SUPER_ADMIN` | `ADMIN` | `MANAGER` | `EMPLOYEE` and Cognito Admin | Employee.

**Proposed create-project actor:** still Cognito Admin (preserve who can create). **Needs approval** if only Super Admin may create restricted projects (D4).

### 9.3 Proposed project-level permissions

There is **no** existing project-manager role in code. **Proposed:** do **not** add a second role enum in MVP. Permissions:

| Permission | Super Admin (if D1 yes) | Cognito Admin + member | Cognito Admin, not member, RESTRICTED | Cognito Admin, OPEN project | Employee + member | Employee, assigned, not member | Employee other |
|---|---|---|---|---|---|---|---|
| Create project | Yes | Yes | Yes | Yes | No | No | No |
| List project | Yes | Yes | No | Yes | Metadata only if D7; else no admin list | No | No |
| Edit project / members | Yes | Yes | No | Yes | No | No | No |
| Archive / delete | Yes | Yes | No | Yes | No | No | No |
| Create task in project | Yes | Yes | No | Yes | No | No | No |
| List/view all tasks in project | Yes | Yes | No | Yes | **D2** | No | No |
| View/update own assignment | Yes | Yes | If still assignee: **D10** | Yes | If assigned | **Today: yes (assignee)** | No |

**D10 (Needs approval):** If someone is assigned on a restricted project but not a member, keep today’s assignee access (avoid lockout) vs require membership first.

### 9.4 Super Admin bypass

**Current:** Super Admin is not special on project APIs (**Verified**).  
**Proposed default:** Super Admin **may** bypass membership on RESTRICTED projects (break-glass).  
**Needs approval: D1.** If rejected, Super Admin is a member like other Admins and lockout risk rises.

---

## 10. Open decisions requiring business approval

| ID | Decision | Proposed default | If rejected |
|---|---|---|---|
| D1 | Super Admin bypasses RESTRICTED membership | Yes | Super Admin must be a member; recovery process needed |
| D2 | Employee members see all project tasks vs assigned only | **Assigned only** | Member sees all tasks in project |
| D3 | Legacy projects without `accessMode` | Treat as **OPEN** (today’s Admin-global + JWT list still tightened per F1) | Force RESTRICTED and backfill members from `createdBy`/`lead` |
| D4 | Who may create restricted projects | Any Cognito Admin | Super Admin only |
| D5 | MANAGER vs ADMIN on projects | Same as Cognito Admin (today) | Managers cannot create/mutate projects |
| D6 | New project default mode | **RESTRICTED**; creator auto-member | OPEN unless user opts in |
| D7 | Employees GET `/projects` | **403 or empty** except not needed for My Tasks | Employees see names of member projects |
| D8 | Import assignees must be members | Yes for RESTRICTED | Import may assign anyone ACTIVE |
| D9 | Unauthorized: 403 vs 404 | **403 Forbidden** (existing style) | 404 to hide existence |
| D10 | Assignee but not member | **Allow task GET/PUT** (compat) | 403 until added |

---

## 11. Documentation update summary

| File | Action |
|---|---|
| `11-project-level-access-control-audit.md` | Unchanged (Phase 1 facts) |
| `12-project-acl-requirements.md` | **This file** (requirements, actors, decisions) |
| `13-project-acl-technical-design.md` | Data, API, tasks, migration, UI, impact, stages |
| `README.md` | Index rows for 12 and 13 |

No application source updates in Phase 2.
