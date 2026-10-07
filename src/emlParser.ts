import PostalMime, { type Address, type Attachment as MimeAttachment } from "postal-mime";
import type { Addr, Attachment, ParsedEmail } from "./types";

function flattenAddresses(list: Address[] | Address | undefined): Addr[] {
  if (!list) return [];
  const items = Array.isArray(list) ? list : [list];
  const out: Addr[] = [];
  for (const item of items) {
    if (item.group) {
      for (const member of item.group) {
        out.push({ name: member.name || null, address: member.address || null });
      }
    } else {
      out.push({ name: item.name || null, address: item.address || null });
    }
  }
  return out;
}

function toBytes(att: MimeAttachment): Uint8Array {
  if (typeof att.content === "string") {
    if (att.encoding === "base64") {
      const binary = atob(att.content);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    return new TextEncoder().encode(att.content);
  }
  return att.content instanceof Uint8Array ? att.content : new Uint8Array(att.content);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function embedInlineImages(html: string, attachments: MimeAttachment[]): string {
  let result = html;
  for (const att of attachments) {
    if (!att.contentId) continue;
    const cid = att.contentId.replace(/^<|>$/g, "");
    const dataUri = `data:${att.mimeType};base64,${bytesToBase64(toBytes(att))}`;
    result = result.split(`cid:${cid}`).join(dataUri);
  }
  return result;
}

export async function parseEmlFile(file: File): Promise<ParsedEmail> {
  const rawSource = await file.text();
  const email = await PostalMime.parse(file);

  const htmlBody = email.html ? embedInlineImages(email.html, email.attachments) : null;

  const downloadable = email.attachments.filter(
    (a) => !(a.contentId && a.disposition === "inline"),
  );
  const attachments: Attachment[] = downloadable.map((a, index) => {
    const bytes = toBytes(a);
    return {
      index,
      filename: a.filename || "attachment",
      contentType: a.mimeType || "application/octet-stream",
      size: bytes.length,
      dataBase64: bytesToBase64(bytes),
    };
  });

  const rawHeaders: [string, string][] = email.headers.map((h) => [h.originalKey, h.value]);

  return {
    subject: email.subject ?? null,
    from: flattenAddresses(email.from),
    to: flattenAddresses(email.to),
    cc: flattenAddresses(email.cc),
    date: email.date ?? null,
    messageId: email.messageId ?? null,
    htmlBody,
    textBody: email.text ?? null,
    attachments,
    rawHeaders,
    rawSource,
  };
}
