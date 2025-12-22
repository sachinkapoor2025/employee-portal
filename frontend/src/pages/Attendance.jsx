import { useState } from "react";
import Layout from "../components/Layout";

export default function Attendance() {
  const [hours, setHours] = useState("");
  const [status, setStatus] = useState("PRESENT");

  const submitAttendance = async () => {
    const token = localStorage.getItem("token");

    await fetch(`${process.env.REACT_APP_API_URL}/attendance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token
      },
      body: JSON.stringify({ hours, status })
    });

    alert("Attendance saved");
  };

  return (
    <Layout>
      <div style={{ backgroundColor: "rgba(255,255,255,0.9)", padding: "24px", borderRadius: "12px" }}>
        <h2>Attendance</h2>

        <input
          placeholder="Hours"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          style={{ padding: "10px", margin: "10px 0", borderRadius: "4px", border: "1px solid #ccc" }}
        />

        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          style={{ padding: "10px", margin: "10px 0", borderRadius: "4px", border: "1px solid #ccc" }}
        >
          <option value="PRESENT">Present</option>
          <option value="LEAVE">Leave</option>
          <option value="HOLIDAY">Holiday</option>
          <option value="SICK">Sick</option>
        </select>

        <br /><br />

        <button
          onClick={submitAttendance}
          style={{
            padding: "10px 20px",
            backgroundColor: "#1976d2",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer"
          }}
        >
          Submit
        </button>
      </div>
    </Layout>
  );
}
