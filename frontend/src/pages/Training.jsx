import { useEffect, useState } from "react";
import { api } from "../services/api";
import Layout from "../components/Layout";

export default function Training() {
  const [trainings, setTrainings] = useState([]);

  useEffect(() => {
    api("/training").then(setTrainings);
  }, []);

  return (
    <Layout>
      <div style={{ backgroundColor: "rgba(255,255,255,0.9)", padding: "24px", borderRadius: "12px" }}>
        <h2>Training</h2>
        {trainings.map(t => (
          <div key={t.id} style={{ margin: "10px 0", padding: "10px", border: "1px solid #ddd", borderRadius: "4px" }}>
            {t.title} - {t.progress}%
          </div>
        ))}
      </div>
    </Layout>
  );
}
