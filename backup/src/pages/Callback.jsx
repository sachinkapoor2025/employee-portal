import { useEffect } from "react";
import { handleCallback } from "../services/auth";

export default function Callback() {
  useEffect(() => {
    handleCallback();
  }, []);

  return <p>Logging you in...</p>;
}
