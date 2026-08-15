import { useEffect, useState } from "react";
import Layout from "../components/Layout";
import { fetchUserTrainings, fetchTrainingVideoUrl } from "../services/api";
import { pageCard, pageTitle, colors, buttonPrimary } from "../theme";

function normalizeLevel(level = "") {
  const value = level.toUpperCase();
  if (value.includes("BASIC") || value.includes("BEGINNER")) return "BASIC";
  if (value.includes("REGULAR") || value.includes("INTERMEDIATE")) return "REGULAR";
  if (value.includes("ADVANCED")) return "ADVANCED";
  return "OTHER";
}

export default function Training() {
  const [videos, setVideos] = useState([]);
  const [videoUrl, setVideoUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [showModal, setShowModal] = useState(false);
  const [activeVideo, setActiveVideo] = useState(null);
  const [videoCompleted, setVideoCompleted] = useState(false);

  useEffect(() => {
    loadTrainings();
  }, []);

  // ======================
  // FETCH TRAININGS
  // ======================
  const loadTrainings = async () => {
    try {
      setLoading(true);
      setError(null);

      const data = await fetchUserTrainings();

      if (!Array.isArray(data)) {
        throw new Error("Invalid response");
      }

      setVideos(
        data.map((v) => ({
          ...v,
          id: v.training_id,
          category: normalizeLevel(v.level),
          status: "Not Started",
        }))
      );
    } catch (err) {
      console.error("Training load failed:", err);
      setError("Unable to load trainings");
    } finally {
      setLoading(false);
    }
  };

  // ======================
  // START / WATCH AGAIN
  // ======================
  const handleStart = async (video) => {
    if (!video?.video_s3_key) return;

    try {
      setVideoCompleted(false);

      const res = await fetchTrainingVideoUrl(video.video_s3_key);
      setVideoUrl(res.url);
      setActiveVideo(video);
      setShowModal(true);

      if (video.status === "Not Started") {
        updateStatus(video.id, "In Progress");
      }
    } catch (err) {
      console.error(err);
      setError("Failed to load video");
    }
  };

  // ======================
  // COMPLETE
  // ======================
  const handleMarkComplete = () => {
    if (!activeVideo || !videoCompleted) return;
    updateStatus(activeVideo.id, "Completed");
    closeModal();
  };

  const updateStatus = (id, status) => {
    setVideos((prev) => prev.map((v) => (v.id === id ? { ...v, status } : v)));
  };

  const closeModal = () => {
    setShowModal(false);
    setVideoUrl(null);
    setActiveVideo(null);
    setVideoCompleted(false);
  };

  // ======================
  // GROUP BY LEVEL
  // ======================
  const grouped = videos.reduce((acc, v) => {
    acc[v.category] = acc[v.category] || [];
    acc[v.category].push(v);
    return acc;
  }, {});

  // ✅ FIXED ORDER (ONLY ADDITION)
  const levelOrder = ["BASIC", "REGULAR", "ADVANCED", "OTHER"];

  // ======================
  // RENDER
  // ======================
  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>Training Videos</h2>

        {loading && <p style={{ color: colors.textMuted }}>Loading trainings...</p>}
        {error && <p style={{ color: colors.error }}>{error}</p>}

        {!loading && !error && videos.length === 0 && (
          <p style={{ color: colors.textMuted }}>
            No training videos are assigned yet. Ask your admin to set your skill
            in Manage Users and add training materials for that skill.
          </p>
        )}

        {levelOrder.map(
          (level) =>
            grouped[level] && (
              <div key={level}>
                <h3 style={{ color: colors.text }}>{level} Training</h3>

                {grouped[level].map((video) => (
                  <div
                    key={video.id}
                    style={{
                      border: `1px solid ${colors.border}`,
                      borderRadius: 12,
                      padding: 16,
                      marginBottom: 12,
                      background: "var(--dgv-surface-solid)",
                      color: colors.text,
                      transition: "transform 0.3s ease, box-shadow 0.3s ease",
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{video.title}</div>
                    <div style={{ color: colors.textMuted }}>Status: {video.status}</div>

                    <button
                      onClick={() => handleStart(video)}
                      style={{
                        ...buttonPrimary,
                        marginTop: 8,
                      }}
                    >
                      {video.status === "Completed" ? "Watch Again" : "Start"}
                    </button>
                  </div>
                ))}
              </div>
            )
        )}
      </div>

      {/* VIDEO MODAL */}
      {showModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.85)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div style={{ width: "90%", maxWidth: 1000 }}>
            <button
              onClick={closeModal}
              style={{
                float: "right",
                background: "transparent",
                color: "#fff",
                fontSize: 28,
                border: "none",
                cursor: "pointer",
              }}
            >
              ✕
            </button>

            <video
              controls
              autoPlay
              controlsList="nodownload"
              onContextMenu={(e) => e.preventDefault()}
              onEnded={() => setVideoCompleted(true)}
              style={{ width: "100%", borderRadius: 8 }}
            >
              <source src={videoUrl} type="video/mp4" />
            </video>

            <div style={{ textAlign: "right", marginTop: 10 }}>
              <button
                disabled={!videoCompleted}
                onClick={handleMarkComplete}
                className="dgv-btn dgv-btn--success"
              >
                Mark Complete
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
