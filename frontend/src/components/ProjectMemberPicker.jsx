import { useMemo, useState } from "react";
import { formInput, formLabel } from "../theme";
import { personLabel, selectableTaskAssignees } from "../utils/taskStatus";
import { normalizeMemberEmail } from "../utils/workProjectManage";

export default function ProjectMemberPicker({
  users = [],
  loading = false,
  loadError = "",
  selectedEmails = [],
  onChange,
  disabled = false,
  excludeEmails = [],
}) {
  const [search, setSearch] = useState("");
  const selected = useMemo(
    () => uniqueSelected(selectedEmails),
    [selectedEmails]
  );

  const options = useMemo(() => {
    const excluded = new Set(
      (excludeEmails || []).map((email) => normalizeMemberEmail(email)).filter(Boolean)
    );
    const q = search.trim().toLowerCase();
    return selectableTaskAssignees(users)
      .filter((user) => {
        const email = normalizeMemberEmail(user.email);
        if (!email || excluded.has(email)) return false;
        if (!q) return true;
        const name = String(user.name || "").toLowerCase();
        return email.includes(q) || name.includes(q);
      })
      .sort((a, b) =>
        String(a.name || a.email).localeCompare(String(b.name || b.email))
      );
  }, [users, search, excludeEmails]);

  const toggle = (email) => {
    if (disabled) return;
    const next = normalizeMemberEmail(email);
    if (!next) return;
    if (selected.includes(next)) {
      onChange?.(selected.filter((value) => value !== next));
      return;
    }
    onChange?.([...selected, next]);
  };

  const remove = (email) => {
    if (disabled) return;
    const next = normalizeMemberEmail(email);
    onChange?.(selected.filter((value) => value !== next));
  };

  return (
    <div>
      <label style={formLabel}>Employees</label>
      {selected.length ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 12,
          }}
        >
          {selected.map((email) => {
            const label = personLabel(users, email);
            return (
              <span key={email} className="dgv-badge dgv-badge--info">
                {label.name}
                <button
                  type="button"
                  className="dgv-btn dgv-btn--ghost"
                  style={{
                    marginLeft: 6,
                    padding: "0 4px",
                    minHeight: 0,
                    fontSize: 12,
                  }}
                  disabled={disabled}
                  aria-label={`Remove ${email}`}
                  onClick={() => remove(email)}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      ) : (
        <p style={{ color: "var(--dgv-text-muted)", fontSize: 13, margin: "0 0 12px" }}>
          Select one or more employees who can access this project.
        </p>
      )}
      <input
        style={{ ...formInput, marginBottom: 8 }}
        type="search"
        value={search}
        disabled={disabled || loading}
        placeholder="Search employees by name or email"
        aria-label="Search employees"
        onChange={(e) => setSearch(e.target.value)}
      />
      <div
        style={{
          maxHeight: 180,
          overflowY: "auto",
          border: "1px solid var(--dgv-border)",
          borderRadius: 10,
          padding: 8,
        }}
      >
        {loading ? (
          <p style={{ margin: 8, color: "var(--dgv-text-muted)", fontSize: 13 }}>
            Loading employees...
          </p>
        ) : loadError ? (
          <p style={{ margin: 8, color: "var(--dgv-danger)", fontSize: 13 }}>
            {loadError}
          </p>
        ) : options.length === 0 ? (
          <p style={{ margin: 8, color: "var(--dgv-text-muted)", fontSize: 13 }}>
            No employees found.
          </p>
        ) : (
          options.map((user) => {
            const email = normalizeMemberEmail(user.email);
            const checked = selected.includes(email);
            return (
              <label
                key={email}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  padding: "6px 8px",
                  fontSize: 14,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggle(email)}
                />
                <span>
                  {user.name || personLabel(users, email).name}
                  <span
                    style={{
                      color: "var(--dgv-text-muted)",
                      marginLeft: 6,
                      fontSize: 12,
                    }}
                  >
                    {email}
                  </span>
                </span>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}

function uniqueSelected(values) {
  const seen = new Set();
  const emails = [];
  for (const value of values || []) {
    const email = normalizeMemberEmail(value);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }
  return emails;
}
