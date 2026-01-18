import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import {
  fetchSkills,
  getTrainingUploadUrl,
  addTrainingMaterial,
} from "../../services/api";

export default function AddTraining() {
  const [skills, setSkills] = useState([]);
  const [skill, setSkill] = useState("");
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [level, setLevel] = useState("BASIC");
  const [duration, setDuration] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  // ======================
  // LOAD SKILLS
  // ======================
  useEffect(() => {
    fetchSkills().then(setSkills).catch(console.error);
  }, []);

  // ======================
  // SUBMIT
  // ======================
  const handleSubmit = async () => {
    if (!file || !title || !skill || !duration) {
      setMessage("All fields required");
      return;
    }

    try {
      setLoading(true);
      setMessage("");

      // 1️⃣ Presigned URL
      const { uploadUrl, video_s3_key } = await getTrainingUploadUrl(
        file.name,
        skill
      );

      // 2️⃣ Upload
      await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "video/mp4" },
        body: file,
      });

      // 3️⃣ Save metadata
      await addTrainingMaterial({
        title,
        skill,
        level,
        duration_hours: Number(duration),
        video_s3_key,
      });

      setMessage("✅ Training added");
      setFile(null);
      setTitle("");
      setSkill("");
      setDuration("");
    } catch (err) {
      console.error(err);
      setMessage("❌ Upload failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Layout>
      <div style={{ maxWidth: 600, padding: 24 }}>
        <h2>Add Training</h2>

        <input
          placeholder="Training title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />

        <br />
        <br />

        <select value={skill} onChange={(e) => setSkill(e.target.value)}>
          <option value="">Select Skill</option>
          {skills.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </select>

        <br />
        <br />

        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="BASIC">BASIC</option>
          <option value="REGULAR">REGULAR</option>
          <option value="ADVANCED">ADVANCED</option>
        </select>

        <br />
        <br />

        <input
          type="number"
          placeholder="Duration (hours)"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
        />

        <br />
        <br />

        <input
          type="file"
          accept="video/mp4"
          onChange={(e) => setFile(e.target.files[0])}
        />

        <br />
        <br />

        <button onClick={handleSubmit} disabled={loading}>
          {loading ? "Uploading..." : "Add Training"}
        </button>

        {message && <p>{message}</p>}
      </div>
    </Layout>
  );
}
