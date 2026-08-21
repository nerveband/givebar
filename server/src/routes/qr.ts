import { qrcodegen } from "../vendor/qrcodegen";

/**
 * Standards-compliant SVG QR Code Generator for Ballroom Projection & Mobile Scanning
 * Generates ISO/IEC 18004 compliant QR Code matrices with Reed-Solomon Error Correction (ECC Medium)
 * and 4-module quiet zone border.
 */
export function generateQRCodeSVG(text: string, size: number = 240): string {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.Ecc.MEDIUM);
  return qr.toSvgString(4, "#FFFFFF", "#000000");
}

export function handleQRRequest(req: Request): Response {
  const url = new URL(req.url);
  const text = url.searchParams.get("url") || url.searchParams.get("text") || "https://give.hope.org/donate";
  const size = parseInt(url.searchParams.get("size") || "240", 10);

  const svg = generateQRCodeSVG(text, size);

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
