import { useEffect, useState } from "react";
import Layout from "../components/Layout";
import {
  fetchUserProfile,
  saveUserProfile,
  getProfileImageUploadUrl,
} from "../services/api";

export default function Profile() {
  const [profile, setProfile] = useState({});
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    try {
      const data = await fetchUserProfile(); // logged-in user
      setProfile(data || {});
      setPreview(data?.imageUrl || null);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleImageChange = async (e) => {
    const file = e.target.files[0];
    if (!file || !profile.email) return;

    setPreview(URL.createObjectURL(file));
    setUploading(true);

    try {
      // 1️⃣ ask backend for presigned URL
      const { uploadUrl, imageUrl } = await getProfileImageUploadUrl(
        file,
        profile.email
      );

      // 2️⃣ upload image to S3
      await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": file.type,
        },
        body: file,
      });

      // 3️⃣ save image URL in DynamoDB
      await saveUserProfile({
        mode: "EDIT",
        email: profile.email,
        profile: {
          ...profile,
          imageUrl,
        },
      });

      // 4️⃣ reload profile
      await loadProfile();
    } catch (err) {
      console.error("Image upload failed:", err);
      alert("Failed to upload image");
    } finally {
      setUploading(false);
    }
  };

  if (loading)
    return (
      <Layout>
        <p>Loading...</p>
      </Layout>
    );

  return (
    <Layout>
      <div style={{ background: "#fff", padding: 24, borderRadius: 12 }}>
        <h2>My Profile</h2>

        {/* PROFILE IMAGE */}
        <div style={{ marginBottom: 24 }}>
          <label style={{ fontWeight: 600 }}>Profile Image</label>

          <div
            style={{
              marginTop: 10,
              width: 140,
              height: 140,
              borderRadius: "50%",
              border: "3px solid #1976d2",
              overflow: "hidden",
              background: "#f5f5f5",
            }}
          >
            {preview ? (
              <img
                src={preview}
                alt="profile"
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            ) : (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#888",
                }}
              >
                No Image
              </div>
            )}
          </div>

          <input
            type="file"
            accept="image/*"
            onChange={handleImageChange}
            disabled={uploading}
            style={{ marginTop: 10 }}
          />

          {uploading && <p>Uploading...</p>}
        </div>

        <Field label="Full Name" value={profile.name} />
        <Field label="Employee ID" value={profile.empId} />
        <Field label="Email" value={profile.email} />
        <Field label="Designation" value={profile.designation} />
        <Field label="Skill" value={profile.skill} />
        <Field label="Manager" value={profile.manager} />
        <Field label="Group Lead" value={profile.groupLead} />
        <Field label="Phone" value={profile.phone} />
        <Field label="Date of Joining" value={profile.doj} />
      </div>
    </Layout>
  );
}

const Field = ({ label, value }) => (
  <div style={{ marginBottom: 12 }}>
    <label style={{ fontWeight: 600 }}>{label}</label>
    <input
      disabled
      value={value || ""}
      style={{ width: "100%", marginTop: 4 }}
    />
  </div>
);
