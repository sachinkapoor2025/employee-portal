import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./theme/ThemeProvider";
import "./styles/design-system.css";

const root = ReactDOM.createRoot(document.getElementById("root"));

root.render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
);

if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const swUrl = `${process.env.PUBLIC_URL}/service-worker.js`;
    navigator.serviceWorker.register(swUrl).catch(() => {
      /* Registration failure must not block the portal. */
    });
  });
}
