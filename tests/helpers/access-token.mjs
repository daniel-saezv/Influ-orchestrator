import { createSign, generateKeyPairSync } from 'node:crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function createAccessSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicKey,
    sign(payload, { kid = 'test-kid' } = {}) {
      const header = b64url(JSON.stringify({ alg: 'RS256', kid }));
      const body = b64url(JSON.stringify(payload));
      const input = `${header}.${body}`;
      const sig = createSign('RSA-SHA256').update(input).sign(privateKey);
      return `${input}.${b64url(sig)}`;
    },
  };
}

export async function cryptoKeyFromPublic(publicKey) {
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}
