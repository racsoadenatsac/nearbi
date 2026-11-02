// Loaded on every dynamic page: wires the "Sign out" link.
import { api } from "./api.js";

const logout = document.getElementById("logout");
if (logout) {
  logout.addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      location.href = "/";
    }
  });
}
