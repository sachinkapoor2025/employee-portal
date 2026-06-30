import { useEffect, useState } from "react";
import Layout from "../components/Layout";
import {
  fetchUserProfile,
  saveUserProfile,
  getProfileImageUploadUrl,
} from "../services/api";
import {
  colors,
  pageCard,
  pageTitle,
  pageSubtitle,
  formLabel,
  formInput,
  buttonPrimary,
} from "../theme";

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
      const data = await fetchUserProfile();
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
      const { uploadUrl, imageUrl } = await getProfileImageUploadUrl(
        file,
        profile.email
      );

      await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });

      await saveUserProfile({
        mode: "EDIT",
        email: profile.email,
        profile: { ...profile, imageUrl },
      });

      await loadProfile();
    } catch (err) {
      console.error("Image upload failed:", err);
      alert("Failed to upload image");
    } finally {
      setUploading(false);
    }
  };

  if (loading) {
    return (
      <Layout>
        <div style={pageCard}>
          <p style={{ color: colors.textMuted }}>Loading profile...</p>
        </div>
      </Layout>
    );
  }

  const fields = [
    { label: "Full Name", value: profile.name },
    { label: "Employee ID", value: profile.empId },
    { label: "Email", value: profile.email },
    { label: "Designation", value: profile.designation },
    { label: "Skill", value: profile.skill },
    { label: "Manager", value: profile.manager },
    { label: "Group Lead", value: profile.groupLead },
    { label: "Phone", value: profile.phone },
    { label: "Date of Joining", value: profile.doj },
  ];

  return (
    <Layout>
      <div style={pageCard}>
        <h2 style={pageTitle}>My Profile</h2>
        <p style={pageSubtitle}>Your employee information at DGV.</p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 32,
          }}
        >
          <div style={{ textAlign: "center" }}>
            <label style={{ ...formLabel, textAlign: "left" }}>Profile Image</label>
            <div
              style={{
                margin: "10px auto 16px",
                width: 140,
                height: 140,
                borderRadius: "50%",
                border: `3px solid ${colors.primary}`,
                overflow: "hidden",
                background: colors.background,
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
                    color: colors.textMuted,
                    fontSize: 13,
                  }}
                >
                  No Image
                </div>
              )}
            </div>

            <label style={{ ...buttonPrimary, display: "inline-block", cursor: "pointer" }}>
              {uploading ? "Uploading..." : "Change Photo"}
              <input
                type="file"
                accept="image/*"
                onChange={handleImageChange}
                disabled={uploading}
                style={{ display: "none" }}
              />
            </label>
          </div>

          <div>
            {fields.map(({ label, value }) => (
              <div key={label} style={{ marginBottom: 14 }}>
                <label style={formLabel}>{label}</label>
                <input disabled value={value || ""} style={formInput} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Layout>
  );
}
