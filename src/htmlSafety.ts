// Prepares email HTML for display inside a sandboxed, script-disabled iframe.
// The iframe sandbox already blocks script execution; this additionally
// strips remote image/style loads (tracking pixels) unless explicitly allowed,
// and forces links to open in a new, unsandboxed context.
export function prepareEmailHtml(html: string, allowRemoteContent: boolean): string {
  const doc = new DOMParser().parseFromString(html, "text/html");

  doc.querySelectorAll("a[href]").forEach((a) => {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  });

  if (!allowRemoteContent) {
    doc.querySelectorAll("img[src]").forEach((img) => {
      const src = img.getAttribute("src") || "";
      if (/^https?:/i.test(src)) {
        img.setAttribute("data-original-src", src);
        img.removeAttribute("src");
        img.setAttribute("alt", img.getAttribute("alt") || "[원격 이미지 차단됨]");
        img.classList.add("blocked-remote-image");
      }
    });
    doc.querySelectorAll("[style]").forEach((el) => {
      const style = el.getAttribute("style") || "";
      if (/url\(\s*['"]?https?:/i.test(style)) {
        el.setAttribute(
          "style",
          style.replace(/background(-image)?\s*:\s*[^;]*url\([^)]*\)[^;]*;?/gi, ""),
        );
      }
    });
  }

  return doc.documentElement.outerHTML;
}

export function hasRemoteContent(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const hasRemoteImg = Array.from(doc.querySelectorAll("img[src]")).some((img) =>
    /^https?:/i.test(img.getAttribute("src") || ""),
  );
  const hasRemoteStyle = Array.from(doc.querySelectorAll("[style]")).some((el) =>
    /url\(\s*['"]?https?:/i.test(el.getAttribute("style") || ""),
  );
  return hasRemoteImg || hasRemoteStyle;
}
