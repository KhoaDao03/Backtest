import { constants, createSign } from "crypto";
import { readFileSync } from "fs";

let cachedFromFile: { keyId: string; privateKeyPem: string } | null | undefined;

function loadFromCredentialsFile(): { keyId: string; privateKeyPem: string } | null {
  if (cachedFromFile !== undefined) return cachedFromFile;

  const filePath = process.env.KALSHI_CREDENTIALS_FILE?.trim();
  if (!filePath) {
    cachedFromFile = null;
    return null;
  }

  try {
    const text = readFileSync(filePath, "utf8");
    const idMatch = text.match(/API_KEY_ID\s*=\s*["']([^"']+)["']/);
    const pemMatch =
      text.match(/PRIVATE_KEY\s*=\s*"""([\s\S]*?)"""/) ??
      text.match(/PRIVATE_KEY\s*=\s*'''([\s\S]*?)'''/) ??
      text.match(/PRIVATE_KEY\s*=\s*["']([\s\S]*?)["']/);

    if (!idMatch?.[1] || !pemMatch?.[1]) {
      cachedFromFile = null;
      return null;
    }

    cachedFromFile = {
      keyId: idMatch[1].trim(),
      privateKeyPem: pemMatch[1].trim(),
    };
    return cachedFromFile;
  } catch {
    cachedFromFile = null;
    return null;
  }
}

function resolveKeyId(): string | undefined {
  return process.env.KALSHI_API_KEY_ID?.trim() || loadFromCredentialsFile()?.keyId;
}

/** Normalize PEM from .env (escaped newlines → real newlines). */
export function getPrivateKeyPem(): string {
  const fromFile = loadFromCredentialsFile()?.privateKeyPem;
  if (fromFile) return fromFile;

  const raw = process.env.KALSHI_PRIVATE_KEY ?? "";
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

export function hasKalshiCredentials(): boolean {
  const keyId = resolveKeyId();
  const pem = getPrivateKeyPem();
  return Boolean(keyId && pem.includes("BEGIN") && pem.includes("PRIVATE KEY"));
}

export function signKalshiRequest(method: string, pathWithoutQuery: string): {
  keyId: string;
  timestamp: string;
  signature: string;
} {
  const keyId = resolveKeyId();
  if (!keyId) throw new Error("Kalshi API key id is not configured");

  const timestamp = Date.now().toString();
  const message = `${timestamp}${method}${pathWithoutQuery}`;
  const sign = createSign("RSA-SHA256");
  sign.update(message);
  sign.end();
  const signature = sign.sign(
    {
      key: getPrivateKeyPem(),
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    },
    "base64",
  );

  return { keyId, timestamp, signature };
}

export function kalshiAuthHeaders(method: string, pathWithoutQuery: string): Record<string, string> {
  const { keyId, timestamp, signature } = signKalshiRequest(method, pathWithoutQuery);
  return {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "Content-Type": "application/json",
  };
}
