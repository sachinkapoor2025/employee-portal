# 07 — Authentication and authorization

**Last verified:** 21 September 2026  
**Sources:** `backend/template.yaml` Cognito + Api Auth, `frontend/src/services/auth.js`, `frontend/src/App.jsx`, `backend/lambda/common/auth.js`, `backend/lambda/common/roles.js`, `backend/lambda/access/handler.js`

This document lists **controls that exist in source**. It does not claim production compliance or that missing controls are present.

## Cognito Hosted UI

User pool (`template.yaml`):

- Username: email
- Auto-verify email
- `AllowAdminCreateUserOnly: true`
- Password policy: min 8, upper, lower, numbers
- PreSignUp: `lambda/cognito/preSignUp.js` — email must end with `@mydgv.com`
- Groups: `Admin`, `Employee`
- Client: `GenerateSecret: false`
- OAuth: `implicit` and `code`; scopes `openid`, `email`, `profile`
- Explicit flows: `ALLOW_USER_PASSWORD_AUTH`, `ALLOW_USER_SRP_AUTH`, `ALLOW_REFRESH_TOKEN_AUTH`
- Callback URLs: `http://localhost:3000/callback`, `https://${FrontendDomainName}/callback`
- Logout URLs: `http://localhost:3000`, `https://${FrontendDomainName}`

**SPA implements implicit only:** `response_type=token`, reads `id_token` from the URL hash. Refresh tokens are **not** stored or exchanged in `auth.js`.

## JWT token flow

```
Hosted UI → #id_token → localStorage.token / id_token
→ Authorization: Bearer on API calls
→ API Gateway CognitoAuthorizer
→ event.requestContext.authorizer.claims
→ getUser(): email, groups, isAdmin
```

Client expiry: `isTokenExpired` uses JWT `exp` with 30s skew (`api.js`). Pool `IdTokenValidity` is **not** set in SAM (**unverified** AWS default).

Cookies are **not** used for REST session. CSRF tokens are **not** implemented on APIs.

## API Gateway authorizer

`Auth.DefaultAuthorizer: CognitoAuthorizer` on `ApiGateway`. All SAM `Type: Api` methods inherit this unless a method overrides it (none found). CORS preflight skips authorizer.

## Domain restriction

| Layer | Rule |
|---|---|
| PreSignUp | reject non-`@mydgv.com` |
| `isAllowedEmail` | same suffix |
| GET `/access` | `DENIED` if domain fails |

## Cognito groups vs portal roles

| Concept | Store | Used for |
|---|---|---|
| `Admin` / `Employee` groups | Cognito | Lambda `user.isAdmin` |
| `SUPER_ADMIN` `ADMIN` `MANAGER` `EMPLOYEE` | UserAccess.role | GET `/access` gate, some Super Admin operations, documents write helper |
| Frontend `role` `ADMIN`/`USER` | localStorage | Routing and nav (view switch) |

`accessGateForRole`: Manager/Admin/Super Admin → `access: "ADMIN"`; Employee → `USER`.

GET `/access` can **override** stored role if JWT group and UserAccess disagree (admin group forces admin portal role; non-admin JWT cannot keep admin portal role).

## UserAccess table

Key `PK=email`, `SK=email`. Attributes used: `role`, `status`, `email`, timestamps.

Statuses: `ACTIVE`, `PENDING`, `BLOCKED` (and DENIED is a computed gate, not necessarily a stored status).

## Frontend guards

`RequireAuth` (`App.jsx`):

1. No token → `/login`
2. No `role` → `/request-access`
3. `adminOnly` and `role !== "ADMIN"` → `/`

This is **view-role** based. A user with admin JWT who is in employee view cannot open `/admin/*` until they switch view.

`ConsentGate` is UX, not API authorization.

`api.js`: **401** / expired JWT → logout. **403** keeps the session (forbidden ≠ unauthenticated).

SPA path ownership (employee `/work/:taskId` vs admin `/admin/tasks/:taskId`) is in [14-employee-admin-path-separation.md](./14-employee-admin-path-separation.md). Employee routes must not call `GET /admin/users`.

## Backend checks (patterns)

| Pattern | Example |
|---|---|
| Email on JWT | 401 `{ error: "Unauthorized" }` if missing |
| `user.isAdmin` | POST `/projects`, POST `/tasks`, `/admin/*` handlers |
| Assignee | GET `/tasks/{id}`, PUT `/tasks` |
| Super Admin | user delete / lifecycle (`canManageUserAccessLifecycle`) |
| Own profile edit | UserProfileFunction `mode === "EDIT"` and email === caller |
| Notification SK | must start with `NOTIFY#` and belong to caller PK |

Many list endpoints are **JWT-only** (any authenticated `@mydgv.com` user who passed the authorizer).

## Admin vs employee boundary

- **Employee:** own attendance, own leave apply, own tasks on `/work` and `/work/:taskId` (`mine=true` / assignee `GET /tasks/{id}`), own documents, training list, profile. Not the admin user directory.
- **Admin group:** user management (`GET /admin/users` from `/admin/*` pages), task/project create, leave review, announcements/meetings mutate, software CRUD, admin dashboard, unscoped leave `all=true`.
- **Red Zone:** employees cannot change assignment status (`employeeMayChangeStatus` false when zone is RED).

## Known authorization risks (verified in source — not exploit recipes)

1. **GET `/admin/getUserProfile?email=`** — same handler as `/user/profile`; if `email` query is present it is used **without** admin or self check (`UserProfile/app.mjs`). Authenticated callers can request another user’s item (includes HR document signed URLs when present).
2. **GET `/tasks`** without `mine=true` returns all non-archived tasks to any authenticated user (`projects/handler.js`).
3. **GET `/projects`** returns all projects for the requested status filter with no membership check.
4. **POST `/addTrainingMaterial`** — no `isAdmin` in handler (UI is admin-only).
5. **POST `/training/mock-test`** — handler does not read the user (Gateway still requires JWT).
6. **Admin password reset** returns `temporaryPassword` in the JSON body (`admin/handler.js`).
7. **API Gateway `DataTraceEnabled: true`** — request/response logging may include tokens/PII (`template.yaml`).
8. Frontend **403 → session expired** is **fixed in source** (`api.js` logs out on 401 only). Until the frontend is deployed, production SPA may still logout employees who receive `GET /admin/users` 403 from the shared Task Details page.

Items not found: permission matrix table, WAF, API usage plans / rate limits, mTLS, resource-level Cognito groups per API method.
