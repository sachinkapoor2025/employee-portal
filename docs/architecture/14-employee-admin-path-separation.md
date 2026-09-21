# 14 — Employee vs admin path separation

**Last verified:** 21 September 2026  
**Sources:** `frontend/src/App.jsx`, `frontend/src/pages/Dashboard.jsx`, `frontend/src/pages/Work.jsx`, `frontend/src/pages/Admin/TaskDetails.jsx`, `frontend/src/pages/Admin/ManageTasks.jsx`, `frontend/src/utils/notifications.js`, `frontend/src/components/Layout.jsx`, `frontend/src/services/api.js`, `backend/lambda/admin/handler.js`, `backend/lambda/projects/handler.js`

**Purpose:** Keep employee and admin **SPA paths** and **API calls** separate so future features do not mix them. A different URL is not enough if the page still calls an admin-only API.

---

## Rule (keep this clear)

1. **Employee UI lives under employee routes.** Do not send employees to `/admin/*` to view their own work.
2. **Admin UI lives under `/admin/*`.** Those routes stay behind `RequireAuth adminOnly`.
3. **Each path may call only APIs that role is allowed to use.** Path ownership includes the HTTP calls the page makes, not just `App.jsx` routing.
4. Sharing a React component between employee and admin routes is allowed **only if** API calls, actions, and navigation are branched by path (or an equivalent explicit employee/admin mode).
5. Do **not** grant employees `GET /admin/users` (or other admin directory APIs) to make a shared page work. Use the employee-authorized task API instead.

If a new screen needs assignee names, prefer data already returned by `GET /tasks/{taskId}` (or another employee-authorized endpoint). Do not load the admin user directory from `/work/*`.

---

## Canonical task paths

| Actor | SPA path | How the user gets there | Allowed task APIs |
|---|---|---|---|
| Employee | `/work` | Sidebar **My Tasks** | `GET /tasks?mine=true` |
| Employee | `/work/:taskId` | Dashboard open-task click; notification bell; My Tasks | `GET /tasks/{taskId}`, `GET /tasks/{taskId}/activity`, employee-limited `PUT /tasks` |
| Admin (admin view) | `/admin/tasks` | Admin **Tasks** | Task list/create APIs used by `ManageTasks.jsx` |
| Admin (admin view) | `/admin/tasks/:taskId` | Admin task board | Same plus admin mutations (edit/reassign) and `GET /admin/users` for the reassign directory |

**Verified navigation**

- Dashboard (`Dashboard.jsx`) → `navigate(\`/work/${taskId}\`)`  
- Notification bell (`notificationTaskPath`) → `/work/:taskId` when employee view, `/admin/tasks/:taskId` when admin view  
- Admin task board (`ManageTasks.jsx`) → `/admin/tasks/:taskId`

Employees must **not** be routed to `/admin/tasks/:taskId` for their assigned work.

---

## Shared component, separate APIs

Both `/work/:taskId` and `/admin/tasks/:taskId` render `pages/Admin/TaskDetails.jsx`.

`employeeView = location.pathname.startsWith("/work")`.

| Concern | Employee `/work/:taskId` | Admin `/admin/tasks/:taskId` |
|---|---|---|
| User directory | **Must not** call `GET /admin/users` | May call `fetchUsers()` → `GET /admin/users` for reassign |
| Other-user profile lookup | **Must not** call `GET /admin/getUserProfile?email=` | May look up names for edit/reassign |
| Display names | From `GET /tasks/{taskId}` (`assigneeProfile`, `createdByName`, …) | Directory + task payload |
| Edit / reassign / change-status chrome | Hidden | Shown |
| Back navigation | `/work` | `/admin/tasks` |

`GET /admin/users` remains **Admin Cognito group only** (`admin/handler.js` returns `403 { error: "Admin access required" }`). That 403 is authorization, not a missing session.

`GET /tasks/{taskId}` remains **assignee or Admin** (`canViewTask` in `projects/handler.js`). Assigned employees may open their own task on `/work/:taskId`.

---

## Session handling (related)

`api()`:

- **401** or expired JWT → clear session and go to `/login`
- **403** → keep the session; throw with `status` so the page can show access denied

A valid employee hitting an admin-only API must stay logged in. Do not treat “Admin required” as “session expired”.

---

## Incident this rule prevents

An employee could sign in, use dashboard/leave/attendance, then click an open task or a task notification and get sent to `/login`.

Cause: `/work/:taskId` still called `GET /admin/users` through the shared Task Details page. Production `api()` treated that 403 as logout.

Fix in source: skip the admin directory on `/work/*`; do not logout on 403. Frontend deploy is required for `login.mydgv.com` to pick this up.

---

## Checklist for future task (or similar) features

Before adding a call from a page:

1. Which SPA path is this — `/work…` or `/admin/…`?
2. Is the API in `06-api-catalog.md` allowed for that actor (`isAdmin` vs assignee vs JWT-only)?
3. If the component is shared, is the new call behind `employeeView` / `adminOnly` so the employee path never hits `/admin/*` APIs?
4. Update this file and **04** if a new employee or admin route is added.

Do not “reuse admin APIs from the employee path” to save a round trip.
