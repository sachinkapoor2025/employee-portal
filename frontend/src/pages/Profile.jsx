import { useEffect, useState } from "react";
import Layout from "../components/Layout";
import Button from "../components/ui/Button";
import {
  fetchUserProfile,
  saveUserProfile,
  getProfileImageUploadUrl,
  apiOptional,
} from "../services/api";
import { getLoggedInEmail } from "../services/auth";
import { s3KeyFromFileUrl } from "../utils/documentView";
import {
  colors,
  pageCard,
  pageTitle,
  pageSubtitle,
  formLabel,
  formInput,
  buttonPrimary,
  alertSuccess,
  alertError,
} from "../theme";

function imageContentType(file) {
  const t = String(file?.type || "").trim();
  if (t && t !== "application/octet-stream") return t;
  const name = String(file?.name || "").toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

function isUsableImageSrc(url) {
  const value = String(url || "");
  if (!value) return false;
  if (value.startsWith("blob:") || value.startsWith("data:")) return true;
  if (value.includes("X-Amz-Signature") || value.includes("X-Amz-Credential")) {
    return true;
  }
  return false;
}

function persistableProfile(profile, extra = {}) {
  const next = { ...(profile || {}), ...extra };
  delete next.PK;
  delete next.SK;
  delete next.profileImageUrl;
  delete next.imageStorageUrl;
  if (next.imageUrl && String(next.imageUrl).includes("X-Amz-")) {
    next.imageUrl = String(next.imageUrl).split("?")[0];
  }
  if (!next.imageS3Key) {
    const fromUrl = s3KeyFromFileUrl(next.imageUrl);
    if (fromUrl) next.imageS3Key = fromUrl;
  }
  return next;
}

async function resolveProfilePhotoSrc(data) {
  if (isUsableImageSrc(data?.profileImageUrl)) return data.profileImageUrl;
  if (isUsableImageSrc(data?.imageUrl)) return data.imageUrl;
  if (isUsableImageSrc(data?.imagePreview)) return data.imagePreview;
  const key =
    data?.imageS3Key ||
    s3KeyFromFileUrl(data?.imageUrl) ||
    s3KeyFromFileUrl(data?.imageStorageUrl);
  if (key) {
    try {
      const res = await apiOptional("/getProfileImageUploadUrl", "POST", {
        mode: "view",
        s3Key: key,
        key,
        storageKey: key,
        fileName: "profile.jpg",
        contentType: "image/jpeg",
        email: data?.email || getLoggedInEmail(),
      });
      const signed = res?.url || res?.downloadUrl;
      if (signed && res?.success) return signed;
      if (signed && !res?.uploadUrl) return signed;
    } catch (err) {
      console.warn("Profile image signed URL failed:", err);
    }
  }
  return null;
}

export default function Profile() {
  const [profile, setProfile] = useState({});
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(null);
  const [uploading, setUploading] = useState(false);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const email = String(profile.email || getLoggedInEmail() || "")
    .trim()
    .toLowerCase();

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async (keepPreview = false) => {
    try {
      const lookup = getLoggedInEmail() || undefined;
      const data = await fetchUserProfile(lookup);
      setProfile(data || {});
      const src = await resolveProfilePhotoSrc(data || {});
      if (src) {
        setPreview((prev) => {
          if (prev && prev.startsWith("blob:") && prev !== src) {
            URL.revokeObjectURL(prev);
          }
          return src;
        });
      } else if (!keepPreview) {
        setPreview((prev) => {
          if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
          return null;
        });
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleImageChange = async (e) => {
    const file = e.target.files[0];
    if (!file || !email) return;

    const previousPreview = preview;
    const localUrl = URL.createObjectURL(file);
    setPreview(localUrl);
    setUploading(true);
    setError("");

    try {
      const contentType = imageContentType(file);
      const { uploadUrl, imageUrl, s3Key } = await getProfileImageUploadUrl(
        { name: file.name, type: contentType },
        email
      );

      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: file,
      });
      if (!putRes.ok) {
        throw new Error(`Upload failed (${putRes.status})`);
      }

      const storedUrl = String(imageUrl || "").split("?")[0];
      const objectKey = s3Key || s3KeyFromFileUrl(storedUrl);
      if (!objectKey) {
        throw new Error("Upload succeeded but no S3 object key was returned");
      }

      await saveUserProfile({
        mode: "EDIT",
        email,
        profile: persistableProfile(profile, {
          ...draft,
          email,
          imageUrl: storedUrl,
          imageS3Key: objectKey,
        }),
      });

      await loadProfile(true);
      setMessage("Profile photo updated.");
    } catch (err) {
      console.error("Image upload failed:", err);
      URL.revokeObjectURL(localUrl);
      setPreview(previousPreview);
      setError(err.message || "Failed to upload image");
    } finally {
      setUploading(false);
    }
  };

  const startEdit = () => {
    setDraft({
      name: profile.name || "",
      designation: profile.designation || "",
      skill: profile.skill || "",
      phone: profile.phone || "",
    });
    setEditing(true);
    setMessage("");
    setError("");
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft({});
    setError("");
  };

  const saveEdit = async () => {
    if (!email) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await saveUserProfile({
        mode: "EDIT",
        email,
        profile: persistableProfile(profile, {
          email,
          name: String(draft.name || "").trim(),
          designation: String(draft.designation || "").trim(),
          skill: String(draft.skill || "").trim(),
          phone: String(draft.phone || "").trim(),
        }),
      });
      setEditing(false);
      await loadProfile(true);
      setMessage("Profile updated.");
    } catch (err) {
      console.error(err);
      setError(err.message || "Failed to save profile.");
    } finally {
      setSaving(false);
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
    { key: "name", label: "Full Name", editable: true },
    { key: "empId", label: "Employee ID", editable: false },
    { key: "email", label: "Email", editable: false },
    { key: "designation", label: "Designation", editable: true },
    { key: "skill", label: "Skill", editable: true },
    { key: "manager", label: "Manager", editable: false },
    { key: "groupLead", label: "Group Lead", editable: false },
    { key: "phone", label: "Phone", editable: true },
    { key: "doj", label: "Date of Joining", editable: false },
  ];

  return (
    <Layout>
      <div style={pageCard}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <h2 style={pageTitle}>My Profile</h2>
            <p style={pageSubtitle}>Your employee information at DGV.</p>
          </div>
          {editing ? (
            <div style={{ display: "flex", gap: 8 }}>
              <Button variant="ghost" onClick={cancelEdit} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={saveEdit} loading={saving}>
                Save
              </Button>
            </div>
          ) : (
            <Button onClick={startEdit}>Edit</Button>
          )}
        </div>

        {message ? <div style={alertSuccess}>{message}</div> : null}
        {error ? <div style={alertError}>{error}</div> : null}

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
                  onError={() => setPreview(null)}
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

            {editing ? (
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
            ) : null}
          </div>

          <div>
            {fields.map(({ key, label, editable }) => {
              const canEdit = editing && editable;
              const value = canEdit ? draft[key] : profile[key];
              return (
                <div key={key} style={{ marginBottom: 14 }}>
                  <label style={formLabel}>{label}</label>
                  <input
                    disabled={!canEdit}
                    value={value || ""}
                    style={formInput}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, [key]: e.target.value }))
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Layout>
  );
}
