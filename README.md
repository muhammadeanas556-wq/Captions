# Captionly
1. `npm install`
2. Copy `.env.example` to `.env` and set `GEMINI_API_KEY` (only the server reads it).
3. Needs `ffmpeg` with libass on PATH. Put Montserrat/Poppins/Inter/Playfair `.ttf` files in `fonts/` so exports match the preview.
4. `npm start` then open http://localhost:3000

## Deploying (IMPORTANT)
Netlify/Vercel/GitHub Pages cannot run this app: they host static files only, so uploads fail with "Unexpected end of JSON input".
Use a host that runs Node + ffmpeg with a disk, using the included `Dockerfile`:
- Render / Railway / Fly.io: create a Web Service from this folder (Docker), set env var `GEMINI_API_KEY`, attach a persistent disk at `/app/data`.
- Or run on your own PC: `npm install && npm start`, open http://localhost:3000
