import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Layout from "../../components/Layout";
import Button from "../../components/ui/Button";
import {
  createDepartment,
  fetchAdminDepartments,
  setDepartmentStatus,
  updateDepartment,
} from "../../services/api";
import {
  alertError,
  alertSuccess,
  colors,
  formInput,
  formLabel,
  pageCard,
  pageSubtitle,
  pageTitle,
} from "../../theme";

const EMPTY = { name: "", description: "" };

export default function ManageDepartments() {
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [statusBusy, setStatusBusy] = useState("");
  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetchAdminDepartments();
      setDepartments(Array.isArray(res?.departments) ? res.departments : []);
    } catch (err) {
      setDepartments([]);
      setError(err?.message || "Unable to load departments.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return departments;
    return departments.filter((row) =>
      String(row.name || "").toLowerCase().includes(query)
    );
  }, [departments, search]);

  const startCreate = () => {
    setEditingId("");
    setForm(EMPTY);
    setMessage("");
    setError("");
  };

  const startEdit = (row) => {
    setEditingId(row.departmentId);
    setForm({ name: row.name || "", description: row.description || "" });
    setMessage("");
    setError("");
  };

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      if (editingId) {
        await updateDepartment(editingId, form);
        setMessage("Department updated.");
      } else {
        await createDepartment(form);
        setMessage("Department created.");
        setForm(EMPTY);
      }
      await load();
    } catch (err) {
      setError(err?.message || "Unable to save department.");
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (row) => {
    const next = String(row.status).toUpperCase() === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    setStatusBusy(row.departmentId);
    setError("");
    setMessage("");
    try {
      await setDepartmentStatus(row.departmentId, next);
      setMessage(next === "ACTIVE" ? "Department activated." : "Department deactivated.");
      await load();
    } catch (err) {
      setError(err?.message || "Unable to update department status.");
    } finally {
      setStatusBusy("");
    }
  };

  return (
    <Layout>
      <h1 style={pageTitle}>Departments</h1>
      <p style={pageSubtitle}>
        Maintain the department catalog. Employees can belong to more than one
        department. Deactivate retires a department without deleting its ID, so
        existing employee assignments and later designation references stay intact.
      </p>
      {error ? (
        <div className="dgv-alert dgv-alert--error" style={{ ...alertError, marginBottom: 16 }}>
          {error}
        </div>
      ) : null}
      {message ? (
        <div style={{ ...alertSuccess, marginBottom: 16 }}>{message}</div>
      ) : null}
      <div style={pageCard}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>
          {editingId ? "Edit department" : "Add department"}
        </h2>
        <form onSubmit={save} style={{ display: "grid", gap: 12, maxWidth: 640 }}>
          <label style={formLabel} htmlFor="department-name">
            Name
            <input
              id="department-name"
              style={formInput}
              value={form.name}
              onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))}
              required
            />
          </label>
          <label style={formLabel} htmlFor="department-description">
            Description
            <textarea
              id="department-description"
              style={{ ...formInput, minHeight: 80 }}
              value={form.description}
              onChange={(e) =>
                setForm((current) => ({ ...current, description: e.target.value }))
              }
            />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <Button type="submit" loading={saving}>
              {editingId ? "Save department" : "Create department"}
            </Button>
            {editingId ? (
              <Button type="button" variant="ghost" onClick={startCreate}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      </div>
      <div style={{ ...pageCard, marginTop: 16 }}>
        <label style={formLabel} htmlFor="department-search">
          Search
          <input
            id="department-search"
            type="search"
            style={formInput}
            value={search}
            placeholder="Search by name"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        {loading ? (
          <p style={{ color: colors.textMuted }}>Loading departments…</p>
        ) : visible.length === 0 ? (
          <p style={{ color: colors.textMuted }}>No departments found.</p>
        ) : (
          <div className="dgv-table-wrap" style={{ marginTop: 12 }}>
            <table className="dgv-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Description</th>
                  <th>Employees</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.departmentId}>
                    <td>{row.name}</td>
                    <td>{row.description || "—"}</td>
                    <td>{row.employeeCount ?? 0}</td>
                    <td>{row.status}</td>
                    <td>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <Link to={`/admin/departments/${encodeURIComponent(row.departmentId)}`}>
                          Open
                        </Link>
                        <Button type="button" variant="ghost" onClick={() => startEdit(row)}>
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          loading={statusBusy === row.departmentId}
                          onClick={() => toggleStatus(row)}
                        >
                          {String(row.status).toUpperCase() === "ACTIVE"
                            ? "Deactivate"
                            : "Activate"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  );
}
