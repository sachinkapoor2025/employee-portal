import { useState } from "react";
import { requestAccess } from "../services/auth";

export default function RequestAccess() {
  const [message, setMessage] = useState("");

  const handleRequest = async () => {
    try {
      await requestAccess();
      setMessage("✅ Access request sent. Please wait for admin approval.");
    } catch {
      setMessage("❌ Failed to submit access request.");
    }
  };

  return (
    <div style={{ textAlign: "center", marginTop: 80 }}>
      <h2>Request Portal Access</h2>
      <p>Your account is not approved yet.</p>
      <button onClick={handleRequest}>Request Access</button>
      {message && <p>{message}</p>}
    </div>
  );
}
