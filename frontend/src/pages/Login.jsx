import { login } from "../services/auth";

export default function Login() {
  return (
    <div>
      <img src="/images/logo.png" width="150" alt="Company Logo" />
      <button onClick={login}>Login with Company Account</button>
    </div>
  );
}
