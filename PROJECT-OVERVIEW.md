# DGV Employee Portal — Project Overview

**Product:** Internal employee + admin portal for Divit Global Ventures (DGV)  
**Domain:** `@mydgv.com` accounts only  
**Live frontend:** `login.mydgv.com`  
**AWS region:** `ap-south-1` (Mumbai)  
**Company timezone:** `Asia/Kolkata` (`+05:30`)  
**Repo:** `employee-portal/` (frontend + serverless backend in one repository)

This document is a single map of **what the product does**, **how it is built**, and **where the code lives**.

---

## 1. What this product is

The portal is the day-to-day operating system for DGV employees and administrators.

Employees sign in with Cognito, complete a consent gate, then use one workspace for attendance, tasks, leave, documents, meetings, training, profile, payroll/exit placeholders, and software downloads.

Admins (and managers with admin-portal access) switch into an Admin view to manage people, tasks, attendance, leave, announcements, documents, meetings, activity, resignations, training material, and settings.

Public signup is disabled. Admins create Cognito users from **Manage Employees**.

---

## 2. Who uses it

| Portal role (DynamoDB `UserAccess.role`) | Cognito group | What they get |
|---|---|---|
| `SUPER_ADMIN` | Admin | Admin portal |
| `ADMIN` | Admin | Admin portal |
| `MANAGER` | Admin | Admin portal |
| `EMPLOYEE` | Employee | Employee portal |

Frontend gate after login is `ADMIN` vs `USER` (`accessGateForRole`). JWT `cognito:groups` still drives Lambda `user.isAdmin`.

Admins can toggle **Employee / Admin** in the header without a second login (`switchPortalView`).

Access outcomes from `GET /access`:

- `ADMIN` / `USER` — allowed  
- `PENDING` — request-access screen  
- `BLOCKED` — blocked page  
- `DENIED` — not `@mydgv.com`

---

## 3. Features

### 3.1 Authentication and access

- Cognito Hosted UI (implicit + code OAuth, email + openid)
- Login as **Employee** or **Admin** (intent stored, then `/callback`)
- ID token in `localStorage` (`token`) sent as `Authorization: Bearer`
- First-time / pending users: **Request Access**
- Domain restriction: `@mydgv.com` only
- Consent modal (`ConsentGate`) before using the app
- Light/dark theme preference (`dgv-theme`)
- Logout via Cognito logout URL

### 3.2 Employee workspace

| Area | Route | What it does |
|---|---|---|
| Dashboard | `/` | KPIs (portal time, open tasks, pending leave), shortcuts, zone notifications, announcements, open tasks |
| Attendance | `/attendance` | Daily status, check-in / check-out, weekly history |
| My Tasks | `/work`, `/work/:taskId` | Assigned work, zone (Green/Orange/Red), status updates, time log, details |
| Leave | `/leave` | Apply and track leave; in-app notifications |
| Documents | `/documents` | Upload/view required documents, review status |
| Meetings | `/meetings` | Upcoming meetings, join window |
| Training | `/training` | Skill materials and video URLs |
| Profile | `/profile` | Profile fields + photo |
| Software Center | `/software-center` | Internal installers / downloads |
| Performance | `/performance` | Performance records |
| Expertise | `/expertise` | Skills / expertise |
| Payroll | `/payroll` | Placeholder / existing payroll UI |
| Exit | `/exit` | Resignation submit / status |

Also: activity tracking (page, session minutes, IP/device), working-time widget, notification bell.

### 3.3 Admin workspace

| Area | Route | What it does |
|---|---|---|
| Dashboard | `/admin/dashboard` | Active today, open tasks, projects, pending leave, recent activity, overdue tasks |
| Employees | `/admin/employees` | Create/edit users, roles, status, password reset, delete, search |
| Employee tracking | `/admin/employees/:email/track`, `/admin/employee-tracking` | Per-person attendance, tasks, leave, activity |
| Tasks | `/admin/tasks`, `/admin/tasks/:taskId` | Projects, multi-assignee tasks, zones, comments, attachments, activity |
| Attendance | `/admin/attendance-activity` | Org check-in / check-out activity |
| Leave | `/admin/leave` | Approve / reject leave |
| Documents | `/admin/documents` | Types, review uploads |
| Announcements | `/admin/announcements` | Create/edit/delete, expiry, history |
| Meetings | `/admin/meetings` | Schedule / update / cancel |
| Training | `/admin/add-training` | Upload training material |
| Software Center | `/software-center` (admin view) | CRUD software + upload URLs |
| Activity | `/admin/activity` | Team activity log |
| Resignations | `/admin/resignations` | Review exit requests |
| Settings | `/admin/settings` | Admin settings (including weekly red-zone email config on tasks/settings) |

