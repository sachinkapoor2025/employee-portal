import { useEffect, useState } from "react";
import { api } from "../services/api";

export default function Performance() {
  const [data, setData] = useState({});

  useEffect(() => {
    api("/performance").then(setData);
  }, []);

  return (
    <div>
      <h2>Performance</h2>
      <p>Charged: {data.chargedHours}</p>
      <p>Completed: {data.completedHours}</p>
      <p>Rating: {data.rating}</p>
    </div>
  );
}
