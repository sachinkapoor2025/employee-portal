import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Layout from "../components/Layout";
import Button from "../components/ui/Button";
import {
  fetchUserProfile,
  fetchDepartments,
  fetchDepartmentDesignations,
  saveUserProfile,
  getProfileImageUploadUrl,
  apiOptional,
  fetchEmployeeShift,
} from "../services/api";
import { getLoggedInEmail } from "../services/auth";
import { s3KeyFromFileUrl } from "../utils/documentView";
import { alertSuccess, alertError } from "../theme";
import {
  buildEmployeeWorkView,
  employmentFieldGroups,
} from "../utils/employeeWorkProfile";

function displayValue(value) {
  const text = String(value ?? "").trim();
  return text || "—";
}

function profileInitials(name, email) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }
  if (parts[0]?.length >= 2) return parts[0].slice(0, 2).toUpperCase();
  if (parts[0]) return parts[0][0].toUpperCase();
  const local = String(email || "")
    .split("@")[0]
    .replace(/[^a-zA-Z0-9]/g, "");
  return (local.slice(0, 2) || "?").toUpperCase();
}

const PERSONAL_FIELDS = [
  { key: "name", label: "Full Name", editable: true },
  { key: "empId", label: "Employee ID", editable: false },
  { key: "email", label: "Email", editable: false },
  { key: "phone", label: "Phone", editable: true },
];

