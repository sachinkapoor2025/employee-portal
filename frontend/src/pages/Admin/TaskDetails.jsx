import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import Layout from "../../components/Layout";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import {
  fetchTaskById,
  fetchTaskActivity,
  fetchTaskAttachments,
  getTaskAttachmentUploadUrl,
  registerTaskAttachment,
  getTaskAttachmentDownloadUrl,
  updateTask,
  createTask,
  fetchUsers,
  fetchUserProfile,
  reportTaskBlocker,
} from "../../services/api";
import { getLoggedInEmail } from "../../services/auth";
import {
  colors,
  pageCard,
  pageTitle,
  formLabel,
  formInput,
  formSelect,
} from "../../theme";
import {
  TASK_STATUSES,
  TASK_PRIORITIES,
  TASK_CATEGORIES,
  displayTaskId,
  formatTaskDate,
  formatTaskDateTime,
  formatTaskDuration,
  formatTaskTime,
  friendlyActivityText,
  getStoredStatus,
  getTaskAssignees,
  getTaskTiming,
  getTaskZone,
  joinDueParts,
  isQuarterHourTime,
  personLabel,
  selectableTaskAssignees,
  priorityLabel,
  splitDueParts,
  statusBadgeStyle,
  statusLabel,
  zoneDisplay,
  employeeCanChangeStatus,
  TASK_ATTACHMENT_EXTS,
  validateTaskAttachmentFile,
} from "../../utils/taskStatus";
import ZoneBadge from "../../components/ZoneBadge";

const EMPLOYEE_STATUS_OPTIONS = TASK_STATUSES.filter(
  (s) => s.value !== "CANCELLED" && s.value !== "REVIEW"
);
const RED_ZONE_MESSAGE =
  "Red Zone tasks can only be updated by an administrator.";
const COMPLETION_MODAL_TITLE = "Submit Task for Review";
const COMPLETION_REMARK_HELPER =
  "Add a final remark describing the work you completed. The task will be sent to Admin for review.";
const COMPLETION_SUBMIT_LABEL = "Submit for Review";
const COMPLETION_REMARK_REQUIRED = "Completion Remark is required.";
const REVIEW_WAIT_HEADER =
  "Your task has been submitted for Admin review.";
const REVIEW_WAIT_ASSIGNMENT = "Waiting for Admin review.";
const BLOCKER_REMARK_HELPER =
  "Describe what is blocking you from completing this task.";
const BLOCKER_REMARK_REQUIRED = "Blocker Remark is required.";
const BLOCKER_REMARK_PLACEHOLDER =
  "Describe what is preventing you from completing the task...";

function StatusBadge({ taskOrStatus }) {
  const style = statusBadgeStyle(taskOrStatus);
  const label =
    typeof taskOrStatus === "object"
      ? statusLabel(taskOrStatus)
      : statusLabel(taskOrStatus);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 700,
        letterSpacing: 0.3,
        background: style.bg,
        color: style.color,
        border: `1px solid ${style.border}`,
      }}
    >
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: style.dot,
          flexShrink: 0,
        }}
      />
      {label}
    </span>
  );
}

