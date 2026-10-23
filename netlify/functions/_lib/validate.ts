/**
 * Shared input rules for signup, login, and case creation.
 * Keep the numbers in sync with the checks in app/index.html.
 */

export const LIMITS = {
  nameMin: 2,
  nameMax: 80,
  emailMax: 254,
  passwordMin: 10,
  passwordMax: 128,
  titleMax: 200,
  sourceTextMin: 10,
  sourceTextMax: 100_000,
  fileMaxBytes: 10 * 1024 * 1024,
} as const;

export const SOURCE_TYPES = ['text', 'pdf', 'image', 'word', 'email'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

const EXT_FOR_TYPE: Record<SourceType, string[]> = {
  text: ['txt', 'csv', 'md', 'json'],
  email: ['eml'],
  pdf: ['pdf'],
  word: ['doc', 'docx'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'tif', 'tiff'],
};

const ALLOWED_EXT = new Set(Object.values(EXT_FOR_TYPE).flat());

/** MIME types browsers actually send for the extensions above, plus empty / generic. */
const ALLOWED_MIME = new Set([
  '',
  'application/octet-stream',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/x-markdown',
  'application/json',
  'message/rfc822',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/tiff',
  'image/tif',
]);

export function validateEmail(email: unknown): string | null {
  if (typeof email !== 'string') return 'Enter a valid email address.';
  const v = email.trim();
  if (!v) return 'Email is required.';
  if (v.length > LIMITS.emailMax) return 'Email is too long.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'Enter a valid email address.';
  return null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateName(name: unknown): string | null {
  if (typeof name !== 'string') return 'Enter your full name.';
  const v = name.trim();
  if (v.length < LIMITS.nameMin) return `Enter your full name (at least ${LIMITS.nameMin} characters).`;
  if (v.length > LIMITS.nameMax) return `Name must be ${LIMITS.nameMax} characters or fewer.`;
  if (/[\u0000-\u001F\u007F]/.test(v)) return 'Name contains invalid characters.';
  return null;
}

/** Login only checks that a password is present and not enormous. Signup also enforces the policy. */
export function validatePassword(password: unknown, enforcePolicy: boolean): string | null {
  if (typeof password !== 'string' || password.length === 0) return 'Password is required.';
  if (password.length > LIMITS.passwordMax) return `Password must be ${LIMITS.passwordMax} characters or fewer.`;
  if (!enforcePolicy) return null;
  if (password.length < LIMITS.passwordMin || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return `Use at least ${LIMITS.passwordMin} characters, including a letter and a number.`;
  }
  return null;
}

export interface CaseInput {
  title?: unknown;
  sourceText?: unknown;
  sourceType?: unknown;
  fileName?: unknown;
  fileSize?: unknown;
  fileType?: unknown;
}

export interface CaseValue {
  title: string;
  sourceText: string;
  sourceType: SourceType;
}

function extensionOf(fileName: string): string {
  const base = fileName.trim().split(/[/\\]/).pop() || '';
  const i = base.lastIndexOf('.');
  if (i <= 0) return '';
  return base.slice(i + 1).toLowerCase();
}

function typeForExt(ext: string): SourceType | null {
  for (const t of SOURCE_TYPES) {
    if (EXT_FOR_TYPE[t].includes(ext)) return t;
  }
  return null;
}

/**
 * Files are parsed in the browser. The API stores extracted text, so the server
 * enforces source type, filename extension, declared MIME, declared byte size,
 * and a ceiling on the extracted text.
 */
export function validateCase(input: CaseInput): { ok: true; value: CaseValue } | { ok: false; fields: Record<string, string> } {
  const fields: Record<string, string> = {};

  let title = '';
  if (input.title !== undefined && input.title !== null && input.title !== '') {
    if (typeof input.title !== 'string') fields.title = 'Title must be text.';
    else {
      title = input.title.trim();
      if (title.length > LIMITS.titleMax) fields.title = `Title must be ${LIMITS.titleMax} characters or fewer.`;
    }
  }

  let sourceText = '';
  if (typeof input.sourceText !== 'string' || !input.sourceText.trim()) {
    fields.sourceText = 'Source text is required — paste a narrative or upload a supported file.';
  } else {
    sourceText = input.sourceText.trim();
    if (sourceText.length < LIMITS.sourceTextMin) {
      fields.sourceText = `Source text must be at least ${LIMITS.sourceTextMin} characters.`;
    } else if (sourceText.length > LIMITS.sourceTextMax) {
      fields.sourceText = `Source text must be ${LIMITS.sourceTextMax.toLocaleString('en-US')} characters or fewer.`;
    }
  }

  const fileName = typeof input.fileName === 'string' ? input.fileName.trim() : '';
  const ext = fileName ? extensionOf(fileName) : '';
  if (fileName && !ext) fields.file = 'The file needs an extension such as .pdf, .docx, or .txt.';
  else if (ext && !ALLOWED_EXT.has(ext)) {
    fields.file = 'That file type is not supported. Use PDF, Word, text, email, CSV, or an image.';
  }

  if (input.fileSize !== undefined && input.fileSize !== null && input.fileSize !== '') {
    const n = input.fileSize;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) fields.file = 'File size is invalid.';
    else if (n > LIMITS.fileMaxBytes) fields.file = 'File is too large. Maximum size is 10 MB.';
  }

  if (typeof input.fileType === 'string' && input.fileType.trim()) {
    const mime = input.fileType.split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MIME.has(mime)) fields.file = 'That file type is not supported.';
  }

  let sourceType: SourceType = 'text';
  if (input.sourceType === undefined || input.sourceType === null || input.sourceType === '') {
    sourceType = (ext && typeForExt(ext)) || 'text';
  } else if (typeof input.sourceType !== 'string' || !(SOURCE_TYPES as readonly string[]).includes(input.sourceType)) {
    fields.sourceType = 'Source type is not supported.';
  } else {
    sourceType = input.sourceType as SourceType;
  }

  if (!fields.file && ext && !fields.sourceType && !EXT_FOR_TYPE[sourceType].includes(ext)) {
    fields.file = 'The file extension does not match the source type.';
  }

  if (Object.keys(fields).length) return { ok: false, fields };
  return { ok: true, value: { title, sourceText, sourceType } };
}
