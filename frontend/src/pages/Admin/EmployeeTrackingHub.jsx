import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Layout from "../../components/Layout";
import Button from "../../components/ui/Button";
import { fetchUsers, fetchUserProfile, fetchDepartments } from "../../services/api";
import { formatDepartmentList } from "../../utils/departmentMembership";
import { colors, pageCard, pageTitle, pageSubtitle } from "../../theme";

/** Overview entry — pick an employee to open Phase 1 tracking shell. */
export default function EmployeeTrackingHub() {
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [data, departmentRes] = await Promise.all([
          fetchUsers(),
          fetchDepartments().catch(() => ({ departments: [] })),
        ]);
        const list = Array.isArray(data) ? data : [];
        const catalog = Array.isArray(departmentRes?.departments)
          ? departmentRes.departments
          : [];
        const enriched = await Promise.all(
          list.map(async (u) => {
            const email = String(u.email || "").toLowerCase();
            try {
              const profile = await fetchUserProfile(email);
              const department = formatDepartmentList(
                {
                  departmentIds: Array.isArray(profile?.departmentIds)
                    ? profile.departmentIds
                    : u.departmentIds,
                  primaryDepartmentId:
                    profile?.primaryDepartmentId || u.primaryDepartmentId || "",
                },
                catalog
              ).join(", ");
              return {
                ...u,
                email,
                name: profile?.name || u.name || "",
                empId: profile?.empId || u.empId || "",
                department,
              };
            } catch {
              return {
                ...u,
                email,
                department: formatDepartmentList(u, catalog).join(", "),
              };
            }
          })
        );
        if (!cancelled) setUsers(enriched);
      } catch (err) {
        console.error(err);
        if (!cancelled) setUsers([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = !q
    ? users
    : users.filter((u) =>
        [u.name, u.email, u.empId, u.department]
          .join(" ")
          .toLowerCase()
          .includes(q)
      );

  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>Employee Tracking</h2>
        <p style={pageSubtitle}>
          Select an employee to open their tracking profile. Detailed tabs
          (attendance, tasks, activity) expand in Phase 3.
        </p>

        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search employees…"
          className="dgv-input"
          style={{ marginBottom: 16, maxWidth: 360 }}
          aria-label="Search employees"
        />

        {loading ? (
          <p style={{ color: colors.textMuted }}>Loading…</p>
        ) : (
          <div className="dgv-table-wrap">
            <table className="dgv-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Department</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => (
                  <tr key={u.email}>
                    <td>{u.empId || "—"}</td>
                    <td>{u.name || "—"}</td>
                    <td>{u.email}</td>
                    <td>{u.department || "—"}</td>
                    <td>
                      <Button
                        type="button"
                        onClick={() =>
                          navigate(
                            `/admin/employees/${encodeURIComponent(u.email)}/track`
                          )
                        }
                      >
                        Track
                      </Button>
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
