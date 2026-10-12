/**
 * Publishes the emergency LINE rich menu (shown to bound contacts only while a
 * family member's SOS is active) and points its alias at it. It never changes
 * the account's default menu. Safe to re-run: the alias moves to the new menu;
 * the old one is kept (linked users move over on their next sync) and printed
 * so it can be deleted later.
 *
 *   pnpm line:richmenu                # render + publish
 *   pnpm line:richmenu --preview=dir  # only write the PNG for review
 *
 * Images are rendered from SVG with the machine's CJK fonts, so run this where
 * a Traditional Chinese font is installed (macOS PingFang TC / Noto Sans TC).
 */

import "dotenv/config";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import sharp from "sharp";
import { publishRichMenu } from "../adapters/line.adapter";
import {
  EMERGENCY_RICH_MENU,
  EMERGENCY_RICH_MENU_ALIAS,
  RICH_MENU_HEIGHT,
  RICH_MENU_WIDTH,
  richMenuCellBounds,
  toRichMenuRequest,
  type RichMenuSpec,
  type RichMenuTone,
} from "../modules/line/line-richmenu";

const FONT =
  "'PingFang TC','Noto Sans TC','Noto Sans CJK TC','Microsoft JhengHei',sans-serif";

const TONE: Record<
  RichMenuTone,
  { card: string; badge: string; badgeText: string; title: string; sub: string }
> = {
  primary: {
    card: "#E8F1FB",
    badge: "#0065C8",
    badgeText: "#FFFFFF",
    title: "#0B2545",
    sub: "#3B5577",
  },
  neutral: {
    card: "#FFFFFF",
    badge: "#EEF1F5",
    badgeText: "#1F2A37",
    title: "#1F2A37",
    sub: "#5B6573",
  },
  danger: {
    card: "#FDECEC",
    badge: "#C62828",
    badgeText: "#FFFFFF",
    title: "#7A1414",
    sub: "#8E3A3A",
  },
};

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderSvg(spec: RichMenuSpec): string {
  const background = "#B71C1C";
  const gap = 18;
  const cells = spec.cells
    .map((cell, index) => {
      const b = richMenuCellBounds(index);
      const t = TONE[cell.tone];
      const x = b.x + gap;
      const y = b.y + gap;
      const w = b.width - gap * 2;
      const h = b.height - gap * 2;
      const cx = x + w / 2;
      const glyphSize = cell.glyph.length > 1 ? 92 : 120;
      return `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="48" fill="${t.card}"/>
  <circle cx="${cx}" cy="${y + 250}" r="135" fill="${t.badge}"/>
  <text x="${cx}" y="${y + 250}" dy="0.35em" text-anchor="middle" font-family="${FONT}" font-size="${glyphSize}" font-weight="700" fill="${t.badgeText}">${escapeXml(cell.glyph)}</text>
  <text x="${cx}" y="${y + 535}" text-anchor="middle" font-family="${FONT}" font-size="104" font-weight="700" fill="${t.title}">${escapeXml(cell.title)}</text>
  <text x="${cx}" y="${y + 655}" text-anchor="middle" font-family="${FONT}" font-size="64" fill="${t.sub}">${escapeXml(cell.subtitle)}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RICH_MENU_WIDTH}" height="${RICH_MENU_HEIGHT}" viewBox="0 0 ${RICH_MENU_WIDTH} ${RICH_MENU_HEIGHT}">
  <rect width="100%" height="100%" fill="${background}"/>${cells}
</svg>`;
}

async function renderPng(spec: RichMenuSpec): Promise<Buffer> {
  // LINE rejects rich menu images over 1 MB.
  return sharp(Buffer.from(renderSvg(spec)))
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();
}

async function main() {
  const previewArg = process.argv.find((arg) => arg.startsWith("--preview"));
  if (previewArg) {
    const dir = previewArg.split("=")[1] || "line-richmenu-preview";
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "emergency.png");
    await writeFile(file, await renderPng(EMERGENCY_RICH_MENU));
    console.log(`wrote ${file}`);
    return;
  }

  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
  }
  const { richMenuId, previous } = await publishRichMenu(
    toRichMenuRequest(EMERGENCY_RICH_MENU),
    await renderPng(EMERGENCY_RICH_MENU),
    EMERGENCY_RICH_MENU_ALIAS,
  );
  console.log(
    `emergency: ${richMenuId} (alias ${EMERGENCY_RICH_MENU_ALIAS})${
      previous && previous !== richMenuId
        ? ` — replaced ${previous}; kept so linked users keep a working menu until their next sync`
        : ""
    }`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
