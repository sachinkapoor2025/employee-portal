import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Layout from "../../components/Layout";
import Button from "../../components/ui/Button";
import {
  createDepartmentDesignation,
  fetchAdminDepartmentDesignations,
  fetchAdminDepartments,
  setDepartmentDesignationStatus,
  updateDepartment,
  updateDepartmentDesignation,
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

export default function DepartmentDetail() {
  const { departmentId } = useParams();
  const [department, setDepartment] = useState(null);
  const [designations, setDesignations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [statusBusy, setStatusBusy] = useState("");
  const [editingDepartment, setEditingDepartment] = useState(false);
  const [departmentForm, setDepartmentForm] = useState({ name: "", description: "" });
  const [designationName, setDesignationName] = useState("");
  const [designationTrack, setDesignationTrack] = useState("");
  const [designationSort, setDesignationSort] = useState("");
  const [editingDesignationId, setEditingDesignationId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [departmentRes, designationRes] = await Promise.all([
        fetchAdminDepartments(),
        fetchAdminDepartmentDesignations(departmentId),
      ]);
      const found = (departmentRes?.departments || []).find(
        (row) => row.departmentId === departmentId
      );
      setDepartment(found || null);
      if (found) {
        setDepartmentForm({ name: found.name || "", description: found.description || "" });
      }
      setDesignations(
        Array.isArray(designationRes?.designations) ? designationRes.designations : []
      );
      if (!found) setError("Department not found.");
    } catch (err) {
      setDepartment(null);
      setDesignations([]);
      setError(err?.message || "Unable to load department.");
    } finally {
      setLoading(false);
    }
  }, [departmentId]);

  useEffect(() => {
    load();
  }, [load]);

  const saveDepartment = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await updateDepartment(departmentId, departmentForm);
      setEditingDepartment(false);
      setMessage("Department updated. The department ID is unchanged.");
      await load();
    } catch (err) {
      setError(err?.message || "Unable to update department.");
    } finally {
      setSaving(false);
    }
  };

  const saveDesignation = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      if (editingDesignationId) {
        await updateDepartmentDesignation(departmentId, editingDesignationId, {
          name: designationName,
          track: designationTrack,
          sortOrder: Number(designationSort) || 0,
        });
        setMessage("Designation updated. The designation ID is unchanged.");
      } else {
        await createDepartmentDesignation(departmentId, {
          name: designationName,
          track: designationTrack,
          sortOrder: Number(designationSort) || 0,
        });
        setMessage("Designation added to this department.");
      }
      setDesignationName("");
      setDesignationTrack("");
      setDesignationSort("");
      setEditingDesignationId("");
      await load();
    } catch (err) {
      setError(err?.message || "Unable to save designation.");
    } finally {
      setSaving(false);
    }
  };

  const toggleDesignation = async (row) => {
    const next = String(row.status).toUpperCase() === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    setStatusBusy(row.designationId);
    setError("");
    setMessage("");
    try {
      await setDepartmentDesignationStatus(departmentId, row.designationId, next);
      setMessage(
        next === "INACTIVE"
          ? "Designation deactivated. Existing assignments keep this ID and can be reviewed."
          : "Designation activated."
      );
      await load();
    } catch (err) {
      setError(err?.message || "Unable to update designation status.");
    } finally {
      setStatusBusy("");
    }
  };

  return (
    <Layout>
      <p style={pageSubtitle}>
        <Link to="/admin/departments">← Departments</Link>
      </p>
      {loading ? <p>Loading department…</p> : null}
      {error ? (
        <div className="dgv-alert dgv-alert--error" style={{ ...alertError, marginBottom: 16 }}>
          {error}
        </div>
      ) : null}
      {message ? (
        <div style={{ ...alertSuccess, marginBottom: 16 }}>{message}</div>
      ) : null}
      {department ? (
        <>
          <h1 style={pageTitle}>{department.name}</h1>
          <p style={pageSubtitle}>
            Department ID <code>{department.departmentId}</code> stays the same
            when the name changes. Status: {department.status}.{" "}
            {department.employeeCount ?? 0} employee
            {department.employeeCount === 1 ? "" : "s"}.
          </p>
          <div style={pageCard}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Department details</h2>
            {editingDepartment ? (
              <form onSubmit={saveDepartment} style={{ display: "grid", gap: 12, maxWidth: 640 }}>
                <label style={formLabel} htmlFor="detail-name">
                  Name
                  <input
                    id="detail-name"
                    style={formInput}
                    value={departmentForm.name}
                    onChange={(event) =>
                      setDepartmentForm((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
                <label style={formLabel} htmlFor="detail-description">
                  Description
                  <textarea
                    id="detail-description"
                    style={{ ...formInput, minHeight: 80 }}
                    value={departmentForm.description}
                    onChange={(event) =>
                      setDepartmentForm((current) => ({
                        ...current,
                        description: event.target.value,
                      }))
                    }
                  />
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <Button type="submit" loading={saving}>
                    Save department
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setEditingDepartment(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <>
                <p>{department.description || "No description."}</p>
                <Button type="button" variant="ghost" onClick={() => setEditingDepartment(true)}>
                  Edit department
                </Button>
              </>
            )}
          </div>
          <div style={{ ...pageCard, marginTop: 16 }}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Designations</h2>
            <p style={pageSubtitle}>
              Designations belong to this department and stay in senior-to-entry
              order inside each track. Deactivate instead of deleting so
              employee assignments and cost records keep a stable ID.
            </p>
            <form onSubmit={saveDesignation} style={{ display: "grid", gap: 12, maxWidth: 640 }}>
              <label style={formLabel} htmlFor="designation-track">
                Track
                <input
                  id="designation-track"
                  style={formInput}
                  value={designationTrack}
                  onChange={(event) => setDesignationTrack(event.target.value)}
                  required
                />
              </label>
              <label style={formLabel} htmlFor="designation-sort">
                Order within track
                <input
                  id="designation-sort"
                  style={formInput}
                  inputMode="numeric"
                  value={designationSort}
                  onChange={(event) => setDesignationSort(event.target.value)}
                />
              </label>
              <label style={formLabel} htmlFor="designation-name">
                {editingDesignationId ? "Edit designation" : "Add designation"}
                <input
                  id="designation-name"
                  style={formInput}
                  value={designationName}
                  onChange={(event) => setDesignationName(event.target.value)}
                  required
                />
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <Button type="submit" loading={saving}>
                  {editingDesignationId ? "Save designation" : "Add designation"}
                </Button>
                {editingDesignationId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setEditingDesignationId("");
                      setDesignationName("");
                      setDesignationTrack("");
                      setDesignationSort("");
                    }}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            </form>
            {designations.length === 0 ? (
              <p style={{ color: colors.textMuted }}>
                No designations for this department yet.
              </p>
            ) : (
              Object.entries(
                designations.reduce((groups, row) => {
                  const track = row.track || "Ungrouped";
                  if (!groups[track]) groups[track] = [];
                  groups[track].push(row);
                  return groups;
                }, {})
              ).map(([track, rows]) => (
              <div key={track} className="dgv-table-wrap" style={{ marginTop: 12 }}>
                <h3 style={{ marginBottom: 8, fontSize: 15 }}>{track}</h3>
                <table className="dgv-table">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Name</th>
                      <th>ID</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.designationId}>
                        <td>{row.sortOrder || "—"}</td>
                        <td>{row.name}</td>
                        <td>{row.designationId}</td>
                        <td>{row.status}</td>
                        <td>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => {
                                setEditingDesignationId(row.designationId);
                                setDesignationName(row.name || "");
                                setDesignationTrack(row.track || "");
                                setDesignationSort(
                                  row.sortOrder ? String(row.sortOrder) : ""
                                );
                              }}
                            >
                              Edit
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              loading={statusBusy === row.designationId}
                              onClick={() => toggleDesignation(row)}
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
              ))
            )}
          </div>
        </>
      ) : null}
    </Layout>
  );
}
