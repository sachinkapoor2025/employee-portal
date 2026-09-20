# 01 — Context and actors

**Last verified:** 20 September 2026  
**Sources:** `frontend/src/pages/Login.jsx`, `frontend/src/services/auth.js`, `frontend/src/App.jsx`, `frontend/src/constants/roles.js`, `backend/lambda/common/auth.js`, `backend/lambda/common/roles.js`, `backend/lambda/access/handler.js`, `backend/template.yaml`

## System purpose

Internal employee and administrator portal for Divit Global Ventures (DGV). Accounts must use **`@mydgv.com`**. Public self-registration is disabled (`AdminCreateUserConfig.AllowAdminCreateUserOnly: true`; Login UI states admins create accounts from Manage Users).

## Actors

### External browser / client

The only first-party client in this repository is the **React SPA**. It runs at `http://localhost:3000` in development and is intended at `https://login.mydgv.com` in production (SAM `FrontendDomainName`).

The SPA:

- Redirects to **Cognito Hosted UI** for login
- Stores the **id token** in `localStorage`
- Calls API Gateway with `Authorization: Bearer <id_token>`

There is **no** mobile app, desktop Electron app, or public anonymous API in this repo. `GET /downloads/agent` exists for a Windows tracker installer; the SPA route `/downloads` redirects to `/software-center`.

### Employees

- Portal role stored on UserAccess: `EMPLOYEE` (legacy `USER` is normalized to `EMPLOYEE`).
- Cognito group: `Employee` (unless a group/role mismatch exists).
- After login, `GET /access` typically returns `access: "USER"`.
- Frontend view role `localStorage.role = "USER"`.
- Use employee routes in `App.jsx` (dashboard, attendance, tasks, leave, documents, etc.).

### Managers, Admins, Super Admins

Portal roles on UserAccess (`backend/lambda/common/roles.js`):

| Portal role | Cognito group (intended) | Admin portal |
|---|---|---|
| `MANAGER` | `Admin` | Yes (`accessGateForRole` → `ADMIN`) |
| `ADMIN` | `Admin` | Yes |
| `SUPER_ADMIN` | `Admin` | Yes |

Lambda **`user.isAdmin`** is **not** these strings. It is `cognito:groups` includes `"Admin"` (`backend/lambda/common/auth.js`).

Frontend:

- `actualRole` / `portalRole` stored after `/access`
- Header can switch Employee vs Admin view (`switchPortalView`) if `canAccessAdmin()` is true
- Admin UI routes use `RequireAuth adminOnly`, which checks `localStorage.role === "ADMIN"` (the **view**), not `portalRole`

Super Admin-only behaviors verified in code (examples):

- User activate/deactivate/delete: `canManageUserAccessLifecycle` (`admin/handler.js`, `roles.js`)
- Assigning `SUPER_ADMIN`: `canAssignPortalRole`
- Documents project writes: Super Admin or Admin, **not** Manager (`canManageProjectDocuments`)

### Cognito

Amazon Cognito User Pool (email username). Responsibilities verified in SAM:

- Hosted UI login/logout
- JWT issuance (`openid`, `email`, `profile` scopes on the client)
- Groups `Admin` and `Employee`
- PreSignUp Lambda rejects non-`@mydgv.com`
- Admin APIs from Lambdas: create user, set password, add/remove group, delete user

Cognito is **not** the portal role store. Portal role lives in **UserAccess**.

### EventBridge

Not a human actor. SAM `Schedule` events invoke Lambdas without an HTTP method:

| Rule (name pattern) | Target | Cadence | Input flag |
|---|---|---|---|
| `{stack}-task-escalation` | ProjectsFunction | `rate(5 minutes)` | `taskEscalation` |
| `{stack}-leave-auto-approve` | LeaveFunction | `rate(5 minutes)` | `autoApprove` |
| `{stack}-announcement-expiry` | AnnouncementsFunction | `rate(5 minutes)` | `expireAnnouncements` |
| `{stack}-meeting-reminders` | MeetingsFunction | `rate(5 minutes)` | `reminders` |
| `{stack}-daily-notifications` | NotificationsFunction | `cron(30 3 * * ? *)` | `notifications` |

### SES

Amazon SES sends transactional email when Lambdas call `ses:SendEmail` / `ses:SendRawEmail` (Projects, Notifications, Documents, and related notify helpers). Sender parameter default: `noreply@mydgv.com`. Whether the identity is verified in the AWS account is **unverified** from this repo.

## User access flow (verified)

1. User clicks **Sign in as Employee** or **Sign in as Admin** (`Login.jsx` → `login(intent)`).
2. `sessionStorage.portalIntent` is set; browser goes to Cognito Hosted UI (`response_type=token`).
3. Redirect to `{origin}/callback#id_token=...`.
4. SPA stores token; calls **GET `/access`**.
5. Access Lambda reads UserAccess and Cognito claims; returns `access` + `role`.
6. `applyAccessRedirect` in `auth.js`:

| `access` | Behavior |
|---|---|
| `ADMIN` | May land on `/admin/dashboard` if intent was admin; else employee home |
| `USER` | Employee home; admin intent → `/login?adminDenied=1` |
| `PENDING` | `/request-access?status=pending` |
| `BLOCKED` | `/blocked` |
| `DENIED` | `/login?domainDenied=1` (non-`@mydgv.com`) |

7. Authed routes wrap **ConsentGate** (GET/POST `/consent`).
8. **ActivityTracker** posts login/heartbeat to `/activity`.

POST **`/request-access`** creates or updates UserAccess as `PENDING` / `EMPLOYEE` when the user does not already have USER/ADMIN access.

## System boundary

**Inside**

- SPA, Cognito pool/client/domain (as defined in SAM), API Gateway, Lambdas, DynamoDB tables in `template.yaml`, S3 buckets in SAM, EventBridge rules, SES send from Lambdas, CloudFront distribution for the SPA, GitHub Actions deploy to stack `mydgv-portal`.

**Outside (integrations used, not implemented here)**

- End-user browsers
- Cognito Hosted UI HTML pages
- Optional IP geolocation used by `common/geo.js` (runtime HTTP to an external lookup — treat provider as **assumption** unless you inspect that file’s URL)
- Meeting join URLs stored as strings (external video tools)
- Windows “DGV Work Tracker” binary in S3 (`software/handler.js` key `DGV-WorkTracker-Setup.exe`)

**Not in this repository**

- A separate API microservice
- RDS / SQL
- Redis
- Native iOS/Android app
- Push notifications (FCM/APNs)
