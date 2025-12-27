import { useEffect } from "react";
import { handleCallback } from "../services/auth";

export default function Callback() {
  useEffect(() => {
    handleCallback();
  }, []);

  return (
    <div style={{ textAlign: "center", marginTop: 80 }}>
      <h3>Signing you in...</h3>
    </div>
  );
}
