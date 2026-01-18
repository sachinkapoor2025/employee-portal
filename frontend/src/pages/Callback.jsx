import { useEffect } from "react";
import { handleCallback } from "../services/auth";

export default function Callback() {
  useEffect(() => {
    // Run only once when Cognito redirects back
    handleCallback();
  }, []);

  return (
    <div
      style={{
        textAlign: "center",
        marginTop: "100px",
        fontSize: "18px",
      }}
    >
      <h3>Signing you in...</h3>
      <p>Please wait, redirecting to the portal.</p>
    </div>
  );
}