export default function TaskDetails() {
  const { taskId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const employeeView = location.pathname.startsWith("/work");
  const [task, setTask] = useState(location.state?.task || null);
  const [activity, setActivity] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState("");
  const [users, setUsers] = useState([]);
  const [creatorName, setCreatorName] = useState("");
  const [loading, setLoading] = useState(!location.state?.task);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [modal, setModal] = useState(null); // edit | status | reassign | complete | blocker
  const [completeRemark, setCompleteRemark] = useState("");
  const [completeError, setCompleteError] = useState("");
  const [blockerRemark, setBlockerRemark] = useState("");
  const [blockerError, setBlockerError] = useState("");
  const [reviewDecision, setReviewDecision] = useState("");
  const [reviewReason, setReviewReason] = useState("");
  const [reviewRemark, setReviewRemark] = useState("");
  const [reviewAssignMode, setReviewAssignMode] = useState("SAME");
  const [reviewOtherEmail, setReviewOtherEmail] = useState("");
  const [reviewDescription, setReviewDescription] = useState("");
  const [reviewStartDate, setReviewStartDate] = useState("");
  const [reviewStartTime, setReviewStartTime] = useState("");
  const [reviewEndDate, setReviewEndDate] = useState("");
  const [reviewEndTime, setReviewEndTime] = useState("");
  const [reviewError, setReviewError] = useState("");
  const reviewFormTaskIdRef = useRef(null);
  const [editForm, setEditForm] = useState({
    title: "",
    description: "",
    assignees: [],
    dueDate: "",
    dueTime: "",
    startDate: "",
    startTime: "",
    status: "TODO",
    priority: "MEDIUM",
    assignmentEmail: "",
    category: "",
  });

  const enrichTask = useCallback(async (t, userList, { allowDirectoryLookups = true } = {}) => {
    let assigneeProfile = t.assigneeProfile || null;
    if (t.assignee && !assigneeProfile?.name) {
      if (allowDirectoryLookups) {
        try {
          const profile = await fetchUserProfile(t.assignee);
          assigneeProfile = {
            email: t.assignee,
            name: profile?.name || "",
          };
        } catch {
          const row = userList.find(
            (x) =>
              String(x.email).toLowerCase() === String(t.assignee).toLowerCase()
          );
          assigneeProfile = {
            email: t.assignee,
            name: row?.name || "",
          };
        }
      } else {
        const row = userList.find(
          (x) =>
            String(x.email).toLowerCase() === String(t.assignee).toLowerCase()
        );
        assigneeProfile = {
          email: t.assignee,
          name: row?.name || "",
        };
      }
    }

    let createdByName = String(t.createdByName || "").trim();
    if (createdByName && createdByName.includes("@")) createdByName = "";
    if (!createdByName && t.createdBy) {
      const fromList = personLabel(userList, t.createdBy);
      if (fromList.name && fromList.name !== t.createdBy.split("@")[0]) {
        createdByName = fromList.name;
      } else if (allowDirectoryLookups) {
        try {
          const profile = await fetchUserProfile(t.createdBy);
          createdByName = profile?.name || fromList.name;
        } catch {
          createdByName = fromList.name;
        }
      } else {
        createdByName = fromList.name;
      }
    }

    return {
      ...t,
      assigneeProfile,
      createdByName,
    };
  }, []);

  const load = useCallback(async () => {
    if (!taskId) return;
    setError("");
    setLoading((was) => was || !location.state?.task);
    try {
      const directoryPromise = employeeView
        ? Promise.resolve([])
        : fetchUsers().catch((err) => {
            if (Number(err?.status) === 403) return [];
            throw err;
          });
      const [t, u] = await Promise.all([
        fetchTaskById(taskId),
        directoryPromise,
      ]);
      const userList = Array.isArray(u) ? u : [];
      const enriched = await enrichTask(t, userList, {
        allowDirectoryLookups: !employeeView,
      });
      setUsers(userList);
      setTask(enriched);
      setCreatorName(enriched.createdByName || "");

      const dueParts = splitDueParts(enriched.dueDate);
      const startParts = splitDueParts(enriched.startDate);
      const assigneeEmails = getTaskAssignees(enriched).map((a) => a.email);
      setEditForm({
        title: enriched.title || "",
        description: enriched.description || "",
        assignees: assigneeEmails,
        dueDate: dueParts.date,
        dueTime: dueParts.time,
        startDate: startParts.date,
        startTime: startParts.time,
        status: getStoredStatus(enriched),
        priority:
          String(enriched.priority || "MEDIUM").toUpperCase() === "URGENT"
            ? "CRITICAL"
            : enriched.priority || "MEDIUM",
        assignmentEmail: assigneeEmails[0] || "",
        category: enriched.category || "",
      });

      const [a, atts] = await Promise.all([
        fetchTaskActivity(taskId).catch(() => []),
        fetchTaskAttachments(taskId).catch(() => []),
      ]);
      setActivity(Array.isArray(a) ? a : []);
      setAttachments(Array.isArray(atts) ? atts : []);
      setAttachmentError("");
    } catch (err) {
      console.error(err);
      const denied = Number(err?.status) === 403;
      setError(
        denied
          ? "You do not have permission to view this task."
          : err.message || "Unable to load task details. Please try again."
      );
      if (denied || !location.state?.task) setTask(null);
    } finally {
      setLoading(false);
    }
  }, [taskId, location.state?.task, enrichTask, employeeView]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!task) {
      reviewFormTaskIdRef.current = null;
      return;
    }
    if (reviewFormTaskIdRef.current === task.taskId) return;
    reviewFormTaskIdRef.current = task.taskId;
    const start = splitDueParts(task.startDate);
    const due = splitDueParts(task.dueDate);
    setReviewDescription(task.description || "");
    setReviewStartDate(start.date);
    setReviewStartTime(start.time);
    setReviewEndDate(due.date);
    setReviewEndTime(due.time);
    setReviewDecision("");
    setReviewReason("");
    setReviewRemark("");
    setReviewAssignMode("SAME");
    setReviewOtherEmail("");
    setReviewError("");
  }, [task]);

  const patchTask = async (updates) => {
    const updated = await updateTask({
      taskId,
      projectId: task.projectId,
      ...updates,
    });
    const enriched = await enrichTask(
      { ...task, ...updated },
      users
    );
    setTask(enriched);
    setCreatorName(enriched.createdByName || creatorName);
    const [a, atts] = await Promise.all([
      fetchTaskActivity(taskId).catch(() => []),
      fetchTaskAttachments(taskId).catch(() => []),
    ]);
    setActivity(Array.isArray(a) ? a : []);
    setAttachments(Array.isArray(atts) ? atts : []);
    return enriched;
  };

  const refreshAttachmentsAndActivity = async () => {
    const [a, atts] = await Promise.all([
      fetchTaskActivity(taskId).catch(() => []),
      fetchTaskAttachments(taskId).catch(() => []),
    ]);
    setActivity(Array.isArray(a) ? a : []);
    setAttachments(Array.isArray(atts) ? atts : []);
  };

  const handleAttachmentFile = async (file) => {
    if (!file) return;
    setAttachmentError("");
    const invalid = validateTaskAttachmentFile(file);
    if (invalid) {
      setAttachmentError(invalid);
      return;
    }
    setUploadingAttachment(true);
    try {
      const contentType = file.type || "application/octet-stream";
      const signed = await getTaskAttachmentUploadUrl(
        taskId,
        file.name,
        contentType,
        file.size
      );
      if (!signed?.uploadUrl || !signed?.s3Key) {
        throw new Error("Unable to upload attachment.");
      }
      const put = await fetch(signed.uploadUrl, {
        method: "PUT",
        body: file,
        headers: {
          "Content-Type": signed.contentType || contentType,
        },
      });
      if (!put.ok) {
        throw new Error("Unable to upload attachment.");
      }
      await registerTaskAttachment(taskId, {
        fileName: signed.fileName || file.name,
        contentType: signed.contentType || contentType,
        s3Key: signed.s3Key,
      });
      await refreshAttachmentsAndActivity();
    } catch (err) {
      setAttachmentError(err.message || "Unable to upload attachment.");
    } finally {
      setUploadingAttachment(false);
    }
  };

  const handleAttachmentDownload = async (item) => {
    const id = item?.attachmentId || item?.s3Key || "";
    setAttachmentError("");
    setDownloadingAttachmentId(id);
    try {
      const res = await getTaskAttachmentDownloadUrl(taskId, {
        attachmentId: item?.attachmentId,
        s3Key: item?.s3Key,
      });
      const url = res?.downloadUrl;
      if (!url) throw new Error("Unable to download attachment.");
      window.open(url, "_blank", "noopener");
    } catch (err) {
      setAttachmentError(err.message || "Unable to download attachment.");
    } finally {
      setDownloadingAttachmentId("");
    }
  };

  const openEdit = () => {
    const dueParts = splitDueParts(task.dueDate);
    const startParts = splitDueParts(task.startDate);
    setEditForm({
      title: task.title || "",
      description: task.description || "",
      assignees: getTaskAssignees(task).map((a) => a.email),
      dueDate: dueParts.date,
      dueTime: dueParts.time,
      startDate: startParts.date,
      startTime: startParts.time,
      status: getStoredStatus(task),
      priority:
        String(task.priority || "MEDIUM").toUpperCase() === "URGENT"
          ? "CRITICAL"
          : task.priority || "MEDIUM",
      assignmentEmail: getTaskAssignees(task)[0]?.email || "",
      category: task.category || "",
    });
    setModal("edit");
  };

  const openStatus = () => {
    setEditForm((f) => ({
      ...f,
      status: getStoredStatus(task),
      assignmentEmail: f.assignmentEmail || getTaskAssignees(task)[0]?.email || "",
    }));
    setModal("status");
  };

  const openReassign = () => {
    setEditForm((f) => ({
      ...f,
      assignees: getTaskAssignees(task).map((a) => a.email),
    }));
    setModal("reassign");
  };

  const toggleAssignee = (email) => {
    setEditForm((f) => {
      const current = f.assignees || [];
      const has = current.includes(email);
      return {
        ...f,
        assignees: has
          ? current.filter((x) => x !== email)
          : [...current, email],
      };
    });
  };

  const handleSaveEdit = async () => {
    if (!editForm.title?.trim()) {
      alert("Task name is required");
      return;
    }
    const nextStart = joinDueParts(editForm.startDate, editForm.startTime);
    const nextDue = joinDueParts(editForm.dueDate, editForm.dueTime);
    const originalStart = splitDueParts(task.startDate);
    const originalDue = splitDueParts(task.dueDate);
    if (
      editForm.startTime !== originalStart.time &&
      !isQuarterHourTime(editForm.startTime)
    ) {
      alert("Start time must be in 15-minute intervals (00, 15, 30, or 45).");
      return;
    }
    if (
      editForm.dueTime !== originalDue.time &&
      !isQuarterHourTime(editForm.dueTime)
    ) {
      alert("Deadline time must be in 15-minute intervals (00, 15, 30, or 45).");
      return;
    }
    if (nextStart && nextDue && new Date(nextDue).getTime() < new Date(nextStart).getTime()) {
      alert("Deadline must be after the start date and time.");
      return;
    }
    if (nextDue !== (task.dueDate || null)) {
      const ok = window.confirm(
        "Changing the deadline will recalculate Green/Orange/Red for incomplete assignees. Continue?"
      );
      if (!ok) return;
    }
    setSaving(true);
    try {
      await patchTask({
        title: editForm.title.trim(),
        description: editForm.description || "",
        assignees: editForm.assignees,
        assignee: editForm.assignees[0] || "",
        status: editForm.status,
        priority: editForm.priority,
        category: editForm.category || "",
        startDate: nextStart,
        dueDate: nextDue,
      });
      setModal(null);
    } catch (err) {
      alert(err.message || "Failed to save task");
    } finally {
      setSaving(false);
    }
  };

  const handleChangeStatus = async () => {
    if (editForm.status === "DONE") {
      const ok = window.confirm(
        "Mark this assignment as completed? Completed work will not move to Orange or Red."
      );
      if (!ok) return;
    }
    setSaving(true);
    try {
      await patchTask({
        status: editForm.status,
        assignmentEmail: editForm.assignmentEmail || undefined,
      });
      setModal(null);
    } catch (err) {
      alert(err.message || "Failed to update status");
    } finally {
      setSaving(false);
    }
  };

  const handleReassign = async () => {
    setSaving(true);
    try {
      await patchTask({
        assignees: editForm.assignees,
        assignee: editForm.assignees[0] || "",
      });
      setModal(null);
    } catch (err) {
      alert(err.message || "Failed to reassign");
    } finally {
      setSaving(false);
    }
  };

  const reviewedAssignment = task
    ? getTaskAssignees(task).find(
        (a) => String(a.status || "").toUpperCase() === "REVIEW"
      ) || null
    : null;

  const resetReviewForm = () => {
    setReviewDecision("");
    setReviewReason("");
    setReviewRemark("");
    setReviewAssignMode("SAME");
    setReviewOtherEmail("");
    setReviewError("");
  };

  const handleApproveReview = async () => {
    if (!reviewedAssignment?.email) {
      setReviewError("Reviewed assignment not found.");
      return;
    }
    const ok = window.confirm(
      "Mark this assignment as completed? Completed work will not move to Orange or Red."
    );
    if (!ok) return;
    setSaving(true);
    setReviewError("");
    setError("");
    try {
      await patchTask({
        status: "DONE",
        assignmentEmail: reviewedAssignment.email,
      });
      resetReviewForm();
    } catch (err) {
      setReviewError(err.message || "Failed to approve task.");
    } finally {
      setSaving(false);
    }
  };

  const handleReviewReassign = async () => {
    if (!reviewedAssignment?.email) {
      setReviewError("Reviewed assignment not found.");
      return;
    }
    if (
      reviewReason !== "CHANGES_REQUIRED" &&
      reviewReason !== "REJECTED"
    ) {
      setReviewError("Select Changes Required or Rejected.");
      return;
    }
    const remark = String(reviewRemark || "").trim();
    if (!remark) {
      setReviewError("Admin remark is required.");
      return;
    }
    const targetEmail =
      reviewAssignMode === "OTHER"
        ? String(reviewOtherEmail || "").trim().toLowerCase()
        : String(reviewedAssignment.email || "").trim().toLowerCase();
    if (!targetEmail) {
      setReviewError("Please select an employee.");
      return;
    }
    if (!reviewStartDate || !reviewStartTime || !reviewEndDate || !reviewEndTime) {
      setReviewError("Start and end date/time are required.");
      return;
    }
    if (!isQuarterHourTime(reviewStartTime) || !isQuarterHourTime(reviewEndTime)) {
      setReviewError(
        "Start and end times must be in 15-minute intervals (00, 15, 30, or 45)."
      );
      return;
    }
    const startIso = joinDueParts(reviewStartDate, reviewStartTime);
    const dueIso = joinDueParts(reviewEndDate, reviewEndTime);
    if (startIso && dueIso && new Date(dueIso).getTime() < new Date(startIso).getTime()) {
      setReviewError("End must be after the start date and time.");
      return;
    }
    setSaving(true);
    setReviewError("");
    setError("");
    try {
      const created = await createTask({
        sourceTaskId: task.taskId || taskId,
        assignmentEmail: reviewedAssignment.email,
        reassignmentReason: reviewReason,
        reassignmentRemark: remark,
        assignees: [targetEmail],
        assignee: targetEmail,
        startDate: startIso,
        dueDate: dueIso,
        description: reviewDescription,
      });
      const nextId = created?.taskId;
      if (nextId) {
        navigate(`/admin/tasks/${encodeURIComponent(nextId)}`);
        return;
      }
      await load();
    } catch (err) {
      setReviewError(err.message || "Failed to reassign task.");
    } finally {
      setSaving(false);
    }
  };

  const handleEmployeeStatus = async (nextStatus) => {
    const viewer = String(getLoggedInEmail() || "").trim().toLowerCase();
    const mine =
      task?.myAssignment ||
      getTaskAssignees(task).find(
        (a) => String(a.email || "").toLowerCase() === viewer
      ) ||
      null;
    const current = String(mine?.status || "").toUpperCase();
    const wanted = String(nextStatus || "").toUpperCase();
    if (!wanted || wanted === current || wanted === "CANCELLED" || wanted === "REVIEW") return;
    if (!employeeCanChangeStatus(mine || task, task.dueDate)) {
      setError(RED_ZONE_MESSAGE);
      return;
    }
    if (wanted === "DONE") {
      setCompleteRemark("");
      setCompleteError("");
      setModal("complete");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await updateTask({
        taskId: task.taskId || taskId,
        projectId: task.projectId,
        status: wanted,
        assignmentEmail: mine?.email || getLoggedInEmail(),
      });
      await load();
    } catch (err) {
      setError(err.message || "Failed to update task status.");
    } finally {
      setSaving(false);
    }
  };

  const closeCompletionModal = () => {
    setModal(null);
    setCompleteRemark("");
    setCompleteError("");
  };

  const handleEmployeeComplete = async () => {
    const viewer = String(getLoggedInEmail() || "").trim().toLowerCase();
    const mine =
      task?.myAssignment ||
      getTaskAssignees(task).find(
        (a) => String(a.email || "").toLowerCase() === viewer
      ) ||
      null;
    if (!employeeCanChangeStatus(mine || task, task.dueDate)) {
      setCompleteError(RED_ZONE_MESSAGE);
      return;
    }
    const remark = String(completeRemark || "").trim();
    if (!remark) {
      setCompleteError(COMPLETION_REMARK_REQUIRED);
      return;
    }
    setSaving(true);
    setCompleteError("");
    setError("");
    try {
      await updateTask({
        taskId: task.taskId || taskId,
        projectId: task.projectId,
        status: "DONE",
        assignmentEmail: mine?.email || getLoggedInEmail(),
        completionRemark: remark,
      });
      closeCompletionModal();
      await load();
    } catch (err) {
      setCompleteError(err.message || "Failed to update task status.");
    } finally {
      setSaving(false);
    }
  };

  const closeBlockerModal = () => {
    setModal(null);
    setBlockerRemark("");
    setBlockerError("");
  };

  const openBlockerModal = () => {
    setBlockerError("");
    setModal("blocker");
  };

  const handleReportBlocker = async () => {
    const remark = String(blockerRemark || "").trim();
    if (!remark) {
      setBlockerError(BLOCKER_REMARK_REQUIRED);
      return;
    }
    setSaving(true);
    setBlockerError("");
    setError("");
    try {
      await reportTaskBlocker(task.taskId || taskId, remark);
      closeBlockerModal();
      await load();
    } catch (err) {
      setBlockerError(err.message || "Failed to report blocker.");
    } finally {
      setSaving(false);
    }
  };

  if (loading && !task) {
    return (
      <Layout>
        <div style={pageCard}>
          <p style={{ color: colors.textMuted }}>Loading task details...</p>
        </div>
      </Layout>
    );
  }

  if (!task) {
    return (
      <Layout>
        <div style={pageCard}>
          <p style={{ color: colors.error }}>{error || "Task not found."}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate(employeeView ? "/work" : "/admin/tasks")}
          >
            {employeeView ? "Back to My Tasks" : "Back to Tasks"}
          </Button>
        </div>
      </Layout>
    );
  }

  const assignees = getTaskAssignees(task);
  const assigneeNames = assignees
    .map((a) => {
      const info = personLabel(users, a.email);
      const profile = (task.assigneeProfiles || []).find(
        (p) => String(p.email).toLowerCase() === String(a.email).toLowerCase()
      );
      return profile?.name || info.name;
    })
    .join(", ");
  const creator = task.createdByName || creatorName || personLabel(users, task.createdBy).name;
  const zone = getTaskZone(task);
  const timing = getTaskTiming(task);
  const viewerEmail = String(getLoggedInEmail() || "").trim().toLowerCase();
  const mine =
    task.myAssignment ||
    assignees.find(
      (a) => String(a.email || "").toLowerCase() === viewerEmail
    ) ||
    null;
  const employeeStatus = String(mine?.status || "").toUpperCase();
  const employeeBlockerStatus = String(mine?.blockerStatus || "")
    .trim()
    .toUpperCase();
  const showReportBlocker =
    employeeView &&
    !!mine &&
    employeeStatus === "IN_PROGRESS" &&
    employeeBlockerStatus !== "ACTIVE";
  const showActiveBlocker =
    employeeView && !!mine && employeeBlockerStatus === "ACTIVE";
  const employeeZone = mine?.zone || zone;
  const employeeTiming = mine?.timing || timing;
  const headerStatus = employeeView ? employeeStatus || "TODO" : task;
  const headerZone = employeeView ? employeeZone : zone;
  const headerTiming = employeeView ? employeeTiming : timing;
  const headerStatusValue = employeeView ? employeeStatus : task.status;
  const employeeLocked =
    !mine ||
    employeeStatus === "DONE" ||
    employeeStatus === "REVIEW" ||
    employeeStatus === "CANCELLED" ||
    !employeeCanChangeStatus(mine, task.dueDate);
  const employeeIsRed =
    !!mine &&
    employeeStatus !== "DONE" &&
    employeeStatus !== "REVIEW" &&
    employeeStatus !== "CANCELLED" &&
    String(employeeZone).toUpperCase() === "RED";
  const showEmployeeSelect =
    employeeView &&
    !!mine &&
    employeeStatus !== "DONE" &&
    employeeStatus !== "REVIEW" &&
    employeeStatus !== "CANCELLED";
  const timeline = [...activity].sort((a, b) => {
    const ta = new Date(a.timestamp || 0).getTime();
    const tb = new Date(b.timestamp || 0).getTime();
    return ta - tb;
  });

  return (
    <Layout>
      <div style={{ ...pageCard, maxWidth: 760 }}>
        {error ? (
          <div
            className="dgv-alert dgv-alert--error"
            style={{ marginBottom: 12 }}
          >
            {error}
          </div>
        ) : null}

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 20,
            alignItems: "flex-start",
          }}
        >
          <div>
            <h2 style={{ ...pageTitle, marginBottom: 8 }}>Task Details</h2>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate(employeeView ? "/work" : "/admin/tasks")}
            >
              {employeeView ? "Back to My Tasks" : "Back to Tasks"}
            </Button>
          </div>
          {employeeView ? null : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Button type="button" onClick={openEdit}>
              Edit Task
            </Button>
            <Button type="button" variant="outline" onClick={openStatus}>
              Change Status
            </Button>
            <Button type="button" variant="outline" onClick={openReassign}>
              Reassign
            </Button>
          </div>
          )}
        </div>

        <section style={sectionBox}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
              alignItems: "flex-start",
              marginBottom: 16,
            }}
          >
            <div style={{ minWidth: 0, flex: "1 1 180px" }}>
              <Label>TASK NAME</Label>
              <h3 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>
                {task.title}
              </h3>
            </div>
            {showReportBlocker ? (
              <div style={{ flex: "0 0 auto" }}>
                <Button
                  type="button"
                  variant="outline"
                  onClick={openBlockerModal}
                >
                  Report Blocker
                </Button>
              </div>
            ) : null}
          </div>
          <Label>STATUS</Label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {employeeView && showEmployeeSelect ? (
              <select
                id="employee-assignment-status"
                className="dgv-select"
                aria-label="Update your assignment status"
                style={{ ...formSelect, maxWidth: 280, marginBottom: 0 }}
                value={employeeStatus || "TODO"}
                disabled={saving || employeeLocked}
                onChange={(e) => handleEmployeeStatus(e.target.value)}
              >
                {EMPLOYEE_STATUS_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            ) : (
              <StatusBadge taskOrStatus={headerStatus} />
            )}
            <ZoneBadge zone={headerZone} status={headerStatusValue} size="md" />
          </div>
          {employeeView && employeeStatus === "REVIEW" ? (
            <p style={{ margin: "8px 0 0", color: colors.textMuted, fontSize: 13 }}>
              {REVIEW_WAIT_HEADER}
            </p>
          ) : null}
          {employeeView && employeeIsRed ? (
            <p style={{ margin: "8px 0 0", color: colors.error, fontSize: 13 }}>
              {RED_ZONE_MESSAGE}
            </p>
          ) : null}
          {headerTiming ? (
            <p style={{ margin: "10px 0 0", fontSize: 13, color: colors.textMuted }}>
              {headerTiming}
            </p>
          ) : null}
          {showActiveBlocker ? (
            <ActiveBlockerNotice
              reportedAt={mine.blockerReportedAt}
              style={{ margin: "10px 0 0" }}
            />
          ) : null}
        </section>

        {employeeView ? (
          <EmployeeTaskBody
            task={task}
            mine={mine}
            employeeStatus={employeeStatus}
            employeeZone={employeeZone}
            employeeTiming={employeeTiming}
            showActiveBlocker={showActiveBlocker}
            timeline={timeline}
            users={users}
            attachments={attachments}
            attachmentError={attachmentError}
            uploadingAttachment={uploadingAttachment}
            downloadingAttachmentId={downloadingAttachmentId}
            onSelectAttachment={handleAttachmentFile}
            onDownloadAttachment={handleAttachmentDownload}
          />
        ) : (
        <>
        {!employeeView && reviewedAssignment ? (
          <AdminReviewPanel
            assignment={reviewedAssignment}
            users={users}
            decision={reviewDecision}
            onDecision={setReviewDecision}
            reason={reviewReason}
            onReason={setReviewReason}
            remark={reviewRemark}
            onRemark={setReviewRemark}
            assignMode={reviewAssignMode}
            onAssignMode={setReviewAssignMode}
            otherEmail={reviewOtherEmail}
            onOtherEmail={setReviewOtherEmail}
            description={reviewDescription}
            onDescription={setReviewDescription}
            startDate={reviewStartDate}
            onStartDate={setReviewStartDate}
            startTime={reviewStartTime}
            onStartTime={setReviewStartTime}
            endDate={reviewEndDate}
            onEndDate={setReviewEndDate}
            endTime={reviewEndTime}
            onEndTime={setReviewEndTime}
            error={reviewError}
            saving={saving}
            onCancel={resetReviewForm}
            onApprove={handleApproveReview}
            onReassign={handleReviewReassign}
          />
        ) : null}
        <section style={{ ...sectionBox, marginTop: 14 }}>
          <h3 style={sectionTitle}>TASK INFORMATION</h3>
          <InfoRow label="Task ID" value={displayTaskId(task.taskId)} />
          {task.sourceTaskId ? (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 2 }}>
                Source task:
              </div>
              <button
                type="button"
                className="dgv-btn dgv-btn--outline"
                onClick={() =>
                  navigate(
                    `/admin/tasks/${encodeURIComponent(task.sourceTaskId)}`
                  )
                }
              >
                {displayTaskId(task.sourceTaskId)}
              </button>
            </div>
          ) : null}
          <InfoRow
            label="Author"
            value={
              creator || task.createdByName || task.createdBy
                ? `${creator || task.createdByName || task.createdBy}${
                    task.createdBy &&
                    creator &&
                    creator !== task.createdBy
                      ? `\n${task.createdBy}`
                      : ""
                  }`
                : "—"
            }
          />
          <InfoRow
            label="Assigned To"
            value={
              assignees.length
                ? `${assigneeNames}\n${assignees.map((a) => a.email).join("\n")}`
                : "Unassigned"
            }
          />
          <InfoRow label="Priority" value={priorityLabel(task.priority)} />
          <InfoRow label="Category" value={task.category || "—"} />
          <InfoRow label="Created Date" value={formatTaskDate(task.createdAt)} />
          <InfoRow label="Created Time" value={formatTaskTime(task.createdAt)} />
          <InfoRow
            label="Assigned / Start Date"
            value={formatTaskDate(task.startDate || task.createdAt)}
          />
          <InfoRow
            label="Assigned / Start Time"
            value={formatTaskTime(task.startDate || task.createdAt)}
          />
          <InfoRow
            label="Due Date"
            value={formatTaskDate(task.dueDate)}
            danger={zone === "RED" || zone === "ORANGE"}
          />
          <InfoRow
            label="Due Time"
            value={formatTaskTime(task.dueDate)}
            danger={zone === "RED" || zone === "ORANGE"}
          />
          <InfoRow
            label="Current Zone"
            value={`${zoneDisplay(zone, task.status).emoji} ${zoneDisplay(zone, task.status).label}`.trim()}
          />
          <InfoRow
            label="Duration"
            value={formatTaskDuration(task) || "—"}
          />
        </section>

        <section style={{ ...sectionBox, marginTop: 14 }}>
          <h3 style={sectionTitle}>INDIVIDUAL EMPLOYEE PROGRESS</h3>
          {assignees.length === 0 ? (
            <p style={{ margin: 0, color: colors.textMuted }}>No assignees yet.</p>
          ) : (
            assignees.map((a) => {
              const info = personLabel(users, a.email);
              const profile = (task.assigneeProfiles || []).find(
                (p) =>
                  String(p.email).toLowerCase() === String(a.email).toLowerCase()
              );
              const name = profile?.name || info.name;
              return (
                <div
                  key={a.email}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    alignItems: "center",
                    flexWrap: "wrap",
                    padding: "10px 0",
                    borderBottom: "1px solid var(--dgv-border)",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700 }}>{name}</div>
                    <div style={{ fontSize: 12, color: colors.textMuted }}>
                      {a.email}
                    </div>
                    {a.completedAt ? (
                      <div style={{ fontSize: 12, color: colors.textMuted }}>
                        Completed {formatTaskDateTime(a.completedAt)}
                      </div>
                    ) : a.timing ? (
                      <div style={{ fontSize: 12, color: colors.textMuted }}>
                        {a.timing}
                      </div>
                    ) : null}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <ZoneBadge zone={a.zone} status={a.status} />
                    <StatusBadge taskOrStatus={a.status} />
                  </div>
                </div>
              );
            })
          )}
        </section>

        <section style={{ ...sectionBox, marginTop: 14 }}>
          <h3 style={sectionTitle}>TASK DESCRIPTION</h3>
          <p
            style={{
              margin: 0,
              whiteSpace: "pre-wrap",
              lineHeight: 1.6,
              color: colors.text,
            }}
          >
            {task.description?.trim()
              ? task.description
              : "No description added."}
          </p>
        </section>

        <TaskAttachmentsSection
          attachments={attachments}
          users={users}
          error={attachmentError}
          uploading={uploadingAttachment}
          downloadingId={downloadingAttachmentId}
          onSelectFile={handleAttachmentFile}
          onDownload={handleAttachmentDownload}
        />

        <section style={{ ...sectionBox, marginTop: 14 }}>
          <h3 style={sectionTitle}>Task Timeline</h3>
          {timeline.length === 0 ? (
            <p style={{ margin: 0, color: colors.textMuted }}>
              No timeline events yet.
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {timeline.map((ev) => (
                <li
                  key={ev.activityId || ev.SK}
                  style={{
                    padding: "12px 0 12px 14px",
                    borderLeft: "2px solid var(--dgv-accent)",
                    marginBottom: 4,
                  }}
                >
                  <div
                    style={{
                      fontSize: 12,
                      color: colors.textMuted,
                      marginBottom: 4,
                    }}
                  >
                    {formatTaskDateTime(ev.timestamp)}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {friendlyActivityText(ev, users)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        </>
        )}
      </div>

      {modal === "edit" ? (
        <Modal title="Edit Task" onClose={() => setModal(null)}>
          <label style={formLabel}>Task Name</label>
          <input
            style={formInput}
            value={editForm.title}
            onChange={(e) =>
              setEditForm({ ...editForm, title: e.target.value })
            }
          />
          <label style={formLabel}>Task Description</label>
          <textarea
            style={{ ...formInput, minHeight: 90 }}
            value={editForm.description}
            onChange={(e) =>
              setEditForm({ ...editForm, description: e.target.value })
            }
          />
          <label style={formLabel}>Assigned Employees</label>
          <div
            style={{
              maxHeight: 160,
              overflowY: "auto",
              border: "1px solid var(--dgv-border)",
              borderRadius: 10,
              padding: 8,
              marginBottom: 16,
            }}
          >
            {selectableTaskAssignees(users).map((u) => (
              <label
                key={u.email}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                  padding: "4px 2px",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                    checked={(editForm.assignees || []).includes(u.email)}
                  onChange={() => toggleAssignee(u.email)}
                />
                {u.name ? `${u.name} (${u.email})` : u.email}
              </label>
            ))}
          </div>
          <label style={formLabel}>Priority</label>
          <select
            style={formSelect}
            value={
              editForm.priority === "URGENT" ? "CRITICAL" : editForm.priority
            }
            onChange={(e) =>
              setEditForm({ ...editForm, priority: e.target.value })
            }
          >
            {TASK_PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <label style={formLabel}>Category</label>
          <select
            style={formSelect}
            value={editForm.category || ""}
            onChange={(e) =>
              setEditForm({ ...editForm, category: e.target.value })
            }
          >
            <option value="">Select category</option>
            {TASK_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <label style={formLabel}>Start Date</label>
          <input
            type="date"
            style={formInput}
            value={editForm.startDate}
            onChange={(e) =>
              setEditForm({ ...editForm, startDate: e.target.value })
            }
          />
          <label style={formLabel}>Start Time</label>
          <input
            type="time"
            step={900}
            style={formInput}
            value={editForm.startTime}
            onChange={(e) =>
              setEditForm({ ...editForm, startTime: e.target.value })
            }
          />
          <label style={formLabel}>Due Date</label>
          <input
            type="date"
            style={formInput}
            value={editForm.dueDate}
            onChange={(e) =>
              setEditForm({ ...editForm, dueDate: e.target.value })
            }
          />
          <label style={formLabel}>Due Time</label>
          <input
            type="time"
            step={900}
            style={formInput}
            value={editForm.dueTime}
            onChange={(e) =>
              setEditForm({ ...editForm, dueTime: e.target.value })
            }
          />
          <label style={formLabel}>Status</label>
          <select
            style={formSelect}
            value={
              editForm.status === "BACKLOG" ? "TODO" : editForm.status
            }
            onChange={(e) =>
              setEditForm({ ...editForm, status: e.target.value })
            }
          >
            {TASK_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <div style={modalActions}>
            <Button type="button" variant="outline" onClick={() => setModal(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              loading={saving}
              disabled={saving}
              onClick={handleSaveEdit}
            >
              Save Changes
            </Button>
          </div>
        </Modal>
      ) : null}

      {modal === "status" ? (
        <Modal title="Change Status" onClose={() => setModal(null)}>
          <p style={{ marginTop: 0, color: colors.textMuted, fontSize: 13 }}>
            Current: <StatusBadge taskOrStatus={task} />
          </p>
          {assignees.length > 1 ? (
            <>
              <label style={formLabel}>Employee</label>
              <select
                style={formSelect}
                value={editForm.assignmentEmail}
                onChange={(e) =>
                  setEditForm({ ...editForm, assignmentEmail: e.target.value })
                }
              >
                {assignees.map((a) => (
                  <option key={a.email} value={a.email}>
                    {personLabel(users, a.email).name} ({a.email})
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <label style={formLabel}>New Status</label>
          <select
            style={formSelect}
            value={
              editForm.status === "BACKLOG" ? "TODO" : editForm.status
            }
            onChange={(e) =>
              setEditForm({ ...editForm, status: e.target.value })
            }
          >
            {TASK_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label} — {s.hint}
              </option>
            ))}
          </select>
          <div style={modalActions}>
            <Button type="button" variant="outline" onClick={() => setModal(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              loading={saving}
              disabled={saving}
              onClick={handleChangeStatus}
            >
              Update Status
            </Button>
          </div>
        </Modal>
      ) : null}

      {modal === "reassign" ? (
        <Modal title="Reassign Task" onClose={() => setModal(null)}>
          <label style={formLabel}>Assigned Employees</label>
          <div
            style={{
              maxHeight: 220,
              overflowY: "auto",
              border: "1px solid var(--dgv-border)",
              borderRadius: 10,
              padding: 8,
              marginBottom: 16,
            }}
          >
            {selectableTaskAssignees(users).map((u) => (
              <label
                key={u.email}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                  padding: "4px 2px",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                    checked={(editForm.assignees || []).includes(u.email)}
                  onChange={() => toggleAssignee(u.email)}
                />
                {u.name ? `${u.name} (${u.email})` : u.email}
              </label>
            ))}
          </div>
          <div style={modalActions}>
            <Button type="button" variant="outline" onClick={() => setModal(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              loading={saving}
              disabled={saving}
              onClick={handleReassign}
            >
              Save
            </Button>
          </div>
        </Modal>
      ) : null}

      {modal === "complete" ? (
        <Modal title={COMPLETION_MODAL_TITLE} onClose={closeCompletionModal}>
          <label style={formLabel} htmlFor="completion-remark">
            Completion Remark *
          </label>
          <p style={{ margin: "0 0 8px", fontSize: 13, color: colors.textMuted }}>
            {COMPLETION_REMARK_HELPER}
          </p>
          <textarea
            id="completion-remark"
            aria-label="Completion Remark"
            style={{ ...formInput, minHeight: 110 }}
            value={completeRemark}
            onChange={(e) => {
              setCompleteRemark(e.target.value);
              if (completeError) setCompleteError("");
            }}
          />
          {completeError ? (
            <p style={{ margin: "0 0 8px", color: colors.error, fontSize: 13 }}>
              {completeError}
            </p>
          ) : null}
          <div style={modalActions}>
            <Button
              type="button"
              variant="outline"
              onClick={closeCompletionModal}
            >
              Cancel
            </Button>
            <Button
              type="button"
              loading={saving}
              disabled={saving}
              onClick={handleEmployeeComplete}
            >
              {COMPLETION_SUBMIT_LABEL}
            </Button>
          </div>
        </Modal>
      ) : null}

      {modal === "blocker" ? (
        <Modal title="Report Blocker" onClose={closeBlockerModal}>
          <p style={{ margin: "0 0 12px", fontSize: 13, color: colors.textMuted }}>
            {BLOCKER_REMARK_HELPER}
          </p>
          <label style={formLabel} htmlFor="blocker-remark">
            Blocker Remark *
          </label>
          <textarea
            id="blocker-remark"
            aria-label="Blocker Remark"
            placeholder={BLOCKER_REMARK_PLACEHOLDER}
            style={{ ...formInput, minHeight: 110 }}
            value={blockerRemark}
            onChange={(e) => {
              setBlockerRemark(e.target.value);
              if (blockerError) setBlockerError("");
            }}
          />
          {blockerError ? (
            <p style={{ margin: "8px 0 0", color: colors.error, fontSize: 13 }}>
              {blockerError}
            </p>
          ) : null}
          <div style={modalActions}>
            <Button
              type="button"
              variant="outline"
              onClick={closeBlockerModal}
            >
              Cancel
            </Button>
            <Button
              type="button"
              loading={saving}
              disabled={saving}
              onClick={handleReportBlocker}
            >
              Report Blocker
            </Button>
          </div>
        </Modal>
      ) : null}
    </Layout>
  );
}

function radioRow(style) {
  return {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    margin: "8px 0 14px",
    ...style,
  };
}

function AdminReviewPanel({
  assignment,
  users,
  decision,
  onDecision,
  reason,
  onReason,
  remark,
  onRemark,
  assignMode,
  onAssignMode,
  otherEmail,
  onOtherEmail,
  description,
  onDescription,
  startDate,
  onStartDate,
  startTime,
  onStartTime,
  endDate,
  onEndDate,
  endTime,
  onEndTime,
  error,
  saving,
  onCancel,
  onApprove,
  onReassign,
}) {
  const employee = personLabel(users, assignment.email);
  const employeeName = employee.name || assignment.email;
  return (
    <section style={{ ...sectionBox, marginTop: 14 }}>
      <h3 style={sectionTitle}>Review Task</h3>
      <Label>CURRENT STATUS</Label>
      <div style={{ marginBottom: 12 }}>
        <StatusBadge taskOrStatus="REVIEW" />
      </div>
      {assignment.completionRemark ? (
        <div style={{ marginBottom: 14 }}>
          <Label>EMPLOYEE SUBMISSION REMARK</Label>
          <p style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 14 }}>
            {assignment.completionRemark}
          </p>
        </div>
      ) : (
        <p style={{ margin: "0 0 14px", color: colors.textMuted, fontSize: 13 }}>
          No submission remark was provided.
        </p>
      )}
      <Label>REVIEW DECISION</Label>
      <div style={radioRow()}>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="radio"
            name="review-decision"
            value="APPROVE"
            checked={decision === "APPROVE"}
            onChange={() => onDecision("APPROVE")}
          />
          Approve & Complete
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="radio"
            name="review-decision"
            value="REASSIGN"
            checked={decision === "REASSIGN"}
            onChange={() => onDecision("REASSIGN")}
          />
          Reassign
        </label>
      </div>

      {decision === "REASSIGN" ? (
        <>
          <Label>REASON</Label>
          <div style={radioRow()}>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="radio"
                name="review-reason"
                value="CHANGES_REQUIRED"
                checked={reason === "CHANGES_REQUIRED"}
                onChange={() => onReason("CHANGES_REQUIRED")}
              />
              Changes Required
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="radio"
                name="review-reason"
                value="REJECTED"
                checked={reason === "REJECTED"}
                onChange={() => onReason("REJECTED")}
              />
              Rejected
            </label>
          </div>
          <label style={formLabel} htmlFor="admin-review-remark">
            Admin Remark *
          </label>
          <textarea
            id="admin-review-remark"
            aria-label="Admin Remark"
            style={{ ...formInput, minHeight: 90 }}
            value={remark}
            onChange={(e) => onRemark(e.target.value)}
          />
          <Label>ASSIGN TO</Label>
          <div style={radioRow()}>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="radio"
                name="review-assign-to"
                value="SAME"
                checked={assignMode === "SAME"}
                onChange={() => onAssignMode("SAME")}
              />
              Same Employee — {employeeName}
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="radio"
                name="review-assign-to"
                value="OTHER"
                checked={assignMode === "OTHER"}
                onChange={() => onAssignMode("OTHER")}
              />
              Another Employee
            </label>
          </div>
          {assignMode === "OTHER" ? (
            <>
              <label style={formLabel} htmlFor="review-other-employee">
                Select Employee
              </label>
              <select
                id="review-other-employee"
                aria-label="Select Employee"
                style={formSelect}
                value={otherEmail}
                onChange={(e) => onOtherEmail(e.target.value)}
              >
                <option value="">Select employee</option>
                {selectableTaskAssignees(users)
                  .filter(
                    (u) =>
                      String(u.email || "").toLowerCase() !==
                      String(assignment.email || "").toLowerCase()
                  )
                  .map((u) => (
                    <option key={u.email} value={u.email}>
                      {u.name ? `${u.name} (${u.email})` : u.email}
                    </option>
                  ))}
              </select>
            </>
          ) : null}
          <p style={{ margin: "0 0 8px", fontSize: 12, color: colors.textMuted }}>
            Copied from original task: name, project, category, and priority.
            Description and schedule can be overridden below.
          </p>
          <label style={formLabel} htmlFor="review-description">
            Description
          </label>
          <textarea
            id="review-description"
            aria-label="Description"
            style={{ ...formInput, minHeight: 80 }}
            value={description}
            onChange={(e) => onDescription(e.target.value)}
          />
          <Label>NEW SCHEDULE</Label>
          <label style={formLabel} htmlFor="review-start-date">
            Start Date
          </label>
          <input
            id="review-start-date"
            aria-label="Start Date"
            type="date"
            style={formInput}
            value={startDate}
            onChange={(e) => onStartDate(e.target.value)}
          />
          <label style={formLabel} htmlFor="review-start-time">
            Start Time
          </label>
          <input
            id="review-start-time"
            aria-label="Start Time"
            type="time"
            step={900}
            style={formInput}
            value={startTime}
            onChange={(e) => onStartTime(e.target.value)}
          />
          <label style={formLabel} htmlFor="review-end-date">
            End Date
          </label>
          <input
            id="review-end-date"
            aria-label="End Date"
            type="date"
            style={formInput}
            value={endDate}
            onChange={(e) => onEndDate(e.target.value)}
          />
          <label style={formLabel} htmlFor="review-end-time">
            End Time
          </label>
          <input
            id="review-end-time"
            aria-label="End Time"
            type="time"
            step={900}
            style={formInput}
            value={endTime}
            onChange={(e) => onEndTime(e.target.value)}
          />
        </>
      ) : null}

      {error ? (
        <p style={{ margin: "8px 0 0", color: colors.error, fontSize: 13 }}>
          {error}
        </p>
      ) : null}
      {decision ? (
        <div style={{ ...modalActions, marginTop: 16 }}>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          {decision === "APPROVE" ? (
            <Button
              type="button"
              loading={saving}
              disabled={saving}
              onClick={onApprove}
            >
              Approve & Complete
            </Button>
          ) : (
            <Button
              type="button"
              loading={saving}
              disabled={saving}
              onClick={onReassign}
            >
              Reassign Task
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}

const ATTACHMENT_ACCEPT = TASK_ATTACHMENT_EXTS.join(",");

function TaskAttachmentsSection({
  attachments,
  users,
  error,
  uploading,
  downloadingId,
  onSelectFile,
  onDownload,
}) {
  const items = Array.isArray(attachments) ? attachments : [];
  return (
    <section style={{ ...sectionBox, marginTop: 14 }}>
      <h3 style={sectionTitle}>ATTACHMENTS</h3>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: colors.textMuted }}>
        Attachments are optional. You can complete this task without attaching a
        file.
      </p>
      <label style={{ ...formLabel, display: "block" }} htmlFor="task-attachment-file">
        Attach a file
      </label>
      <input
        id="task-attachment-file"
        type="file"
        accept={ATTACHMENT_ACCEPT}
        disabled={uploading}
        aria-label="Attach a file"
        style={{ ...formInput, padding: "8px 10px" }}
        onChange={(e) => {
          const file = e.target.files && e.target.files[0];
          e.target.value = "";
          if (file) onSelectFile(file);
        }}
      />
      {uploading ? (
        <p style={{ margin: "8px 0 0", fontSize: 13, color: colors.textMuted }}>
          Uploading…
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          style={{ margin: "8px 0 0", fontSize: 13, color: "var(--dgv-danger)" }}
        >
          {error}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p style={{ margin: "14px 0 0", color: colors.textMuted }}>
          No attachments yet.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: "14px 0 0", padding: 0 }}>
          {items.map((item) => {
            const id = item.attachmentId || item.s3Key || item.fileName;
            const who = personLabel(users, item.uploadedBy).name || item.uploadedBy || "—";
            return (
              <li
                key={id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                  alignItems: "center",
                  padding: "10px 0",
                  borderTop: "1px solid var(--dgv-border)",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, wordBreak: "break-word" }}>
                    {item.fileName || "Attachment"}
                  </div>
                  <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 4 }}>
                    {who}
                    {item.uploadedAt ? ` · ${formatTaskDateTime(item.uploadedAt)}` : ""}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={uploading || downloadingId === id}
                  onClick={() => onDownload(item)}
                >
                  Download {item.fileName || "file"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function EmployeeTaskBody({
  task,
  mine,
  employeeStatus,
  employeeZone,
  employeeTiming,
  showActiveBlocker,
  timeline,
  users,
  attachments,
  attachmentError,
  uploadingAttachment,
  downloadingAttachmentId,
  onSelectAttachment,
  onDownloadAttachment,
}) {
  return (
    <>
      <section style={{ ...sectionBox, marginTop: 14 }}>
        <h3 style={sectionTitle}>TASK INFORMATION</h3>
        <InfoRow label="Task ID" value={displayTaskId(task.taskId)} />
        <InfoRow
          label="Project"
          value={task.projectName || task.projectId || "—"}
        />
        <InfoRow label="Priority" value={priorityLabel(task.priority)} />
        <InfoRow label="Category" value={task.category || "—"} />
      </section>

      <section style={{ ...sectionBox, marginTop: 14 }}>
        <h3 style={sectionTitle}>TASK DESCRIPTION</h3>
        <p
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            lineHeight: 1.6,
            color: colors.text,
          }}
        >
          {task.description?.trim()
            ? task.description
            : "No description added."}
        </p>
      </section>

      <TaskAttachmentsSection
        attachments={attachments}
        users={users}
        error={attachmentError}
        uploading={uploadingAttachment}
        downloadingId={downloadingAttachmentId}
        onSelectFile={onSelectAttachment}
        onDownload={onDownloadAttachment}
      />

      <section style={{ ...sectionBox, marginTop: 14 }}>
        <h3 style={sectionTitle}>SCHEDULE</h3>
        <InfoRow
          label="Start date"
          value={formatTaskDate(task.startDate || task.createdAt)}
        />
        <InfoRow
          label="Start time"
          value={formatTaskTime(task.startDate || task.createdAt)}
        />
        <InfoRow
          label="Deadline date"
          value={formatTaskDate(task.dueDate)}
          danger={employeeZone === "RED" || employeeZone === "ORANGE"}
        />
        <InfoRow
          label="Deadline time"
          value={formatTaskTime(task.dueDate)}
          danger={employeeZone === "RED" || employeeZone === "ORANGE"}
        />
        <InfoRow label="Due in" value={employeeTiming || "—"} />
        <InfoRow
          label="Current Zone"
          value={`${zoneDisplay(employeeZone, employeeStatus).emoji} ${
            zoneDisplay(employeeZone, employeeStatus).label
          }`.trim()}
        />
        <InfoRow label="Duration" value={formatTaskDuration(task) || "—"} />
      </section>

      <section style={{ ...sectionBox, marginTop: 14 }}>
        <h3 style={sectionTitle}>YOUR ASSIGNMENT</h3>
        {!mine ? (
          <p style={{ margin: 0, color: colors.textMuted }}>
            No assignment found for your account.
          </p>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <StatusBadge taskOrStatus={employeeStatus} />
              <ZoneBadge zone={employeeZone} status={employeeStatus} />
            </div>
            {showActiveBlocker ? (
              <ActiveBlockerNotice
                reportedAt={mine.blockerReportedAt}
                style={{ margin: "0 0 12px" }}
              />
            ) : null}
            {employeeTiming ? (
              <p style={{ margin: "0 0 12px", fontSize: 13, color: colors.textMuted }}>
                {employeeTiming}
              </p>
            ) : null}
            {mine.completedAt ? (
              <p style={{ margin: "0 0 12px", fontSize: 13, color: colors.textMuted }}>
                Completed {formatTaskDateTime(mine.completedAt)}
              </p>
            ) : null}
            {mine.completionRemark ? (
              <p style={{ margin: "0 0 12px", fontSize: 14, whiteSpace: "pre-wrap" }}>
                <strong>
                  {employeeStatus === "REVIEW"
                    ? "Review Submission Remark"
                    : "Completion Remark"}
                </strong>
                <br />
                {mine.completionRemark}
              </p>
            ) : null}
            {employeeStatus === "REVIEW" ? (
              <p style={{ margin: 0, color: colors.textMuted, fontSize: 13 }}>
                {REVIEW_WAIT_ASSIGNMENT}
              </p>
            ) : null}
            {employeeStatus === "DONE" ? (
              <p style={{ margin: 0, color: colors.textMuted, fontSize: 13 }}>
                Completed assignments cannot be reopened.
              </p>
            ) : null}
            {employeeStatus === "CANCELLED" ? (
              <p style={{ margin: 0, color: colors.textMuted, fontSize: 13 }}>
                This assignment is cancelled and cannot be updated.
              </p>
            ) : null}
          </>
        )}
      </section>

      <section style={{ ...sectionBox, marginTop: 14 }}>
        <h3 style={sectionTitle}>Task Activity</h3>
        {timeline.length === 0 ? (
          <p style={{ margin: 0, color: colors.textMuted }}>
            No timeline events yet.
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {timeline.map((ev) => (
              <li
                key={ev.activityId || ev.SK}
                style={{
                  padding: "12px 0 12px 14px",
                  borderLeft: "2px solid var(--dgv-accent)",
                  marginBottom: 4,
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    color: colors.textMuted,
                    marginBottom: 4,
                  }}
                >
                  {formatTaskDateTime(ev.timestamp)}
                </div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  {friendlyActivityText(ev, users)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function ActiveBlockerNotice({ reportedAt, style }) {
  return (
    <div style={style}>
      <p
        style={{
          margin: 0,
          fontSize: 13,
          fontWeight: 700,
          color: colors.text,
        }}
      >
        Blocker Reported
      </p>
      {reportedAt ? (
        <p style={{ margin: "4px 0 0", fontSize: 13, color: colors.textMuted }}>
          Reported: {formatTaskDateTime(reportedAt)}
        </p>
      ) : null}
    </div>
  );
}

function Label({ children }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.6,
        color: colors.textMuted,
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

function InfoRow({ label, value, danger }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 2 }}>
        {label}:
      </div>
      <div
        style={{
          fontWeight: 600,
          fontSize: 14,
          whiteSpace: "pre-line",
          color: danger ? "var(--dgv-danger)" : colors.text,
          wordBreak: "break-word",
        }}
      >
        {value}
      </div>
    </div>
  );
}

const sectionBox = {
  padding: 18,
  borderRadius: 12,
  border: "1px solid var(--dgv-border)",
  background: "var(--dgv-surface-solid)",
};

const sectionTitle = {
  margin: "0 0 14px",
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: 0.5,
  color: colors.textMuted,
};

const modalActions = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 16,
};
