import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "node:path"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        // PHP backend (api/.env PORT). Was http://localhost:3000 for the old Node backend.
        target: "http://localhost:8090",
        changeOrigin: true
      }
    }
  }
})
