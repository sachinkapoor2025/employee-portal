import { useEffect, useState } from "react";
import { api } from "../services/api";

export default function Training() {
  const [trainings, setTrainings] = useState([]);

  useEffect(() => {
    api("/training").then(setTrainings);
  }, []);

  return (
    <div>
      <h2>Training</h2>
      {trainings.map(t => (
        <div key={t.id}>
          {t.title} - {t.progress}%
        </div>
      ))}
    </div>
  );
}
