import { useEffect, useState } from "react";
import { api } from "../services/api";
import Layout from "../components/Layout";

export default function Work() {
  const [tasks, setTasks] = useState([]);

  useEffect(() => {
    api("/work").then(setTasks);
  }, []);

  return (
    <Layout>
      <div style={{ backgroundColor: "rgba(255,255,255,0.9)", padding: "24px", borderRadius: "12px" }}>
        <h2>Work Pool</h2>
        {tasks.map(t => (
          <div key={t.id} style={{ margin: "10px 0", padding: "10px", border: "1px solid #ddd", borderRadius: "4px" }}>
            {t.description} ({t.hours} hrs)
            <button style={{ marginLeft: "10px", padding: "5px 10px", backgroundColor: "#1976d2", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Assign</button>
          </div>
        ))}
      </div>
    </Layout>
  );
}
