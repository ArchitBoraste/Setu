import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      //this tells vite: if react code tries to fetch url starting with '/api' ex '/api/health'....intercept it and forward it to the
      //target : "http://localhost:5000" ie the express backend

      //changeOrigin: true: This rewrites the request headers so that the Express server thinks the request originated from its own 
      // port (5000) rather than the React port (5173). It's a standard practice to prevent backends from rejecting the request.
      
      "/api": {
        target: "http://localhost:5000",
        changeOrigin: true,
      },
    },
  },
});