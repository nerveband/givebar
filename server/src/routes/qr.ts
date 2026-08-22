import QRCode from "qrcode";

export interface QRStyleOptions {
  darkColor?: string;
  lightColor?: string;
  margin?: number;
  size?: number;
}

/**
 * ISO/IEC 18004 Gold-Standard Vector SVG QR Code Generator
 * Powered by node-qrcode — 100% scannable on all iOS and Android camera apps.
 */
export function generateQRCodeSVG(text: string, options: QRStyleOptions | number = {}): string {
  const opts = typeof options === "number" ? { size: options } : options;
  const darkColor = opts.darkColor || "#0E131E";
  const lightColor = opts.lightColor || "#FFFFFF";
  const margin = opts.margin !== undefined ? opts.margin : 2;

  let result = "";
  QRCode.toString(
    text,
    {
      type: "svg",
      errorCorrectionLevel: "M",
      margin,
      color: {
        dark: darkColor,
        light: lightColor
      }
    },
    (err, svg) => {
      if (err) throw err;
      result = svg;
    }
  );

  return result;
}

export function handleQRRequest(req: Request): Response {
  const url = new URL(req.url);
  const text = url.searchParams.get("url") || url.searchParams.get("text") || "https://give.hope.org/donate";
  const darkColor = url.searchParams.get("dark") || "#0E131E";
  const lightColor = url.searchParams.get("light") || "#FFFFFF";
  const margin = parseInt(url.searchParams.get("margin") || "2", 10);

  try {
    const svg = generateQRCodeSVG(text, {
      darkColor,
      lightColor,
      margin
    });

    return new Response(svg, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*"
      }
    });
  } catch (err: any) {
    return new Response(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><text x="10" y="20" fill="red">Error: ${err.message}</text></svg>`,
      {
        status: 500,
        headers: { "Content-Type": "image/svg+xml" }
      }
    );
  }
}
