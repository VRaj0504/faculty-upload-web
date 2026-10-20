Faculty portal — new UI
Copy these files into your faculty-upload-web folder (same paths, replace when asked).
Changed: index.html, src/index.css, src/App.tsx, src/Login.tsx
New:     src/Home.tsx, src/Sidebar.tsx, src/nav.ts, src/icons.tsx, src/useMedicalWaiting.ts
(screenshots/ is just for reference — don't copy it.)

Then run:
  npm run build
  npm run dev                  # check it locally first (optional)
  firebase deploy --only hosting
No new packages to install.
