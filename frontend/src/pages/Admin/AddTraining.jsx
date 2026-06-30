import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import {
  fetchSkills,
  getTrainingUploadUrl,
  addTrainingMaterial,
} from "../../services/api";
import {
  colors,
  pageCard,
  pageTitle,
  pageSubtitle,
  formLabel,
  formInput,
  formSelect,
  buttonPrimary,
  alertSuccess,
  alertError,
} from "../../theme";

export default function AddTraining() {
  const [skills, setSkills] = useState([]);
  const [skill, setSkill] = useState("");
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [level, setLevel] = useState("BASIC");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("");
  const [fileKey, setFileKey] = useState(0);

  useEffect(() => {
    fetchSkills().then(setSkills).catch(console.error);
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!file || !title || !skill) {
      setMessageType("error");
      setMessage("Please fill in title, skill, and upload a video.");
      return;
    }

    try {
      setLoading(true);
      setMessage("");
      setMessageType("");

      const { uploadUrl, video_s3_key } = await getTrainingUploadUrl(
        file.name,
        skill
      );

      await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "video/mp4" },
        body: file,
      });

      await addTrainingMaterial({
        title,
        skill,
        level,
        video_s3_key,
      });

      setMessageType("success");
      setMessage("Training material added successfully!");
      setFile(null);
      setTitle("");
      setSkill("");
      setLevel("BASIC");
      setFileKey((k) => k + 1);
    } catch (err) {
      console.error(err);
      setMessageType("error");
      setMessage("Upload failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Layout>
      <div style={{ ...pageCard, maxWidth: 560 }}>
        <h2 style={pageTitle}>Add Training</h2>
        <p style={pageSubtitle}>
          Upload a training video. Choose &quot;All Employees&quot; to show it to everyone,
          or pick a skill to limit visibility.
        </p>

        <form onSubmit={handleSubmit}>
          <label style={formLabel}>Training Title</label>
          <input
            style={formInput}
            placeholder="e.g. AWS Fundamentals"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />

          <label style={formLabel}>Skill</label>
          <select
            style={formSelect}
            value={skill}
            onChange={(e) => setSkill(e.target.value)}
          >
            <option value="">Select Skill</option>
            <option value="ALL">All Employees</option>
            {skills.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>

          <label style={formLabel}>Level</label>
          <select
            style={formSelect}
            value={level}
            onChange={(e) => setLevel(e.target.value)}
          >
            <option value="BASIC">Basic</option>
            <option value="REGULAR">Regular</option>
            <option value="ADVANCED">Advanced</option>
          </select>

          <label style={formLabel}>Training Video (MP4)</label>
          <input
            key={fileKey}
            type="file"
            accept="video/mp4"
            style={{
              ...formInput,
              padding: 8,
              background: colors.background,
            }}
            onChange={(e) => setFile(e.target.files[0])}
          />
          {file && (
            <p style={{ margin: "-8px 0 16px", fontSize: 13, color: colors.textMuted }}>
              Selected: {file.name}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              ...buttonPrimary,
              width: "100%",
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? "Uploading..." : "Add Training"}
          </button>

          {message && (
            <div style={messageType === "success" ? alertSuccess : alertError}>
              {messageType === "success" ? "✓ " : "✕ "}
              {message}
            </div>
          )}
        </form>
      </div>
    </Layout>
  );
}