Coming-soon (routed, not built): `/admin/reports`, `/admin/admin-management`, `/admin/audit-logs`.

### 3.4 Tasks and escalation (core operations)

- Tasks belong to a **project**
- Create: title, description, category, **multiple assignees**, priority, start + deadline
- Status starts as `TODO`
- Independent assignments: `PK=TASK#{id}`, `SK=ASSIGNMENT#{email}`
- **Zones** (from original deadline, Asia/Kolkata):
  - Green → Orange at deadline
  - Orange → Red 24 hours after deadline
- EventBridge ~every 5 minutes runs escalation sweep
- In-app notifications on Orange/Red (`TASK_ORANGE` / `TASK_RED`)
- Optional **weekly Red-Zone email** (assignee, team lead, `dgv@mydgv.com`), default off
- Author name stored as `createdByName` (profile / claims / typed name)

### 3.5 Announcements

- Stored on work table: `PK=ENTITY#ANNOUNCE`, `SK=ANN#{id}`
- Optional `expiresAt`; `null` = no expiry
- Public `GET /announcements` returns currently visible items
- Admin history `GET /admin/announcements` returns all + derived status (ACTIVE / EXPIRED / NO_EXPIRY)
- Meetings may reuse announcement records without expiry
- Author name: `createdByName`

### 3.6 Notifications

- DynamoDB `NOTIFY#` items per user
- Bell in header (unread badge)
- Leave + task-zone events
- Mark-read via `PUT /leave` `{ action: "readNotification", sk }`
- Email via SES where configured (`noreply@mydgv.com`)

---

## 4. Tech stack

### Frontend

| Piece | Choice |
|---|---|
| UI | React 19 (Create React App / `react-scripts` 5) |
| Routing | `react-router-dom` 7 |
| Icons | `lucide-react` |
| Styling | CSS design system (`design-system.css`) + `theme.js` tokens |
| Fonts | Inter (body/UI), Plus Jakarta Sans (headings), JetBrains Mono (timers) |
| State | React local state + `localStorage` / `sessionStorage` (no Redux) |
| HTTP | `fetch` wrapper in `frontend/src/services/api.js` |
| Auth client | `frontend/src/services/auth.js` (Cognito Hosted UI) |
| Local run | `frontend/` → `npm start` → `http://localhost:3000` |

Default API (overridable with `REACT_APP_API_URL`):

`https://z0nrgtv865.execute-api.ap-south-1.amazonaws.com/prod`

### Backend

| Piece | Choice |
|---|---|
| Runtime | AWS Lambda, Node.js 18 |
| IaC | AWS SAM (`backend/template.yaml`) |
| API | API Gateway REST (`prod` stage), Cognito authorizer |
| Auth | Amazon Cognito (Admin / Employee groups) |
| Data | DynamoDB (on-demand / pay-per-request) |
| Files | S3 + pre-signed URLs |
| Email | Amazon SES |
| Schedule | EventBridge (task escalation, announcement expiry log, weekly red-zone) |
| Frontend host | S3 + CloudFront (`login.mydgv.com`) |
| AWS SDK | v3 (`@aws-sdk/client-*`) |

### CI/CD

`.github/workflows/main.yml` on `main`, `dev`, `feature/*`:

1. `sam build` + `sam deploy` (stack `mydgv-portal`)
2. Build React with Cognito + API outputs
3. Sync to frontend S3
4. CloudFront invalidation

Secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.

---

## 5. Architecture (how a request flows)

```
Browser (login.mydgv.com or localhost:3000)
    │  Cognito Hosted UI → /callback (id_token)
    │  Bearer token on API calls
    ▼
API Gateway (Cognito authorizer)
    ▼
Lambda (module handler)
    ▼
DynamoDB / S3 / SES / Cognito Admin APIs
```

