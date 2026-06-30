import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import { fetchAnnouncements, createAnnouncement, deleteAnnouncement } from "../../services/api";
import { colors, pageCard, pageTitle, formLabel, formInput, buttonPrimary } from "../../theme";

export default function AdminAnnouncements() {
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({ title: "", message: "" });

  const load = () => fetchAnnouncements().then(setItems).catch(console.error);

  useEffect(() => {
    load();
  }, []);

  const submit = async () => {
    await createAnnouncement(form);
    setForm({ title: "", message: "" });
    load();
  };

  const remove = async (id) => {
    await deleteAnnouncement(id);
    load();
  };

  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>Announcements</h2>
        <label style={formLabel}>Title</label>
        <input style={formInput} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <label style={formLabel}>Message</label>
        <textarea style={{ ...formInput, minHeight: 80 }} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
        <button style={buttonPrimary} onClick={submit}>Publish</button>

        <h3 style={{ marginTop: 24 }}>Published</h3>
        {items.map((a) => (
          <div key={a.announceId} style={{ background: colors.background, padding: 16, borderRadius: 8, marginBottom: 10 }}>
            <strong>{a.title}</strong>
            <p style={{ margin: "8px 0", color: colors.textMuted }}>{a.message}</p>
            <button style={{ fontSize: 12, color: colors.error, border: "none", background: "none", cursor: "pointer" }} onClick={() => remove(a.announceId)}>Delete</button>
          </div>
        ))}
      </div>
    </Layout>
  );
}
