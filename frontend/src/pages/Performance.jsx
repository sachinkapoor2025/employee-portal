import { useEffect, useState } from "react";
import { api } from "../services/api";
import Layout from "../components/Layout";
import { pageCard, pageTitle, colors } from "../theme";

export default function Performance() {
  const [data, setData] = useState({});
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api("/performance")
      .then((res) => {
        if (!cancelled) setData(res || {});
      })
      .catch((err) => {
        console.warn("Performance load failed:", err);
        if (!cancelled) {
          setError(
            err?.message || "Unable to load performance data right now."
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>Performance</h2>
        {error ? (
          <div className="dgv-alert dgv-alert--error">{error}</div>
        ) : null}
        <p style={{ color: colors.text }}>Charged Hours: {data.chargedHours}</p>
        <p style={{ color: colors.text }}>Completed Hours: {data.completedHours}</p>
        <p style={{ color: colors.text }}>Rating: {data.rating}</p>
        <p style={{ color: colors.text }}>Training Points: {data.trainingPoints}</p>
      </div>
    </Layout>
  );
}