**Frontend auth guard:** `RequireAuth` in `App.jsx` (token, role, optional `adminOnly`) + `ConsentGate`.

**API client:** `api()` attaches JWT; expired JWT or **401/403** clears session and redirects to `/login`. Optional reads use `apiOptional()` so a 403 does not log the user out (used for announcement history).

---

## 6. Repository layout

```
employee-portal/
├── frontend/                 React app
│   ├── src/
│   │   ├── App.jsx           Routes
│   │   ├── pages/            Employee + Admin screens
│   │   ├── components/       Layout, ConsentGate, UI kit
│   │   ├── services/         api.js, auth.js, activityTracker.js
│   │   ├── styles/           design-system.css
│   │   ├── theme.js          JS token helpers
│   │   ├── theme/            ThemeProvider
│   │   ├── utils/            tasks, meetings, notifications, documents
│   │   └── constants/        roles.js
│   └── package.json
├── backend/
│   ├── template.yaml         SAM / CloudFormation
│   ├── lambda/               All Lambda source
│   └── package.json          Unit tests
├── .github/workflows/main.yml
├── docs/                     Feature notes (e.g. employee search)
└── PROJECT-OVERVIEW.md       This file
```

Lambdas live under `backend/lambda/` (not the older `backend/src/` tree in the short readme).

---

## 7. Backend modules (Lambdas)

| Function | Responsibility |
|---|---|
| PreSignUp | Cognito pre-signup hook |
| AccessFunction | `GET/POST /access`, request-access |
| AdminFunction | Users, dashboard, roles/status |
| UserProfile / UserProfileFunction | Profile CRUD |
| ImageUploadFunction | Profile image upload URLs |
| AttendanceFunction | Attendance + check-in/out |
| ActivityFunction | Activity log |
| ProjectsFunction | Projects, tasks, assignments, zones, comments, attachments, red-zone weekly |
| LeaveFunction | Leave + notification read |
| NotificationsFunction | Notification APIs |
| AnnouncementsFunction | Announcements + expiry schedule |
| MeetingsFunction | Meetings |
| DocumentsFunction | Employee documents |
| TrainingFunction + training URL/list/skills/addTraining | Training catalog and video URLs |
| PerformanceFunction | Performance |
| SoftwareFunction / AgentDownload | Software center + agent downloads |
| ConsentFunction | Consent |
| resignation | Resignations |
| MockTestFunction | LLM/mock test (legacy/internal) |

Shared code: `backend/lambda/common/` — `auth.js`, `roles.js`, `response.js`, `notify.js`, `email.js`, `geo.js`, `requestMeta.js`.

---

## 8. Data stores

### DynamoDB tables (stack prefix `mydgv-portal-…`)

| Table | Typical use |
|---|---|
| Users | User records |
| Attendance | Daily attendance |
| WorkTasks | Tasks, assignments, announcements, meetings, notifications (single-table style keys) |
| Performance | Performance |
| TrainingProgress | Training progress |
| UserAccess | Access + portal role + status |
| UserProfile | Profile (`PK=USER#{email}`, `SK=PROFILE`) |
| TrainingMaterials | Training files metadata |
| SkillMaster | Skills |
| Resignations | Exit requests |
| ActivityLog | Login/page/session events |

Work-table key patterns (examples):

- Task: `PK=ENTITY#TASK`, `SK=TASK#{id}`
- Assignment: `PK=TASK#{id}`, `SK=ASSIGNMENT#{email}`
- Announcement: `PK=ENTITY#ANNOUNCE`, `SK=ANN#{id}`
- Notification: `PK=USER#{email}`, `SK=NOTIFY#…`

### S3 buckets

- Profile images  
- Training material  
- Employee documents  
- Agent / software downloads  
- Frontend static site  

---

## 9. Frontend structure (important files)

