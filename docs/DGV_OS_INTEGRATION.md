# DGV AI OS ↔ MyDGV integration

Branch: `feature/dgv-ai-os-integration`

Live API base: `https://z0nrgtv865.execute-api.ap-south-1.amazonaws.com/prod`

## Portal UI

Admin → **DGV AI OS** (`/admin/dgv-ai-os`) — status + API docs (Cognito admin session).
Does **not** expose the S2S key.

Admin API: `GET /admin/dgv-os/status` (Bearer Cognito JWT, admin only).

## Server-to-server endpoints (API key auth)

Header: `x-dgv-os-key: <DgvOsApiKey>`

| Method | Path | Purpose |
|---|---|---|
| GET | `/integrations/dgv-os/health` | Health |
| GET | `/integrations/dgv-os/employees` | Read profiles |
| GET | `/integrations/dgv-os/capacity` | Open-task load |
| GET | `/integrations/dgv-os/tasks` | Read tasks |
| POST | `/integrations/dgv-os/tasks` | Create human task (`Idempotency-Key` required) |
| PATCH | `/integrations/dgv-os/tasks/{taskId}` | Update status/ETA/blockers |

AI-created tasks are tagged `source: DGV_AI_OS` and label `ai-os`.

## Deploy

```bash
cd backend
sam build
sam deploy --parameter-overrides DgvOsApiKey=YOUR_LONG_RANDOM_SECRET
```

Then set on DGV AI OS:

```
MYDGV_API_URL=https://xxxx.execute-api.ap-south-1.amazonaws.com/prod
MYDGV_DGV_OS_API_KEY=YOUR_LONG_RANDOM_SECRET
```

## Forbidden

This integration does **not** mutate attendance, payroll, or employee HR records.
