import CryptoJS from 'crypto-js';

// Persist the actual key bytes, never CryptoJS methods or a zero-filled buffer.
export function serializeAesKey(key: unknown): string {
  if (!key) return '';
  if (typeof key === 'string') {
    if (!/^[0-9a-f]{32}$/i.test(key)) throw new Error('无效的 AES-128 密钥');
    return key.toLowerCase();
  }
  let bytes: Uint8Array;
  if (key instanceof ArrayBuffer) bytes = new Uint8Array(key);
  else if (ArrayBuffer.isView(key)) bytes = new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
  else {
    const value = key as { words?: number[]; sigBytes?: number };
    if (!Array.isArray(value.words) || value.sigBytes !== 16) throw new Error('无效的 AES-128 密钥');
    bytes = Uint8Array.from({ length: value.sigBytes }, (_, index) => (value.words![index >>> 2] >>> (24 - (index % 4) * 8)) & 0xff);
  }
  if (bytes.byteLength !== 16) throw new Error('无效的 AES-128 密钥');
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function decryptAesSegment(data: ArrayBuffer, key: unknown, iv: string): ArrayBuffer {
  const keyHex = serializeAesKey(key);
  if (!keyHex) return data;
  if (data.byteLength === 0 || data.byteLength % 16 !== 0) throw new Error('AES 分片数据不完整');
  const ivHex = (iv || '0').replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,32}$/i.test(ivHex)) throw new Error('无效的 AES 初始化向量');
  const decrypted = CryptoJS.AES.decrypt(
    CryptoJS.lib.CipherParams.create({ ciphertext: CryptoJS.lib.WordArray.create(new Uint8Array(data)) }),
    CryptoJS.enc.Hex.parse(keyHex),
    { iv: CryptoJS.enc.Hex.parse(ivHex.padStart(32, '0')), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.NoPadding },
  );
  const bytes = Uint8Array.from({ length: decrypted.sigBytes }, (_, index) => (decrypted.words[index >>> 2] >>> (24 - (index % 4) * 8)) & 0xff);
  const padding = bytes.at(-1)!;
  if (padding < 1 || padding > 16 || !bytes.subarray(bytes.length - padding).every(byte => byte === padding)) {
    throw new Error('AES 分片解密失败，密钥或数据不匹配');
  }
  return bytes.slice(0, -padding).buffer;
}
