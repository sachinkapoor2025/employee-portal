import { useEffect, useState } from "react";
import Layout from "../components/Layout";
import { fetchTasks, updateTask, logTimeEntry } from "../services/api";
import {
  colors,
  pageCard,
  pageTitle,
  formLabel,
  formInput,
  buttonPrimary,
} from "../theme";

const STATUSES = ["TODO", "IN_PROGRESS", "REVIEW", "DONE"];

export default function Work() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [timeForm, setTimeForm] = useState({ taskId: "", minutes: "", note: "" });

  const load = () =>
    fetchTasks({ mine: "true" })
      .then(setTasks)
      .catch(console.error)
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
  }, []);

  const changeStatus = async (task, status) => {
    await updateTask({ taskId: task.taskId, projectId: task.projectId, status });
    load();
  };

  const logTime = async () => {
    if (!timeForm.taskId || !timeForm.minutes) return;
    const task = tasks.find((t) => t.taskId === timeForm.taskId);
    await logTimeEntry({
      taskId: timeForm.taskId,
      projectId: task?.projectId,
      minutes: Number(timeForm.minutes),
      note: timeForm.note,
    });
    setTimeForm({ taskId: "", minutes: "", note: "" });
    alert("Time logged!");
  };

  if (loading) {
    return (
      <Layout>
        <div style={pageCard}><p>Loading tasks...</p></div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>My Tasks</h2>

        {tasks.length === 0 ? (
          <p style={{ color: colors.textMuted }}>No tasks assigned yet. Your admin will assign tasks from Manage Tasks.</p>
        ) : (
          tasks.map((task) => (
            <div
              key={task.taskId}
              style={{
                border: `1px solid ${colors.border}`,
                borderRadius: 10,
                padding: 16,
                marginBottom: 12,
              }}
            >
              <div style={{ fontWeight: 700 }}>{task.title}</div>
              <p style={{ color: colors.textMuted, fontSize: 14 }}>{task.description}</p>
              <div style={{ fontSize: 13, marginBottom: 8 }}>
                Priority: {task.priority} | Due: {task.dueDate || "—"}
              </div>
              <select
                value={task.status || "TODO"}
                onChange={(e) => changeStatus(task, e.target.value)}
                style={{ padding: 6, borderRadius: 6 }}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>{s.replace("_", " ")}</option>
                ))}
              </select>
            </div>
          ))
        )}

        <h3 style={{ marginTop: 24 }}>Log Time on Task</h3>
        <label style={formLabel}>Task</label>
        <select
          style={formInput}
          value={timeForm.taskId}
          onChange={(e) => setTimeForm({ ...timeForm, taskId: e.target.value })}
        >
          <option value="">Select task</option>
          {tasks.map((t) => (
            <option key={t.taskId} value={t.taskId}>{t.title}</option>
          ))}
        </select>
        <label style={formLabel}>Minutes</label>
        <input
          type="number"
          style={formInput}
          value={timeForm.minutes}
          onChange={(e) => setTimeForm({ ...timeForm, minutes: e.target.value })}
        />
        <label style={formLabel}>Note</label>
        <input
          style={formInput}
          value={timeForm.note}
          onChange={(e) => setTimeForm({ ...timeForm, note: e.target.value })}
        />
        <button style={buttonPrimary} onClick={logTime}>Log Time</button>
      </div>
    </Layout>
  );
}
