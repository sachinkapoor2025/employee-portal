const API = process.env.REACT_APP_API_URL;

export const api = async (path, method = "GET", body) => {
  const token = localStorage.getItem("token");
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: token
    },
    body: body ? JSON.stringify(body) : null
  });
  return res.json();
};
