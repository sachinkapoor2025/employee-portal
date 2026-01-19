import { useEffect, useState, useCallback, useMemo } from "react";
import Layout from "../components/Layout";
import { api, fetchUserTrainings } from "../services/api";

export default function Work() {
  const [tasks, setTasks] = useState([]);
  const [basicCompleted, setBasicCompleted] = useState(false);
  const [loading, setLoading] = useState(true);

  // TEMP – later fetch from profile / auth
  const userSkills = useMemo(() => ["AWS"], []);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);

      // =========================
      // FETCH WORK TASKS
      // =========================
      const tasksRes = await api("/work");
      const safeTasks = Array.isArray(tasksRes) ? tasksRes : [];
      setTasks(safeTasks);

      // =========================
      // FETCH TRAININGS (NEW FLOW)
      // =========================
      const trainingRes = await fetchUserTrainings(userSkills);
      const safeTrainings = Array.isArray(trainingRes) ? trainingRes : [];

      const basicTrainings = safeTrainings.filter((t) => t.level === "BASIC");

      const allCompleted =
        basicTrainings.length > 0 &&
        basicTrainings.every((t) => t.status === "Completed");

      setBasicCompleted(allCompleted);
    } catch (err) {
      console.error("Work page fetch failed:", err);
      setTasks([]);
      setBasicCompleted(false);
    } finally {
      setLoading(false);
    }
  }, [userSkills]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // =========================
  // STYLES (UNCHANGED)
  // =========================
  const styles = {
    container: {
      backgroundColor: "rgba(255,255,255,0.9)",
      padding: "24px",
      borderRadius: "12px",
    },
    task: {
      margin: "10px 0",
      padding: "10px",
      border: "1px solid #ddd",
      borderRadius: "4px",
    },
    button: {
      marginLeft: "10px",
      padding: "5px 10px",
      backgroundColor: "#1976d2",
      color: "white",
      border: "none",
      borderRadius: "4px",
      cursor: "pointer",
    },
    disabledButton: {
      backgroundColor: "#ccc",
      cursor: "not-allowed",
    },
    warning: {
      color: "red",
      fontWeight: "bold",
      marginBottom: "20px",
    },
  };

  return (
    <Layout>
      <div style={styles.container}>
        <h2>Work Pool</h2>

        {loading && <p>Loading work tasks...</p>}

        {!loading && !basicCompleted && (
          <div style={styles.warning}>
            You must complete all BASIC trainings before assigning tasks.
          </div>
        )}

        {!loading &&
          tasks.map((t) => (
            <div key={t.id || t.task_id} style={styles.task}>
              {t.description} ({t.hours} hrs)
              <button
                style={basicCompleted ? styles.button : styles.disabledButton}
                disabled={!basicCompleted}
              >
                Assign
              </button>
            </div>
          ))}

        {!loading && tasks.length === 0 && <p>No tasks available.</p>}
      </div>
    </Layout>
  );
}
