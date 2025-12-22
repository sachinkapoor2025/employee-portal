import { useEffect, useState } from "react";
import { api } from "../services/api";
import Layout from "../components/Layout";

export default function Work() {
  const [tasks, setTasks] = useState([]);
  const [basicCompleted, setBasicCompleted] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      const tasksData = await api("/work");
      setTasks(tasksData);

      const trainingData = await api("/training");
      const basicVideos = trainingData.filter(t => t.category === 'Basic');
      const allCompleted = basicVideos.every(t => t.status === 'Completed');
      setBasicCompleted(allCompleted);
    };
    fetchData();
  }, []);

  const styles = {
    container: { backgroundColor: "rgba(255,255,255,0.9)", padding: "24px", borderRadius: "12px" },
    task: { margin: "10px 0", padding: "10px", border: "1px solid #ddd", borderRadius: "4px" },
    button: { marginLeft: "10px", padding: "5px 10px", backgroundColor: "#1976d2", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" },
    disabledButton: { backgroundColor: "#ccc", cursor: "not-allowed" },
    warning: { color: "red", fontWeight: "bold", marginBottom: "20px" }
  };

  return (
    <Layout>
      <div style={styles.container}>
        <h2>Work Pool</h2>
        {!basicCompleted && (
          <div style={styles.warning}>You must complete all Basic trainings before assigning tasks.</div>
        )}
        {tasks.map(t => (
          <div key={t.id} style={styles.task}>
            {t.description} ({t.hours} hrs)
            <button
              style={basicCompleted ? styles.button : styles.disabledButton}
              disabled={!basicCompleted}
            >
              Assign
            </button>
          </div>
        ))}
      </div>
    </Layout>
  );
}
