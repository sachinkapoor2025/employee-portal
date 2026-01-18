import { useSearchParams } from "react-router-dom";
import { requestAccess } from "../services/auth";
import { useState } from "react";

export default function RequestAccess() {
  const [params] = useSearchParams();
  const status = params.get("status");
  const [msg, setMsg] = useState("");

  const handleRequest = async () => {
    try {
      await requestAccess();
      setMsg("Access request sent. Please wait for approval.");
    } catch {
      setMsg("Failed to send access request.");
    }
  };

  return (
    <div style={{ textAlign: "center", marginTop: 80 }}>
      <h2>Request Portal Access</h2>

      {status === "pending" ? (
        <p>Your request is under review.</p>
      ) : (
        <>
          <p>You do not have access yet.</p>
          <button onClick={handleRequest}>Request Access</button>
        </>
      )}

      {msg && <p>{msg}</p>}
    </div>
  );
}
