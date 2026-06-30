import { useEffect, useState } from "react";
import Layout from "../components/Layout";
import { fetchAgentDownload } from "../services/api";
import { colors, pageCard, pageTitle, buttonPrimary } from "../theme";

export default function Downloads() {
  const [info, setInfo] = useState(null);

  useEffect(() => {
    fetchAgentDownload().then(setInfo).catch(console.error);
  }, []);

  return (
    <Layout>
      <div style={{ ...pageCard, maxWidth: 560 }}>
        <h2 style={pageTitle}>Downloads</h2>
        <p style={{ color: colors.textMuted, lineHeight: 1.6 }}>
          DGV Work Tracker (Windows) runs in your system tray, syncs in the background,
          and works on slow networks — it queues data locally and uploads when connected.
        </p>

        <div style={{ background: colors.background, borderRadius: 12, padding: 20, marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>DGV Work Tracker</h3>
          <p style={{ fontSize: 14, color: colors.textMuted }}>{info?.message}</p>
          {info?.available ? (
            <a href={info.downloadUrl} style={{ textDecoration: "none" }}>
              <button style={buttonPrimary}>Download {info.fileName}</button>
            </a>
          ) : (
            <button style={{ ...buttonPrimary, opacity: 0.6 }} disabled>
              Coming Soon
            </button>
          )}
          <ul style={{ fontSize: 13, color: colors.textMuted, marginTop: 16 }}>
            <li>Auto check-in when you start your PC</li>
            <li>Offline queue — no blocking on slow network</li>
            <li>Syncs with your portal attendance & activity</li>
          </ul>
        </div>
      </div>
    </Layout>
  );
}
