import { useState } from "react";

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
    <div>
      <h2>Attendance</h2>

      <input
        placeholder="Hours"
        value={hours}
        onChange={(e) => setHours(e.target.value)}
      />

      <select value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="PRESENT">Present</option>
        <option value="LEAVE">Leave</option>
        <option value="HOLIDAY">Holiday</option>
        <option value="SICK">Sick</option>
      </select>

      <br /><br />

      <button onClick={submitAttendance}>Submit</button>
    </div>
  );
}
