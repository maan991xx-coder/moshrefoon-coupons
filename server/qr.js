import QRCode from 'qrcode';

const OPTIONS = { errorCorrectionLevel: 'M', margin: 0 };

/**
 * The raw module grid, so the browser can draw the QR crisply at any size
 * instead of scaling a bitmap.
 * @returns {{ size: number, modules: string }} modules = "0"/"1" row-major
 */
export function qrMatrix(text) {
  const qr = QRCode.create(text, OPTIONS);
  const { size, data } = qr.modules;
  let modules = '';
  for (let i = 0; i < data.length; i++) modules += data[i] ? '1' : '0';
  return { size, modules };
}

export async function qrPngBuffer(text, width = 512) {
  return QRCode.toBuffer(text, { ...OPTIONS, type: 'png', width, margin: 1 });
}

export async function qrSvg(text) {
  return QRCode.toString(text, { ...OPTIONS, type: 'svg', margin: 1 });
}
