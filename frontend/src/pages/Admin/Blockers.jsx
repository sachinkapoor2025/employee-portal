import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Layout from "../../components/Layout";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import ZoneBadge from "../../components/ZoneBadge";
import { fetchTasks, resolveTaskBlocker } from "../../services/api";
import { colors, pageCard, pageTitle, pageSubtitle } from "../../theme";
import {
  formatTaskDateTime,
  personLabel,
  statusLabel,
} from "../../utils/taskStatus";

export function isActiveBlockerAssignment(assignment) {
  return (
    assignment &&
    !assignment.removed &&
    String(assignment.blockerStatus || "").trim().toUpperCase() === "ACTIVE"
  );
}

export function collectActiveBlockers(tasks) {
  const rows = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const assignments = Array.isArray(task?.assignments)
      ? task.assignments
      : [];
    for (const assignment of assignments) {
      if (!isActiveBlockerAssignment(assignment)) continue;
      rows.push({ task, assignment });
    }
  }
  return rows.sort((a, b) => {
    const ta = Date.parse(a.assignment.blockerReportedAt || "") || 0;
    const tb = Date.parse(b.assignment.blockerReportedAt || "") || 0;
    return tb - ta;
  });
}

function assignmentEmployeeName(task, assignment) {
  const email = String(assignment?.email || "").trim();
  const profiles = [
    ...(Array.isArray(task?.assigneeProfiles) ? task.assigneeProfiles : []),
    task?.assigneeProfile,
  ].filter(Boolean);
  const profile = profiles.find(
    (p) =>
      String(p.email || "").toLowerCase() === email.toLowerCase()
  );
  const name = String(profile?.name || "").trim();
  if (name && !name.includes("@")) return name;
  return personLabel([], email).name;
}

function blockerRowKey(task, assignment) {
  return `${task?.taskId || ""}|${String(assignment?.email || "").toLowerCase()}`;
}

export default function Blockers() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [resolveError, setResolveError] = useState("");
  const [pending, setPending] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const list = await fetchTasks();
      setTasks(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err.message || "Failed to load blockers.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => collectActiveBlockers(tasks), [tasks]);

  const closeResolveModal = () => {
    if (saving) return;
    setPending(null);
    setResolveError("");
  };

  const handleResolve = async () => {
    if (!pending) return;
    const taskId = pending.task.taskId;
    const assignmentEmail = pending.assignment.email;
    setSaving(true);
    setResolveError("");
    try {
      await resolveTaskBlocker(taskId, assignmentEmail);
      setPending(null);
      await load({ silent: true });
    } catch (err) {
      setResolveError(err.message || "Failed to resolve blocker.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Layout>
      <div style={{ ...pageCard, maxWidth: "100%" }}>
        <h2 style={pageTitle}>Blockers</h2>
        <p style={pageSubtitle}>
          Unresolved assignment blockers. Task status is unchanged when a
          blocker is reported or resolved.
        </p>

        {loading ? (
          <p style={{ color: colors.textMuted }}>Loading blockers...</p>
        ) : error ? (
          <div className="dgv-alert dgv-alert--error">{error}</div>
        ) : rows.length === 0 ? (
          <div>
            <p style={{ margin: "0 0 6px", fontWeight: 700 }}>
              No active blockers
            </p>
            <p style={{ margin: 0, color: colors.textMuted }}>
              Employees have no unresolved blockers right now.
            </p>
          </div>
        ) : (
          <>
            <p style={{ margin: "0 0 12px", color: colors.textMuted }}>
              {rows.length} active blocker{rows.length === 1 ? "" : "s"}
            </p>
            <div className="dgv-table-wrap" style={{ overflowX: "auto" }}>
              <table className="dgv-table" style={{ minWidth: 880, width: "100%" }}>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Employee</th>
                    <th>Blocker remark</th>
                    <th>Reported</th>
                    <th>Status</th>
                    <th>Zone</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ task, assignment }) => {
                    const employee = assignmentEmployeeName(task, assignment);
                    const statusText = statusLabel(
                      assignment.status || task.status
                    );
                    return (
                      <tr key={blockerRowKey(task, assignment)}>
                        <td style={{ wordBreak: "break-word" }}>
                          <div style={{ fontWeight: 700 }}>
                            {task.title || task.taskId}
                          </div>
                          {task.projectName ? (
                            <div
                              style={{
                                fontSize: 12,
                                color: colors.textMuted,
                                marginTop: 4,
                              }}
                            >
                              {task.projectName}
                            </div>
                          ) : null}
                        </td>
                        <td style={{ wordBreak: "break-word" }}>
                          <div>{employee}</div>
                          <div
                            style={{
                              fontSize: 12,
                              color: colors.textMuted,
                              marginTop: 4,
                            }}
                          >
                            {assignment.email}
                          </div>
                        </td>
                        <td style={{ wordBreak: "break-word", whiteSpace: "pre-wrap" }}>
                          {assignment.blockerRemark || "—"}
                        </td>
                        <td>
                          {formatTaskDateTime(assignment.blockerReportedAt)}
                        </td>
                        <td>{statusText}</td>
                        <td>
                          {assignment.zone ? (
                            <ZoneBadge
                              zone={assignment.zone}
                              status={assignment.status}
                            />
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>
                          <div
                            style={{
                              display: "flex",
                              gap: 8,
                              flexWrap: "wrap",
                            }}
                          >
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() =>
                                navigate(
                                  `/admin/tasks/${encodeURIComponent(task.taskId)}`
                                )
                              }
                            >
                              View Task
                            </Button>
                            <Button
                              type="button"
                              onClick={() => {
                                setResolveError("");
                                setPending({ task, assignment });
                              }}
                            >
                              Resolve Blocker
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {pending ? (
        <Modal title="Resolve Blocker?" onClose={closeResolveModal}>
          <p style={{ margin: 0 }}>
            Resolve the blocker reported by{" "}
            {assignmentEmployeeName(pending.task, pending.assignment)}?
          </p>
          {resolveError ? (
            <p
              className="dgv-alert dgv-alert--error"
              style={{ marginTop: 12 }}
            >
              {resolveError}
            </p>
          ) : null}
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              marginTop: 16,
            }}
          >
            <Button
              type="button"
              variant="outline"
              onClick={closeResolveModal}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              loading={saving}
              disabled={saving}
              onClick={handleResolve}
            >
              Resolve Blocker
            </Button>
          </div>
        </Modal>
      ) : null}
    </Layout>
  );
}
