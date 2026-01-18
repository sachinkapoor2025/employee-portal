import { useState } from "react";
import Layout from "../components/Layout";

export default function Dashboard() {
  const [isChatOpen, setIsChatOpen] = useState(false);

  const styles = {
    chatbox: {
      position: "fixed",
      right: "20px",
      bottom: "20px",
      width: "300px",
      height: "360px",
      background: "white",
      borderRadius: "10px",
      boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
      padding: "12px",
    },
    chatIcon: {
      position: "fixed",
      right: "20px",
      bottom: "20px",
      width: "50px",
      height: "50px",
      backgroundColor: "#1976d2",
      color: "white",
      border: "none",
      borderRadius: "50%",
      fontSize: "24px",
      cursor: "pointer",
    },
    closeButton: {
      float: "right",
      background: "none",
      border: "none",
      fontSize: "18px",
      cursor: "pointer",
    },
    askButton: {
      width: "100%",
      backgroundColor: "#1976d2",
      color: "white",
      border: "none",
      padding: "10px",
      borderRadius: "8px",
      fontSize: "16px",
      cursor: "pointer",
    },
  };

  return (
    <Layout>
      {isChatOpen ? (
        <div style={styles.chatbox}>
          <div>
            <strong>DGV Assistant 🤖</strong>
            <button
              style={styles.closeButton}
              onClick={() => setIsChatOpen(false)}
            >
              ×
            </button>
          </div>
          <textarea
            placeholder="Ask me anything..."
            style={{ width: "100%", height: "240px", marginTop: "10px" }}
          />
          <button style={styles.askButton}>Ask</button>
        </div>
      ) : (
        <button style={styles.chatIcon} onClick={() => setIsChatOpen(true)}>
          💬
        </button>
      )}
    </Layout>
  );
}
