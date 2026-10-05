(function configureGuthonHosts(global) {
  // 显式允许的协议、IPv4/IPv6 CIDR、域名后缀和 Guthon 路径前缀。
  const config = global.GuthonBridgeHostSettings || {
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
    const parts = String(range || "").split("/");
    if (parts.length > 2 || (parts.length === 2 && !/^\d+$/.test(parts[1]))) return false;
    const [network, rawBits = network.includes(':') ? '128' : '32'] = parts;
    if (network.includes(':')) {
      const addressValue = ipv6ToInt(hostname);
      const networkValue = ipv6ToInt(network);
      const bits = Number(rawBits);
      if (addressValue === null || networkValue === null || !Number.isInteger(bits) || bits < 0 || bits > 128) return false;
      const shift = BigInt(128 - bits);
      return (addressValue >> shift) === (networkValue >> shift);
    }
    const addressValue = ipv4ToInt(hostname);
    const networkValue = ipv4ToInt(network);
    const bits = Number(rawBits);
    if (addressValue === null || networkValue === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
      return false;
    }
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((addressValue & mask) >>> 0) === ((networkValue & mask) >>> 0);
  }

  function ipv6ToInt(address) {
    let value = String(address || '').toLowerCase();
    if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
    if (!value.includes(':') || value.includes('%') || !/^[0-9a-f:.]+$/.test(value)) return null;
    if (value.includes('.')) {
      const offset = value.lastIndexOf(':');
      const tail = ipv4ToInt(value.slice(offset + 1));
      if (tail === null) return null;
      value = value.slice(0, offset + 1) + (tail >>> 16).toString(16) + ':' + (tail & 65535).toString(16);
    }
    const halves = value.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    if ([...left, ...right].some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
    const missing = 8 - left.length - right.length;
    if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
    return [...left, ...Array(missing).fill('0'), ...right].reduce((number, group) => (number << 16n) | BigInt(parseInt(group, 16)), 0n);
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
