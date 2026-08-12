import { describe, expect, it } from "bun:test";
import { isPublicSourceAddress, validatePublicSourceAddresses } from "../src/pipeline.mjs";

describe("source address SSRF policy", () => {
  it.each([
    "0.0.0.0",
    "10.255.255.255",
    "100.64.0.0",
    "100.127.255.255",
    "127.255.255.255",
    "169.254.169.254",
    "172.16.0.0",
    "172.31.255.255",
    "192.0.0.9",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.255.255",
    "198.18.0.0",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.0",
    "239.255.255.255",
    "240.0.0.0",
    "255.255.255.255"
  ])("blocks RFC 6890 IPv4 address %s", (address) => {
    expect(isPublicSourceAddress(address)).toBe(false);
  });

  it.each([
    "100.63.255.255",
    "100.128.0.0",
    "169.253.255.255",
    "169.255.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.0.1.255",
    "192.0.3.0",
    "198.17.255.255",
    "198.20.0.0",
    "203.0.112.255",
    "203.0.114.0",
    "1.1.1.1",
    "8.8.8.8"
  ])("allows IPv4 global boundary address %s", (address) => {
    expect(isPublicSourceAddress(address)).toBe(true);
  });

  it.each([
    "::",
    "::1",
    "::8.8.8.8",
    "64:ff9b::808:808",
    "100::",
    "100::ffff:ffff:ffff:ffff",
    "2001::",
    "2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:db8::1",
    "2002::",
    "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "3ffe::1",
    "3fff::1",
    "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff",
    "fc00::",
    "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "fe80::",
    "fe90::1",
    "fea0::1",
    "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "fec0::",
    "ff00::",
    "ff02::1",
    "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "4000::1",
    "fe80::1%lo0"
  ])("blocks reserved, local, or non-global IPv6 address %s", (address) => {
    expect(isPublicSourceAddress(address)).toBe(false);
  });

  it.each([
    "2001:200::1",
    "2003::1",
    "2606:4700:4700::1111",
    "2a00:1450:4001:801::200e",
    "3fff:1000::1"
  ])("allows IPv6 global-unicast boundary address %s", (address) => {
    expect(isPublicSourceAddress(address)).toBe(true);
  });

  it("classifies IPv4-mapped IPv6 by the embedded IPv4 address", () => {
    expect(isPublicSourceAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicSourceAddress("[::ffff:7f00:1]")).toBe(false);
    expect(isPublicSourceAddress("::ffff:169.254.169.254")).toBe(false);
    expect(isPublicSourceAddress("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicSourceAddress("[::ffff:808:808]")).toBe(true);
  });

  it("handles WHATWG-canonicalized IPv4 and IPv6 URL literals", () => {
    expect(isPublicSourceAddress(new URL("http://2130706433/").hostname)).toBe(false);
    expect(isPublicSourceAddress(new URL("http://[::ffff:127.0.0.1]/").hostname)).toBe(false);
    expect(isPublicSourceAddress(new URL("https://[2606:4700:4700::1111]/").hostname)).toBe(true);
  });

  it("rejects the entire DNS answer if any A or AAAA result is non-public", () => {
    expect(() => validatePublicSourceAddresses([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }
    ])).not.toThrow();
    expect(() => validatePublicSourceAddresses([
      { address: "93.184.216.34", family: 4 },
      { address: "febf::1", family: 6 }
    ])).toThrow("공용 네트워크 주소로만");
    expect(() => validatePublicSourceAddresses([
      { address: "93.184.216.34", family: 4 },
      { address: "ff05::1", family: 6 }
    ])).toThrow("공용 네트워크 주소로만");
  });

  it("fails closed for empty, malformed, scoped, and family-mismatched DNS answers", () => {
    expect(() => validatePublicSourceAddresses([])).toThrow("공용 네트워크 주소로만");
    expect(() => validatePublicSourceAddresses([{ address: "not-an-ip", family: 6 }])).toThrow("공용 네트워크 주소로만");
    expect(() => validatePublicSourceAddresses([{ address: "fe80::1%en0", family: 6 }])).toThrow("공용 네트워크 주소로만");
    expect(() => validatePublicSourceAddresses([{ address: "8.8.8.8", family: 6 }])).toThrow("공용 네트워크 주소로만");
  });
});
