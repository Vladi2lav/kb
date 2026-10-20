// Proof-of-work для создания доски: ищем nonce, при котором sha256(salt + ":" + nonce)
// начинается с `bits` нулевых бит. Человеку — секунда ожидания, боту — дорого в масштабе.
const K = new Uint32Array(64);
const H0 = new Uint32Array(8);
{
  const primes = [];
  for (let n = 2; primes.length < 64; n++) if (primes.every((p) => n % p)) primes.push(n);
  const frac = (x) => ((x - Math.floor(x)) * 2 ** 32) >>> 0;
  primes.forEach((p, i) => { K[i] = frac(Math.cbrt(p)); if (i < 8) H0[i] = frac(Math.sqrt(p)); });
}
const W = new Uint32Array(64);

function sha256(bytes) {
  const len = bytes.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[len] = 0x80;
  const bitLen = len * 8;
  m[total - 4] = bitLen >>> 24; m[total - 3] = bitLen >>> 16; m[total - 2] = bitLen >>> 8; m[total - 1] = bitLen;
  const H = H0.slice();
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      W[i] = (m[j] << 24) | (m[j + 1] << 16) | (m[j + 2] << 8) | m[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return H;
}

function zeroBits(H) {
  let n = 0;
  for (const w of H) {
    if (w === 0) { n += 32; continue; }
    return n + Math.clz32(w);
  }
  return n;
}

const enc = new TextEncoder();

self.onmessage = ({ data }) => {
  const { salt, bits } = data;
  for (let nonce = 0; ; nonce++) {
    if (zeroBits(sha256(enc.encode(`${salt}:${nonce}`))) >= bits) {
      self.postMessage(String(nonce));
      return;
    }
  }
};

// для проверки в Node
if (typeof module !== "undefined") module.exports = { sha256, zeroBits };