function ProfileFieldGrid({ fields, editing, profile, draft, onDraftChange }) {
  return (
    <div className="dgv-profile-grid">
      {fields.map(({ key, label, editable }) => {
        const canEdit = editing && editable;
        const raw = canEdit ? draft[key] : profile[key];
        return (
          <div key={key} className="dgv-profile-item">
            <label htmlFor={editing ? `profile-${key}` : undefined}>{label}</label>
            {editing ? (
              <input
                id={`profile-${key}`}
                disabled={!canEdit}
                value={raw || ""}
                onChange={(e) => onDraftChange(key, e.target.value)}
              />
            ) : (
              <div className="dgv-profile-value">{displayValue(raw)}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function WorkField({ field, editing, onDraftChange }) {
  const canEdit = Boolean(editing && field.editable);
  return (
    <div className="dgv-profile-item">
      <label htmlFor={canEdit ? "profile-designation" : undefined}>{field.label}</label>
      {canEdit ? (
        <input
          id="profile-designation"
          value={field.value || ""}
          onChange={(e) => onDraftChange("designation", e.target.value)}
        />
      ) : (
        <div className="dgv-profile-value">{displayValue(field.value)}</div>
      )}
    </div>
  );
}

function WorkInformation({ profile, employment, editing, onDraftChange }) {
  const groups = employmentFieldGroups(employment);

  return (
    <section className="dgv-profile-block">
      <h2>Work Information</h2>
      <p className="dgv-profile-section-desc">
        Employment details and reporting structure
      </p>
      <div className="dgv-profile-card">
        <div className="dgv-profile-subsection">
          <h3 className="dgv-profile-subtitle">Employment Details</h3>
          {groups.map((fields, index) => (
            <div
              className="dgv-profile-grid"
              key={fields.map((field) => field.key).join("-") || index}
            >
              {fields.map((field) => (
                <WorkField
                  key={field.key}
                  field={field}
                  editing={editing}
                  onDraftChange={onDraftChange}
                />
              ))}
            </div>
          ))}
        </div>

        <div className="dgv-profile-subsection">
          <h3 className="dgv-profile-subtitle">Reporting Structure</h3>
          <div className="dgv-profile-grid">
            <div className="dgv-profile-item">
              <label>Manager</label>
              <div className="dgv-profile-value">{displayValue(profile.manager)}</div>
            </div>
            <div className="dgv-profile-item">
              <label>Group Lead</label>
              <div className="dgv-profile-value">{displayValue(profile.groupLead)}</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

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

function personalProfilePayload(profile, extra = {}) {
  const next = persistableProfile(profile, extra);
  delete next.department;
  delete next.designation;
  return next;
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
  const navigate = useNavigate();
  const [profile, setProfile] = useState({});
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(null);
  const [uploading, setUploading] = useState(false);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [assignedShift, setAssignedShift] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [designationsByDepartment, setDesignationsByDepartment] = useState({});
  const [shiftLoadError, setShiftLoadError] = useState("");

  const workView = useMemo(
    () =>
      buildEmployeeWorkView(profile, departments, designationsByDepartment),
    [profile, departments, designationsByDepartment]
  );

  const email = String(profile.email || getLoggedInEmail() || "")
    .trim()
    .toLowerCase();

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async (keepPreview = false) => {
    try {
      const lookup = getLoggedInEmail() || undefined;
      const [data, departmentRes] = await Promise.all([
        fetchUserProfile(lookup),
        fetchDepartments().catch(() => ({ departments: [] })),
      ]);
      const departmentIds = Array.isArray(data?.departmentIds)
        ? data.departmentIds.map((id) => String(id || "").trim()).filter(Boolean)
        : [];
      const designationEntries = await Promise.all(
        departmentIds.map(async (id) => {
          try {
            const res = await fetchDepartmentDesignations(id);
            return [id, Array.isArray(res?.designations) ? res.designations : []];
          } catch {
            return [id, []];
          }
        })
      );
      setProfile(data || {});
      setDepartments(
        Array.isArray(departmentRes?.departments) ? departmentRes.departments : []
      );
      setDesignationsByDepartment(Object.fromEntries(designationEntries));
      try {
        const shiftRes = await fetchEmployeeShift(lookup || getLoggedInEmail());
        setAssignedShift(shiftRes?.shift || null);
        setShiftLoadError("");
      } catch (err) {
        setAssignedShift(null);
        setShiftLoadError(err?.message || "Unable to load assigned shift.");
      }
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
        profile: personalProfilePayload(profile, {
          ...draft,
          email,
          imageUrl: storedUrl,
          imageS3Key: objectKey,
          skill: profile.skill,
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
      const nextProfile = personalProfilePayload(profile, {
        email,
        name: String(draft.name || "").trim(),
        skill: profile.skill,
        phone: String(draft.phone || "").trim(),
      });
      await saveUserProfile({
        mode: "EDIT",
        email,
        profile: nextProfile,
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

  const updateDraft = (key, value) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return (
      <Layout>
        <div className="dgv-profile-page">
          <p className="dgv-profile-loading">Loading profile...</p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className={`dgv-profile-page${editing ? " is-editing" : ""}`}>
        <div className="dgv-profile-page-header">
          <div>
            <h1>Profile</h1>
            <p>
              {editing
                ? "Editing employee information"
                : "Your employee information at DGV."}
            </p>
            {editing ? (
              <span className="dgv-profile-editing-dot">
                <i /> Editing
              </span>
            ) : null}
          </div>
          <div className="dgv-profile-page-actions">
            {editing ? (
              <>
                <Button variant="ghost" onClick={cancelEdit} disabled={saving}>
                  Cancel
                </Button>
                <Button onClick={saveEdit} loading={saving}>
                  Save Changes
                </Button>
              </>
            ) : (
              <button
                type="button"
                className="dgv-exit-btn"
                onClick={() => navigate("/exit")}
              >
                Exit Organization
              </button>
            )}
          </div>
        </div>

        {message ? (
          <div style={{ ...alertSuccess, marginTop: 0, marginBottom: 16 }}>{message}</div>
        ) : null}
        {error ? (
          <div style={{ ...alertError, marginTop: 0, marginBottom: 16 }}>{error}</div>
        ) : null}

        <section className="dgv-profile-card dgv-profile-identity">
          {!editing ? (
            <div className="dgv-profile-identity-actions">
              <Button className="dgv-profile-edit" onClick={startEdit}>
                Edit Profile
              </Button>
            </div>
          ) : null}
          <div className="dgv-profile-avatar-wrap">
            <div
              className="dgv-profile-avatar"
              aria-hidden={preview ? undefined : true}
            >
              {preview ? (
                <img
                  src={preview}
                  alt={profile.name ? `${profile.name} profile photo` : "Profile photo"}
                  onError={() => setPreview(null)}
                />
              ) : (
                <span>{profileInitials(profile.name, email)}</span>
              )}
            </div>
            {editing ? (
              <label className="dgv-profile-change-photo">
                {uploading ? "Uploading..." : "Change photo"}
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleImageChange}
                  disabled={uploading}
                />
              </label>
            ) : null}
          </div>
          <div className="dgv-profile-identity__body">
            <h2>{displayValue(profile.name)}</h2>
            <p className="dgv-profile-role">
              {displayValue(workView.roleDesignation)} · Employee ID:{" "}
              {displayValue(profile.empId)}
            </p>
            <p className="dgv-profile-email">{displayValue(profile.email || email)}</p>
            <p className="dgv-profile-reports">
              Manager: {displayValue(profile.manager)} · Group Lead:{" "}
              {displayValue(profile.groupLead)}
            </p>
          </div>
        </section>

        <section className="dgv-profile-block">
          <h2>Personal Information</h2>
          <p className="dgv-profile-section-desc">
            Basic employee identification and contact details
          </p>
          <div className="dgv-profile-card">
            <ProfileFieldGrid
              fields={PERSONAL_FIELDS}
              editing={editing}
              profile={profile}
              draft={draft}
              onDraftChange={updateDraft}
            />
          </div>
        </section>

        <WorkInformation
          profile={profile}
          employment={workView}
          editing={editing}
          onDraftChange={updateDraft}
        />

        <section className="dgv-profile-block">
          <h2>Assigned Shift</h2>
          <p className="dgv-profile-section-desc">
            Your working hours. Only an administrator can change this.
          </p>
          <div className="dgv-profile-card">
            <div className="dgv-profile-item">
              <label>Shift</label>
              <div className="dgv-profile-value">
                {shiftLoadError
                  ? shiftLoadError
                  : assignedShift?.name
                    ? `${assignedShift.name} (${assignedShift.startTime} – ${assignedShift.endTime}${
                        assignedShift.crossesMidnight ? ", overnight" : ""
                      })`
                    : "Not assigned"}
              </div>
            </div>
          </div>
        </section>
      </div>
    </Layout>
  );
}
