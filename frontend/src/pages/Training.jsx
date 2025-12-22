import { useEffect, useState } from "react";
import { api } from "../services/api";
import Layout from "../components/Layout";

export default function Training() {
  const [videos, setVideos] = useState([]);

  useEffect(() => {
    fetchVideos();
  }, []);

  const fetchVideos = () => {
    api("/training").then(setVideos);
  };

  const updateProgress = async (videoId, status, points) => {
    await fetch(`${process.env.REACT_APP_API_URL}/training`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: localStorage.getItem("token")
      },
      body: JSON.stringify({ videoId, status, points })
    });
    fetchVideos(); // refresh
  };

  const handleAction = (video) => {
    if (video.status === 'Not Started') {
      updateProgress(video.id, 'In Progress', 0);
    } else if (video.status === 'In Progress') {
      const points = video.category === 'Advanced' ? video.points : 0;
      updateProgress(video.id, 'Completed', points);
    }
  };

  const getButtonText = (status) => {
    if (status === 'Not Started') return 'Start';
    if (status === 'In Progress') return 'Mark Complete';
    return 'Completed';
  };

  const getButtonDisabled = (status) => status === 'Completed';

  // Group videos by category
  const grouped = videos.reduce((acc, v) => {
    if (!acc[v.category]) acc[v.category] = [];
    acc[v.category].push(v);
    return acc;
  }, {});

  const styles = {
    container: { backgroundColor: "rgba(255,255,255,0.9)", padding: "24px", borderRadius: "12px" },
    category: { marginBottom: "30px" },
    categoryTitle: { fontSize: "20px", fontWeight: "bold", marginBottom: "10px" },
    card: { border: "1px solid #ddd", borderRadius: "8px", padding: "16px", margin: "10px 0", backgroundColor: "#f9f9f9" },
    title: { fontSize: "18px", marginBottom: "8px" },
    categoryLabel: { display: "inline-block", padding: "4px 8px", borderRadius: "4px", fontSize: "12px", fontWeight: "bold" },
    basic: { backgroundColor: "#4caf50", color: "white" },
    learning: { backgroundColor: "#ff9800", color: "white" },
    advanced: { backgroundColor: "#f44336", color: "white" },
    status: { margin: "8px 0", fontWeight: "bold" },
    button: { padding: "8px 16px", backgroundColor: "#1976d2", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" },
    disabledButton: { backgroundColor: "#ccc", cursor: "not-allowed" }
  };

  return (
    <Layout>
      <div style={styles.container}>
        <h2>Training Videos</h2>
        {Object.keys(grouped).map(cat => (
          <div key={cat} style={styles.category}>
            <div style={styles.categoryTitle}>{cat} Training</div>
            {grouped[cat].map(video => (
              <div key={video.id} style={styles.card}>
                <div style={styles.title}>{video.title}</div>
                <span style={{ ...styles.categoryLabel, ...(styles[cat.toLowerCase()] || {}) }}>{cat}</span>
                <div style={styles.status}>Status: {video.status}</div>
                {video.category === 'Advanced' && video.status === 'Completed' && (
                  <div>Points Earned: {video.points}</div>
                )}
                <button
                  style={getButtonDisabled(video.status) ? styles.disabledButton : styles.button}
                  disabled={getButtonDisabled(video.status)}
                  onClick={() => handleAction(video)}
                >
                  {getButtonText(video.status)}
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Layout>
  );
}
