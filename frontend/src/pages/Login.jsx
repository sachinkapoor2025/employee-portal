import { login } from "../services/auth";

export default function Login() {
  return (
    <div style={{ textAlign: "center", marginTop: 80 }}>
      <img src="/images/logo.png" width="150" alt="Company Logo" />
      <br />
      <br />
      <button onClick={login}>Login with Company Account</button>
    </div>
  );
}