| Path | Role |
|---|---|
| `src/App.jsx` | All routes + `RequireAuth` |
| `src/components/Layout.jsx` | Sidebar, header, search, notifications, theme, portal switch |
| `src/services/api.js` | Every HTTP API helper |
| `src/services/auth.js` | Cognito login/callback/logout/access |
| `src/styles/design-system.css` | Visual system (colors, type, shell, components) |
| `src/utils/taskStatus.js` | Zones, status labels, search/filter helpers |
| `src/utils/meetings.js` | Meeting/announcement helpers, display names |
| `src/utils/notifications.js` | Zone notification helpers |
| `src/components/ui/` | Button, Card, Input, Modal |

UI direction (current): Premium Minimal / Swiss / enterprise SaaS. Primary `#172033`, background `#F6F7F9`, accent purple used sparingly. Functionality is independent of this skin.

---

## 10. API surface (frontend → backend)

Grouped by `api.js`. All authenticated unless noted.

- **Access:** `/access`, `/request-access`
- **Users/profile:** `/admin/users`, `/admin/getUserProfile`, `/admin/save-user-profile`, profile image URLs
- **Activity:** `/activity`, `/activity/today`, `/admin/activity`, `/admin/dashboard`
- **Projects/tasks:** `/projects`, `/tasks`, `/tasks/:id`, comments/activity/attachments, `/tasks/redzone-report`, `/time-entries`
- **Leave:** `/leave`
- **Attendance:** `/attendance`, `/attendance/activity`
- **Announcements:** `/announcements`, `/admin/announcements`
- **Meetings:** meeting helpers (some via announcements storage)
- **Documents:** `/documents`, `/admin/documents`, `/documents/types`
- **Training:** `/skills`, `/getUserTrainingList`, `/getTrainingVideoUrl`, `/getTrainingUploadUrl`, `/addTrainingMaterial`
- **Software:** `/software`, `/admin/software`
- **Consent:** `/consent`

---

## 11. Local development

**Frontend**

```bash
cd frontend
npm install
npm start
```

Uses localhost Cognito callback `http://localhost:3000/callback`.

**Backend tests** (Node, no SAM required):

```bash
cd backend
npm test
```

**Deploy backend:** AWS SAM from `backend/` (`sam build` / `sam deploy`), capabilities `CAPABILITY_IAM` + `CAPABILITY_NAMED_IAM`.

New Lambda routes (for example `GET /admin/announcements`) must be **deployed** or API Gateway may return 403.

---

## 12. Security notes (as implemented)

- Cognito authorizer on API Gateway (CORS preflight excluded)
- `@mydgv.com` allow-list
- Admin-only APIs check `user.isAdmin` (Cognito Admin group)
- File access via short-lived S3 pre-signed URLs
- Frontend treats 401 and 403 from `api()` as session death (except `apiOptional`)
- Consent recorded before main app use
- Activity logging includes IP / device / pages (shown in consent copy)

---

## 13. Tests

Backend Node assert tests (no Jest):

- `lambda/meetings/logic.test.js`
- `lambda/notifications/logic.test.js`
- `lambda/common/notify.test.js`
- `lambda/projects/escalation.test.js`
- `lambda/projects/redzoneWeekly.test.js`
- `lambda/projects/zoneNotify.test.js`
- `lambda/announcements/logic.test.js`

Frontend uses CRA test scripts; product coverage is primarily backend logic tests.

---

## 14. What is still placeholder / later phase

- Payroll and some employee modules may be thin UIs
- Admin Reports, Admin Management, Audit Logs: `ComingSoon` (Phase 5)
- Software Center items can be marked coming soon for employees
- Weekly red-zone email requires SAM deploy and SES verification

---

## 15. Mental model for new work

1. **UI-only** → `design-system.css`, `theme.js`, Layout, page styles. Do not change `api.js` / auth / Lambdas.  
2. **Employee/admin screen** → `frontend/src/pages/…` + existing `api.js` helper.  
3. **New API** → Lambda under `backend/lambda/…` + event in `template.yaml` + `api.js` wrapper + SAM deploy.  
4. **Auth/access** → `auth.js` (client) and `lambda/access` + `lambda/common/auth.js` / `roles.js` (server).  
5. **Tasks/zones** → `lambda/projects/` (`handler.js`, `escalation.js`, `zoneNotify.js`, `redzoneWeekly.js`).

The product rule used throughout recent work: **same workflows and APIs; change presentation or a specific bug, not the platform.**
