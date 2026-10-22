import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { auth, storage } from './firebaseConfig';

export const EXAM_SHEET_MAX_BYTES = 6.5 * 1024 * 1024;

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

export function guessMimeType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return '';
}

export async function uploadExamSheetPdf(file: File): Promise<{ url: string; name: string }> {
  const uid = auth.currentUser?.uid ?? 'web';
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `examSheets/${uid}/${Date.now()}-${safeName}`;
  const fileRef = ref(storage, path);
  await uploadBytes(fileRef, file, {
    contentType: guessMimeType(file) || 'application/pdf',
    cacheControl: 'public,max-age=31536000,immutable',
  });
  return { url: await getDownloadURL(fileRef), name: file.name };
}
