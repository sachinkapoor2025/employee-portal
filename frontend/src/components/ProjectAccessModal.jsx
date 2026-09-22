import { useEffect, useState } from "react";
import Modal from "./ui/Modal";
import ProjectMemberPicker from "./ProjectMemberPicker";
import { fetchUsers, updateProject } from "../services/api";
import { colors, formLabel } from "../theme";
import { personLabel, selectableTaskAssignees } from "../utils/taskStatus";
import {
  normalizeMemberEmail,
  projectAccessModeLabel,
} from "../utils/workProjectManage";

export default function ProjectAccessModal({
  open = false,
  project = null,
  onClose,
  onChanged,
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [access, setAccess] = useState(null);
  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [addEmails, setAddEmails] = useState([]);

  const projectId = project?.projectId || "";

  const load = async () => {
    if (!projectId) return;
    setLoading(true);
    setError("");
    try {
      const listed = await updateProject(projectId, {
        access: { action: "list", includeRevoked: true },
      });
      setAccess(listed);
    } catch (err) {
      setAccess(null);
      setError(err?.message || "Unable to load project access.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open || !projectId) return;
    setAddEmails([]);
    load().catch(console.error);
  }, [open, projectId]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setUsersLoading(true);
    fetchUsers()
      .then((list) => {
        if (!cancelled) setUsers(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setUsers([]);
      })
      .finally(() => {
        if (!cancelled) setUsersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const runAction = async (action, email) => {
    if (!projectId || saving) return;
    setSaving(true);
    setError("");
    try {
      const listed = await updateProject(projectId, {
        access: { action, email, includeRevoked: true },
      });
      setAccess(listed);
      setAddEmails((prev) =>
        prev.filter((value) => normalizeMemberEmail(value) !== normalizeMemberEmail(email))
      );
      onChanged?.(listed);
    } catch (err) {
      setError(err?.message || "Unable to update project access.");
    } finally {
      setSaving(false);
    }
  };

  const addSelected = async () => {
    if (!projectId || saving) return;
    const existing = new Set(
      (access?.members || []).map((row) => normalizeMemberEmail(row.email))
    );
    const next = addEmails.filter(
      (email) => !existing.has(normalizeMemberEmail(email))
    );
    if (!next.length) {
      setError("Select at least one employee to add.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      let listed = access;
      for (const email of next) {
        listed = await updateProject(projectId, {
          access: { action: "addMember", email, includeRevoked: true },
        });
      }
      setAccess(listed);
      setAddEmails([]);
      onChanged?.(listed);
    } catch (err) {
      setError(err?.message || "Unable to update project access.");
    } finally {
      setSaving(false);
    }
  };

  const members = access?.members || [];
  const admins = access?.projectAdmins || [];
  const addable = selectableTaskAssignees(users).filter((user) => {
    const email = normalizeMemberEmail(user.email);
    return !members.some(
      (row) => normalizeMemberEmail(row.email) === email
    );
  });

  return (
    <Modal
      open={open}
      title={project?.name ? `Manage Access — ${project.name}` : "Manage Access"}
      closeDisabled={saving}
      onClose={() => {
        if (saving) return;
        onClose?.();
      }}
      footer={
        <button
          type="button"
          className="dgv-btn dgv-btn--outline"
          disabled={saving}
          onClick={() => {
            if (saving) return;
            onClose?.();
          }}
        >
          Close
        </button>
      }
    >
      {error ? (
        <div className="dgv-alert dgv-alert--error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      ) : null}
      <p style={{ margin: "0 0 16px", color: colors.textMuted, fontSize: 14 }}>
        Access: {projectAccessModeLabel(access?.accessMode || project?.accessMode)}
      </p>
      {loading ? (
        <p style={{ color: colors.textMuted }}>Loading access...</p>
      ) : (
        <>
          <h3 style={{ ...formLabel, marginBottom: 8 }}>Project Admins</h3>
          {admins.length === 0 ? (
            <p style={{ color: colors.textMuted, fontSize: 13 }}>No Project Admins listed.</p>
          ) : (
            <ul style={{ margin: "0 0 16px", paddingLeft: 18, fontSize: 14 }}>
              {admins.map((row) => (
                <li key={`admin-${row.email}`}>
                  {personLabel(users, row.email).name} ({row.email})
                  {row.active ? "" : " — revoked"}
                </li>
              ))}
            </ul>
          )}
          <h3 style={{ ...formLabel, marginBottom: 8 }}>Members</h3>
          {members.length === 0 ? (
            <p style={{ color: colors.textMuted, fontSize: 13 }}>No members yet.</p>
          ) : (
            <ul style={{ listStyle: "none", margin: "0 0 16px", padding: 0 }}>
              {members.map((row) => (
                <li
                  key={`member-${row.email}`}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                    alignItems: "center",
                    padding: "6px 0",
                    borderBottom: "1px solid var(--dgv-border)",
                    fontSize: 14,
                  }}
                >
                  <span>
                    {personLabel(users, row.email).name} ({row.email})
                    <span style={{ color: colors.textMuted, marginLeft: 8 }}>
                      {row.active ? "Active" : row.status || "Revoked"}
                    </span>
                  </span>
                  {row.active ? (
                    <button
                      type="button"
                      className="dgv-btn dgv-btn--outline"
                      disabled={saving}
                      onClick={() => runAction("revokeMember", row.email)}
                    >
                      Revoke
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="dgv-btn dgv-btn--outline"
                      disabled={saving}
                      onClick={() => runAction("reactivateMember", row.email)}
                    >
                      Reactivate
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <ProjectMemberPicker
            users={addable}
            loading={usersLoading}
            selectedEmails={addEmails}
            disabled={saving}
            onChange={setAddEmails}
          />
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              className="dgv-btn dgv-btn--primary"
              disabled={saving}
              onClick={addSelected}
            >
              {saving ? "Saving..." : "Add members"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
