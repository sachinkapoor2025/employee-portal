import Login from "./pages/Login";
import Callback from "./pages/Callback";
import Dashboard from "./pages/Dashboard";

export default function App() {
  const token = localStorage.getItem("token");

  if (window.location.pathname === "/callback") {
    return <Callback />;
  }

  return token ? <Dashboard /> : <Login />;
}
