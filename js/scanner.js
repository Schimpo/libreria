// Lettura del codice a barre (EAN-13) con la fotocamera.
// Usa il BarcodeDetector nativo del browser quando c'è (Chrome su Android),
// altrimenti carica una libreria equivalente (necessaria per esempio su iPhone).
import { normalizeIsbn } from './lookup.js';

const PONYFILL_URL = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/dist/es/ponyfill.js/+esm';
const FORMATS = ['ean_13'];
const SCAN_INTERVAL_MS = 120;

export function canScan() {
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

// Avvia la fotocamera nel <video> e restituisce il primo ISBN valido letto.
// Si interrompe (con un AbortError) quando `signal` viene annullato.
export async function scanIsbn(video, signal) {
  const detector = await createDetector();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });

  try {
    video.srcObject = stream;
    if (!signal.aborted) await video.play();
    while (!signal.aborted) {
      const codes = await detector.detect(video).catch(() => []);
      for (const code of codes) {
        // Accetta solo i codici dei libri (978/979…), non quelli di altri prodotti.
        const isbn = normalizeIsbn(code.rawValue);
        if (isbn && isbn === code.rawValue) return isbn;
      }
      await new Promise((resolve) => setTimeout(resolve, SCAN_INTERVAL_MS));
    }
    throw new DOMException('Scansione annullata', 'AbortError');
  } finally {
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }
}

async function createDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      if (supported.includes('ean_13')) return new window.BarcodeDetector({ formats: FORMATS });
    } catch {
      // Detector nativo presente ma non utilizzabile: si passa alla libreria.
    }
  }
  const { BarcodeDetector } = await import(PONYFILL_URL);
  return new BarcodeDetector({ formats: FORMATS });
}
