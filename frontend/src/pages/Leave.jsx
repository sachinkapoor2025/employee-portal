import { useEffect, useState } from "react";
import Layout from "../components/Layout";
import { fetchMyLeave, applyLeave } from "../services/api";
import {
  colors,
  pageCard,
  pageTitle,
  formLabel,
  formInput,
  formSelect,
  buttonPrimary,
  alertSuccess,
} from "../theme";

export default function Leave() {
  const [leaves, setLeaves] = useState([]);
  const [form, setForm] = useState({ fromDate: "", toDate: "", type: "CASUAL", reason: "" });
  const [msg, setMsg] = useState("");

  const load = () => fetchMyLeave().then(setLeaves).catch(console.error);

  useEffect(() => {
    load();
  }, []);

  const submit = async () => {
    await applyLeave(form);
    setForm({ fromDate: "", toDate: "", type: "CASUAL", reason: "" });
    setMsg("Leave request submitted!");
    load();
  };

  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>Leave Management</h2>

        <label style={formLabel}>From</label>
        <input type="date" style={formInput} value={form.fromDate} onChange={(e) => setForm({ ...form, fromDate: e.target.value })} />
        <label style={formLabel}>To</label>
        <input type="date" style={formInput} value={form.toDate} onChange={(e) => setForm({ ...form, toDate: e.target.value })} />
        <label style={formLabel}>Type</label>
        <select style={formSelect} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
          <option value="CASUAL">Casual</option>
          <option value="SICK">Sick</option>
          <option value="EARNED">Earned</option>
        </select>
        <label style={formLabel}>Reason</label>
        <textarea style={{ ...formInput, minHeight: 60 }} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        <button style={buttonPrimary} onClick={submit}>Submit Request</button>
        {msg && <div style={alertSuccess}>{msg}</div>}

        <h3 style={{ marginTop: 24 }}>My Requests</h3>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: colors.primary, color: "#fff" }}>
              <th style={{ padding: 8, textAlign: "left" }}>From</th>
              <th style={{ padding: 8, textAlign: "left" }}>To</th>
              <th style={{ padding: 8, textAlign: "left" }}>Type</th>
              <th style={{ padding: 8, textAlign: "left" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {leaves.map((l) => (
              <tr key={l.leaveId} style={{ borderBottom: `1px solid ${colors.border}` }}>
                <td style={{ padding: 8 }}>{l.fromDate}</td>
                <td style={{ padding: 8 }}>{l.toDate}</td>
                <td style={{ padding: 8 }}>{l.type}</td>
                <td style={{ padding: 8 }}>{l.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}
