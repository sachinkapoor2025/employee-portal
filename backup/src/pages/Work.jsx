import { useEffect, useState } from "react";
import { api } from "../services/api";

export default function Work() {
  const [tasks, setTasks] = useState([]);

  useEffect(() => {
    api("/work").then(setTasks);
  }, []);

  return (
    <div>
      <h2>Work Pool</h2>
      {tasks.map(t => (
        <div key={t.id}>
          {t.description} ({t.hours} hrs)
          <button>Assign</button>
        </div>
      ))}
    </div>
  );
}
