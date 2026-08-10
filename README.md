# IIIT Surat — Faculty Resources Desk

**Live at: https://faculty-upload-web.web.app**

A web portal for faculty to file study resources (notes, PYQs, slides),
bulk-upload the student roster and course curriculum from Excel, and
browse/search/edit/delete individual roster and curriculum entries
without needing a spreadsheet for a one-line fix.

Talks to the same Firebase project as the mobile app and the mess staff
console — same Firestore data, same security rules (roster/curriculum
writes are restricted to faculty/admin accounts at the rules level, not
just hidden in the UI). Files themselves (the actual PDF/PPT bytes) are
stored in Supabase Storage; everything else is Firestore.

## First-time setup

1. **Install dependencies:**
   ```
   npm install
   ```

2. **Set your config:**
   ```
   cp .env.example .env.local
   ```
   Fill in `.env.local` with:
   - Supabase project URL + anon key (Supabase project → Settings → API)
   - Firebase web config (Firebase Console → Project settings → General →
     Your apps → the Web app registration → config) — same project as the
     mobile app and mess console, just copy their values across.

3. **Run it locally:**
   ```
   npm run dev
   ```
   Sign in with an existing faculty account — this checks the same
   `role: 'faculty'` field the security rules enforce, so a student
   account can't get past the login screen here.

## Deploying

```
npm run build
firebase deploy --only hosting
```

This site has its own dedicated Firebase Hosting site (`faculty-upload-web`)
— separate from the mess console's — so deploying one can never overwrite
the other, even though they share the same Firebase project. See
`firebase.json` for the exact site binding if you ever need to change it.

## What's in here

| Tab | What it's for |
|---|---|
| **Resources** | File a PDF/PPT (notes, PYQ, slides) for a branch/semester/subject, or all branches at once for a shared subject. Shows your own past uploads with delete. |
| **Roster → Bulk Upload** | Upload an Excel sheet of students; header names are matched flexibly (`Reg No`, `reg_no`, `Enrollment Number`, etc. all work — see `HEADER_ALIASES` in `RosterUpload.tsx`). Re-uploading overwrites any student sharing a reg. no. |
| **Roster → Browse & Edit** | Search the roster by reg. no. or name, filter by branch, fix a typo or remove a student inline — no spreadsheet needed for a single change. |
| **Curriculum → Bulk Upload** | Same idea, for the branch/semester/code/subject-name list that populates the Resources filing dropdown. |
| **Curriculum → Browse & Edit** | Search/filter by branch and semester, fix a subject name inline, or add/remove a single subject. (Branch, semester, and code together form the record's identity — changing any of those means removing the old entry and adding a corrected one, not an inline edit.) |

## Notes

- **Bulk uploads ask for confirmation** before writing, since re-uploading
  a sheet silently overwrites any existing entry sharing the same key
  (reg. no. for roster; branch+semester+code for curriculum) — that's a
  much bigger action than the single-item deletes elsewhere, so it gets
  at least as much friction, not less.
- **File size cap**: 50MB per resource upload (Supabase's typical
  free-tier default) — checked client-side before attempting the upload,
  so an oversized file fails fast with a clear message instead of after
  a long wait.
- **`xlsx` (the Excel-parsing library) loads on demand**, not on initial
  page load — it's a large dependency, and someone only ever using the
  Resources tab shouldn't have to download it.
- No sign-up flow here on purpose — faculty accounts are created the same
  way they already are, through the mobile app's faculty sign-up (gated
  by the `allowlist` collection). This is just another way to sign in to
  that same account. "Forgot password" is supported on the login screen.
