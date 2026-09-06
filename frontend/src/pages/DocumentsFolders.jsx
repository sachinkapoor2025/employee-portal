import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import Layout from "../components/Layout";
import ProjectsBrowser from "../components/documents/ProjectsBrowser";
import PersonalBrowser from "../components/documents/PersonalBrowser";
import { pageCard, pageSubtitle, pageTitle } from "../theme";

export default function DocumentsFolders() {
  const [params] = useSearchParams();
  const [tab, setTab] = useState(
    params.get("tab") === "personal" ? "personal" : "projects"
  );

  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>Documents</h2>
        <p style={pageSubtitle}>
          Browse company project folders and keep personal files organized.
        </p>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "4px 0 20px" }}>
          <button
            type="button"
            className={tab === "projects" ? "dgv-btn dgv-btn--primary" : "dgv-btn dgv-btn--ghost"}
            onClick={() => setTab("projects")}
            style={{ fontSize: 13 }}
          >
            Projects
          </button>
          <button
            type="button"
            className={tab === "personal" ? "dgv-btn dgv-btn--primary" : "dgv-btn dgv-btn--ghost"}
            onClick={() => setTab("personal")}
            style={{ fontSize: 13 }}
          >
            Personal
          </button>
        </div>

        {tab === "projects" ? <ProjectsBrowser /> : <PersonalBrowser />}
      </div>
    </Layout>
  );
}
