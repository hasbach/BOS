import { describe, expect, it } from "vitest";

import { checkLogoFile, formatWhatsapp, logoUrl, storeInitials } from "@/lib/stores";

describe("checkLogoFile", () => {
  it("accepts PNG, JPEG and WebP up to 2 MB", () => {
    expect(checkLogoFile({ type: "image/png", size: 100 })).toBeNull();
    expect(checkLogoFile({ type: "image/jpeg", size: 2 * 1024 * 1024 })).toBeNull();
    expect(checkLogoFile({ type: "image/webp", size: 1 })).toBeNull();
  });

  it("refuses other types and anything over 2 MB", () => {
    expect(checkLogoFile({ type: "image/gif", size: 100 })).toBe("file_not_image");
    expect(checkLogoFile({ type: "application/pdf", size: 100 })).toBe("file_not_image");
    expect(checkLogoFile({ type: "", size: 100 })).toBe("file_not_image");
    expect(checkLogoFile({ type: "image/png", size: 2 * 1024 * 1024 + 1 })).toBe("file_too_large");
  });
});

describe("formatWhatsapp", () => {
  it("writes a Lebanese E.164 number the way people read it", () => {
    expect(formatWhatsapp("+96170000031")).toBe("+961 70 000 031");
    expect(formatWhatsapp("+9613123456")).toBe("+961 3 123 456");
  });

  it("leaves any other number as it is", () => {
    expect(formatWhatsapp("+14155550123")).toBe("+14155550123");
  });
});

describe("store helpers", () => {
  it("takes initials from up to two words, as typed", () => {
    expect(storeInitials("Store B")).toBe("SB");
    expect(storeInitials("متجر ب")).toBe("مب");
    expect(storeInitials("  ")).toBe("?");
  });

  it("changes the logo address after an upload so the browser asks again", () => {
    expect(logoUrl("abc")).toBe("/api/v1/stores/abc/logo");
    expect(logoUrl("abc", 2)).toBe("/api/v1/stores/abc/logo?v=2");
  });
});
