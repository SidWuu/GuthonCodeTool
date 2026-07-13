(function configureGuthonHosts(global) {
  // 允许的协议、IPv4 CIDR、域名后缀和 Guthon 路径前缀。
  const config = {
    protocols: ["http:", "https:"],
    ipRanges: ["192.168.0.0/16"],
    domainSuffixes: ["gusen.steel56.com.cn"],
    pathPrefixes: ["/guthon/"]
  };

  function ipv4ToInt(address) {
    const parts = String(address || "").split(".");
    if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) {
      return null;
    }
    return parts.reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
  }

  function matchesIpRange(hostname, range) {
    const [network, rawBits = "32"] = String(range || "").split("/");
    const addressValue = ipv4ToInt(hostname);
    const networkValue = ipv4ToInt(network);
    const bits = Number(rawBits);
    if (addressValue === null || networkValue === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
      return false;
    }
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((addressValue & mask) >>> 0) === ((networkValue & mask) >>> 0);
  }

  function matchesDomainSuffix(hostname, suffix) {
    const domain = String(suffix || "").toLowerCase().replace(/^\*?\./, "");
    const host = String(hostname || "").toLowerCase();
    return Boolean(domain) && (host === domain || host.endsWith(`.${domain}`));
  }

  function isAllowed(url, rules = config) {
    try {
      const parsed = new URL(url);
      const protocolAllowed = (rules.protocols || []).includes(parsed.protocol);
      const hostAllowed = (rules.ipRanges || []).some((range) => matchesIpRange(parsed.hostname, range)) ||
        (rules.domainSuffixes || []).some((suffix) => matchesDomainSuffix(parsed.hostname, suffix));
      const pathAllowed = (rules.pathPrefixes || []).some((prefix) => parsed.pathname.startsWith(prefix));
      return protocolAllowed && hostAllowed && pathAllowed;
    } catch {
      return false;
    }
  }

  const api = { config, isAllowed, matchesIpRange, matchesDomainSuffix };
  global.GuthonBridgeHost = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
