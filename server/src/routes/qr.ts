import { qrcodegen } from "../vendor/qrcodegen";

export interface QRStyleOptions {
  style?: "dots" | "squircle" | "squares";
  darkColor?: string;
  lightColor?: string;
  centerBadge?: "star" | "heart" | "gift" | "sparkle" | "none" | string;
  eccLevel?: "L" | "M" | "Q" | "H";
  border?: number;
  size?: number;
}

/**
 * Apple-Grade Adaptive SVG QR Code Generator
 * Supports:
 * - Selectable Module Styles: 'dots' (circular dots), 'squircle' (rounded squares), 'squares' (classic)
 * - Custom & Adaptive Color Themes: Brand accent, crisp dark ink, transparent glass
 * - Center Logo / Badge Shield: With High ECC (30% error correction) for guaranteed scannability
 * - Smooth Rounded Finder Corner Rings
 */
export function generateQRCodeSVG(text: string, options: QRStyleOptions = {}): string {
  const style = options.style || "dots";
  const darkColor = options.darkColor || "#0E131E";
  const lightColor = options.lightColor || "#FFFFFF";
  const centerBadge = options.centerBadge || "star";
  const hasCenterBadge = centerBadge && centerBadge !== "none";
  const border = options.border !== undefined ? options.border : 4;
  const size = options.size || 240;

  // Use High ECC (30% recovery) when center badge is present, otherwise Medium (15%)
  const ecl = hasCenterBadge ? qrcodegen.Ecc.HIGH : qrcodegen.Ecc.MEDIUM;

  const qr = qrcodegen.QrCode.encodeText(text, ecl);
  const moduleCount = qr.size;
  const totalGrid = moduleCount + border * 2;

  // Center badge exclusion radius (in module units)
  const centerModuleRadius = hasCenterBadge ? Math.ceil(moduleCount * 0.16) : 0;
  const centerCoord = Math.floor(moduleCount / 2);

  function isFinderPattern(x: number, y: number): boolean {
    if (x < 7 && y < 7) return true; // Top-left
    if (x >= moduleCount - 7 && y < 7) return true; // Top-right
    if (x < 7 && y >= moduleCount - 7) return true; // Bottom-left
    return false;
  }

  function isCenterZone(x: number, y: number): boolean {
    if (!hasCenterBadge) return false;
    const dx = x - centerCoord;
    const dy = y - centerCoord;
    return Math.sqrt(dx * dx + dy * dy) <= centerModuleRadius;
  }

  const elements: string[] = [];

  // 1. Data Modules Rendering
  for (let y = 0; y < moduleCount; y++) {
    for (let x = 0; x < moduleCount; x++) {
      if (isFinderPattern(x, y) || isCenterZone(x, y)) continue;

      if (qr.getModule(x, y)) {
        const mx = x + border;
        const my = y + border;

        if (style === "dots") {
          // Circular Dot
          elements.push(`<circle cx="${mx + 0.5}" cy="${my + 0.5}" r="0.42" fill="${darkColor}"/>`);
        } else if (style === "squircle") {
          // Rounded Rectangle (Squircle)
          elements.push(`<rect x="${mx + 0.08}" y="${my + 0.08}" width="0.84" height="0.84" rx="0.32" fill="${darkColor}"/>`);
        } else {
          // Classic Square
          elements.push(`<rect x="${mx}" y="${my}" width="1" height="1" fill="${darkColor}"/>`);
        }
      }
    }
  }

  // 2. Finder Patterns Rendering (Styled Finder Corners)
  const finders = [
    { x: 0, y: 0 },
    { x: moduleCount - 7, y: 0 },
    { x: 0, y: moduleCount - 7 }
  ];

  for (const f of finders) {
    const fx = f.x + border;
    const fy = f.y + border;

    if (style === "dots" || style === "squircle") {
      // Modern Rounded Finder Rings
      elements.push(`
        <!-- Finder Outer Frame -->
        <rect x="${fx}" y="${fy}" width="7" height="7" rx="1.8" fill="none" stroke="${darkColor}" stroke-width="1"/>
        <!-- Finder Inner Core -->
        <rect x="${fx + 2}" y="${fy + 2}" width="3" height="3" rx="1" fill="${darkColor}"/>
      `);
    } else {
      // Classic Square Finder Frames
      elements.push(`
        <rect x="${fx}" y="${fy}" width="7" height="7" fill="${darkColor}"/>
        <rect x="${fx + 1}" y="${fy + 1}" width="5" height="5" fill="${lightColor}"/>
        <rect x="${fx + 2}" y="${fy + 2}" width="3" height="3" fill="${darkColor}"/>
      `);
    }
  }

  // 3. Center Badge Shield & Icon (Apple-Style Protective Shield)
  if (hasCenterBadge) {
    const shieldDiameter = centerModuleRadius * 2 + 1.2;
    const shieldRadius = shieldDiameter / 2;
    const cx = centerCoord + border + 0.5;
    const cy = centerCoord + border + 0.5;

    // Shield Background & Border Ring
    elements.push(`
      <circle cx="${cx}" cy="${cy}" r="${shieldRadius}" fill="${lightColor}" stroke="${darkColor}" stroke-width="0.35"/>
    `);

    // Center Badge Graphics
    if (centerBadge === "star") {
      elements.push(`
        <path d="M${cx},${cy - shieldRadius * 0.55} L${cx + shieldRadius * 0.35},${cy + shieldRadius * 0.45} L${cx - shieldRadius * 0.45},${cy - shieldRadius * 0.15} L${cx + shieldRadius * 0.45},${cy - shieldRadius * 0.15} L${cx - shieldRadius * 0.35},${cy + shieldRadius * 0.45} Z" fill="${darkColor}"/>
      `);
    } else if (centerBadge === "heart") {
      const hr = shieldRadius * 0.55;
      elements.push(`
        <path d="M${cx},${cy + hr * 0.6} C${cx - hr * 0.9},${cy - hr * 0.3} ${cx - hr * 0.9},${cy - hr * 0.8} ${cx},${cy - hr * 0.2} C${cx + hr * 0.9},${cy - hr * 0.8} ${cx + hr * 0.9},${cy - hr * 0.3} ${cx},${cy + hr * 0.6} Z" fill="${darkColor}"/>
      `);
    } else if (centerBadge === "gift") {
      const gw = shieldRadius * 0.7;
      const gh = shieldRadius * 0.7;
      elements.push(`
        <rect x="${cx - gw/2}" y="${cy - gh/2}" width="${gw}" height="${gh}" rx="0.5" fill="${darkColor}"/>
        <line x1="${cx}" y1="${cy - gh/2}" x2="${cx}" y2="${cy + gh/2}" stroke="${lightColor}" stroke-width="0.5"/>
        <line x1="${cx - gw/2}" y1="${cy}" x2="${cx + gw/2}" y2="${cy}" stroke="${lightColor}" stroke-width="0.5"/>
      `);
    } else if (centerBadge === "sparkle") {
      const sr = shieldRadius * 0.6;
      elements.push(`
        <path d="M${cx},${cy - sr} Q${cx},${cy} ${cx + sr},${cy} Q${cx},${cy} ${cx},${cy + sr} Q${cx},${cy} ${cx - sr},${cy} Q${cx},${cy} ${cx},${cy - sr} Z" fill="${darkColor}"/>
      `);
    } else if (centerBadge.startsWith("http://") || centerBadge.startsWith("https://") || centerBadge.startsWith("data:")) {
      const imgSize = shieldDiameter * 0.75;
      elements.push(`
        <clipPath id="center-badge-clip">
          <circle cx="${cx}" cy="${cy}" r="${shieldRadius * 0.8}"/>
        </clipPath>
        <image href="${centerBadge}" x="${cx - imgSize/2}" y="${cy - imgSize/2}" width="${imgSize}" height="${imgSize}" clip-path="url(#center-badge-clip)"/>
      `);
    }
  }

  // Generate Clean Crisp SVG
  const bgRect = lightColor !== "transparent"
    ? `<rect width="100%" height="100%" fill="${lightColor}" rx="${border > 0 ? 2 : 0}"/>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 ${totalGrid} ${totalGrid}" width="${size}" height="${size}" stroke="none" shape-rendering="crispEdges">
  ${bgRect}
  ${elements.join("\n  ")}
</svg>
`;
}

export function handleQRRequest(req: Request): Response {
  const url = new URL(req.url);
  const text = url.searchParams.get("url") || url.searchParams.get("text") || "https://give.hope.org/donate";
  const size = parseInt(url.searchParams.get("size") || "240", 10);
  const style = (url.searchParams.get("style") as "dots" | "squircle" | "squares") || "dots";
  const darkColor = url.searchParams.get("dark") || "#0E131E";
  const lightColor = url.searchParams.get("light") || "#FFFFFF";
  const centerBadge = url.searchParams.get("center") || "star";

  const svg = generateQRCodeSVG(text, {
    size,
    style,
    darkColor,
    lightColor,
    centerBadge
  });

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
