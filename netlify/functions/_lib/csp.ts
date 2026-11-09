/**
 * Workspace policy. Kept identical to the Content-Security-Policy header in
 * netlify.toml. script-src has no 'unsafe-inline' — handlers live in app.js.
 * style-src keeps 'unsafe-inline' because the page uses a <style> block and
 * style attributes. wasm-unsafe-eval is required by tesseract.js OCR.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' blob: data:",
  "connect-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://tessdata.projectnaptha.com",
  "worker-src 'self' blob: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');
