import { useEffect, useState } from "react";
import { api } from "../services/api";
import Layout from "../components/Layout";

export default function Performance() {
  const [data, setData] = useState({});

  useEffect(() => {
    api("/performance").then(setData);
  }, []);

  return (
    <Layout>
      <div style={{ backgroundColor: "rgba(255,255,255,0.9)", padding: "24px", borderRadius: "12px" }}>
        <h2>Performance</h2>
        <p>Charged: {data.chargedHours}</p>
        <p>Completed: {data.completedHours}</p>
        <p>Rating: {data.rating}</p>
      </div>
    </Layout>
  );
}
