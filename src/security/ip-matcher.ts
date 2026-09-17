export function normalizeIp(ip: string): string {
  if (!ip) return '';
  let cleaned = ip.trim();
  if (cleaned.startsWith('::ffff:')) {
    cleaned = cleaned.slice(7);
  }
  return cleaned;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let res = 0;
  for (let i = 0; i < 4; i++) {
    const octet = Number.parseInt(parts[i], 10);
    if (Number.isNaN(octet) || octet < 0 || octet > 255) return null;
    res = (res << 8) + octet;
  }
  return res >>> 0;
}

export function matchCidr(ip: string, cidr: string): boolean {
  const normalizedClient = normalizeIp(ip);
  const [subnet, prefixStr] = cidr.split('/');
  if (!prefixStr) {
    return normalizedClient === normalizeIp(subnet);
  }

  const prefix = Number.parseInt(prefixStr, 10);
  if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  const clientInt = ipv4ToInt(normalizedClient);
  const subnetInt = ipv4ToInt(normalizeIp(subnet));

  if (clientInt === null || subnetInt === null) {
    return false;
  }

  if (prefix === 0) return true;

  const mask = ((0xffffffff << (32 - prefix)) & 0xffffffff) >>> 0;
  return (clientInt & mask) === (subnetInt & mask);
}

export function isIpAllowed(clientIp: string, allowedList?: string[]): boolean {
  if (!allowedList || allowedList.length === 0) {
    return true;
  }

  const normalizedClient = normalizeIp(clientIp);
  if (!normalizedClient) return false;

  for (const rule of allowedList) {
    const trimmed = rule.trim();
    if (!trimmed) continue;

    if (trimmed.includes('/')) {
      if (matchCidr(normalizedClient, trimmed)) {
        return true;
      }
    } else if (normalizedClient === normalizeIp(trimmed)) {
      return true;
    }
  }

  return false;
}

export function extractClientIp(
  remoteAddress: string | undefined,
  headers: Record<string, string | string[] | undefined>,
  trustProxy = false,
): string {
  if (trustProxy) {
    const forwarded = headers['x-forwarded-for'];
    if (forwarded) {
      const forwardedStr = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const firstIp = forwardedStr.split(',')[0].trim();
      if (firstIp) return normalizeIp(firstIp);
    }

    const realIp = headers['x-real-ip'];
    if (realIp) {
      const realIpStr = Array.isArray(realIp) ? realIp[0] : realIp;
      if (realIpStr.trim()) return normalizeIp(realIpStr.trim());
    }
  }

  return normalizeIp(remoteAddress || '');
}
