import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served from https://tiagoferreto.github.io/cpr/
export default defineConfig({
  base: "/cpr/",
  plugins: [react(), tailwindcss()],
});
