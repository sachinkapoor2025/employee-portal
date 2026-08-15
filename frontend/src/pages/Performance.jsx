import { useEffect, useState } from "react";
import { api } from "../services/api";
import Layout from "../components/Layout";
import { pageCard, pageTitle, colors } from "../theme";

const FALLBACK = {
  chargedHours: 40,
  completedHours: 32,
  rating: "Good Performer",
  trainingPoints: 0,
};

export default function Performance() {
  const [data, setData] = useState(FALLBACK);

  useEffect(() => {
    let cancelled = false;
    api("/performance")
      .then((res) => {
        if (!cancelled) setData(res || FALLBACK);
      })
      .catch((err) => {
        console.warn("Performance load failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>Performance</h2>
        <p style={{ color: colors.text }}>Charged Hours: {data.chargedHours}</p>
        <p style={{ color: colors.text }}>Completed Hours: {data.completedHours}</p>
        <p style={{ color: colors.text }}>Rating: {data.rating}</p>
        <p style={{ color: colors.text }}>Training Points: {data.trainingPoints}</p>
      </div>
    </Layout>
  );
}
