/**
 * Browser-level file helpers (same pattern as the project export in `ProjectModal`): Blob download and a
 * hidden `<input type="file">` picker. Works inside the Tauri webview and in the browser bridge.
 */

export function downloadTextFile(fileName: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Opens the native file picker; resolves with the file text, or `null` when the user cancels. */
export function pickTextFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      settled = true;
      input.remove();
      if (!file) {
        resolve(null);
        return;
      }
      file.text().then((text) => resolve({ name: file.name, text }), reject);
    });
    input.addEventListener('cancel', () => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}
