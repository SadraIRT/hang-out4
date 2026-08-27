// Override API URL for static hosts (Netlify / Vercel / Cloudflare / GitHub Pages)
// Set to your Render backend URL. Leave empty for same-origin (localhost via uvicorn)
// Example: window.API_BASE = "https://hangout-api.onrender.com";
window.API_BASE = window.API_BASE || "";
// For localStorage override: localStorage.setItem('API_BASE', 'https://...')
if(localStorage.getItem('API_BASE')) window.API_BASE = localStorage.getItem('API_BASE');
