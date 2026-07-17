// Minimal RFC1951 DEFLATE decoder (pure JS, no dependencies), plus gzip
// (RFC1952) and zlib (RFC1950) header/trailer unwrapping. Needed because
// Minecraft .schem/.schematic files are (usually gzip-, sometimes zlib-)
// compressed NBT and this project takes no external dependencies.
//
// The core algorithm follows the public-domain "puff.c" reference decoder
// (zlib project, Mark Adler): canonical Huffman decoding via an
// incrementally-built (count, symbol) table, fixed and dynamic Huffman
// blocks, and stored (uncompressed) blocks.

const MAXBITS = 15;

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
                  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
                   3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
                   257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
                   8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
                    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLC_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2,
                   14, 1, 15];

class BitReader {
  constructor(bytes, startByte) {
    this.bytes = bytes;
    this.pos = startByte;
    this.bitbuf = 0;
    this.bitcnt = 0;
  }

  // DEFLATE packs ordinary multi-bit fields LSB-first (the first bit read
  // becomes the value's least-significant bit).
  bits(need) {
    let val = this.bitbuf;
    while (this.bitcnt < need) {
      val |= this.bytes[this.pos++] << this.bitcnt;
      this.bitcnt += 8;
    }
    this.bitbuf = val >> need;
    this.bitcnt -= need;
    return val & ((1 << need) - 1);
  }

  alignToByte() {
    this.bitbuf = 0;
    this.bitcnt = 0;
  }
}

function buildHuffman(lengths) {
  const count = new Array(MAXBITS + 1).fill(0);
  for (const l of lengths) count[l]++;
  count[0] = 0;
  const offs = new Array(MAXBITS + 2).fill(0);
  for (let i = 1; i <= MAXBITS; i++) offs[i + 1] = offs[i] + count[i];
  const symbol = new Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i]) symbol[offs[lengths[i]]++] = i;
  }
  return { count, symbol };
}

// Huffman codes are packed MSB-first: each bit read extends the code with
// the new bit in the low position, and prior bits shift up — so the first
// bit read ends up as the code's most-significant bit once decoding stops.
function decodeSymbol(br, h) {
  let code = 0, first = 0, index = 0;
  for (let len = 1; len <= MAXBITS; len++) {
    code |= br.bits(1);
    const cnt = h.count[len];
    if (code - cnt < first) return h.symbol[index + (code - first)];
    index += cnt;
    first += cnt;
    first <<= 1;
    code <<= 1;
  }
  throw new Error('inflate: invalid Huffman code');
}

function fixedTables() {
  const lenLengths = new Array(288);
  let i = 0;
  for (; i < 144; i++) lenLengths[i] = 8;
  for (; i < 256; i++) lenLengths[i] = 9;
  for (; i < 280; i++) lenLengths[i] = 7;
  for (; i < 288; i++) lenLengths[i] = 8;
  const distLengths = new Array(30).fill(5);
  return { lencode: buildHuffman(lenLengths), distcode: buildHuffman(distLengths) };
}

function dynamicTables(br) {
  const hlit = br.bits(5) + 257;
  const hdist = br.bits(5) + 1;
  const hclen = br.bits(4) + 4;
  const clLengths = new Array(19).fill(0);
  for (let i = 0; i < hclen; i++) clLengths[CLC_ORDER[i]] = br.bits(3);
  const clcode = buildHuffman(clLengths);

  const total = hlit + hdist;
  const lengths = new Array(total).fill(0);
  let index = 0;
  while (index < total) {
    const sym = decodeSymbol(br, clcode);
    if (sym < 16) {
      lengths[index++] = sym;
    } else if (sym === 16) {
      const prev = lengths[index - 1];
      let rep = br.bits(2) + 3;
      while (rep-- > 0) lengths[index++] = prev;
    } else if (sym === 17) {
      let rep = br.bits(3) + 3;
      while (rep-- > 0) lengths[index++] = 0;
    } else { // 18
      let rep = br.bits(7) + 11;
      while (rep-- > 0) lengths[index++] = 0;
    }
  }
  return {
    lencode: buildHuffman(lengths.slice(0, hlit)),
    distcode: buildHuffman(lengths.slice(hlit)),
  };
}

function storedBlock(br, out) {
  br.alignToByte();
  const len = br.bytes[br.pos] | (br.bytes[br.pos + 1] << 8);
  br.pos += 4; // LEN (2 bytes) + one's-complement NLEN (2 bytes), unchecked
  for (let i = 0; i < len; i++) out.push(br.bytes[br.pos++]);
}

function inflateBlockCodes(br, out, lencode, distcode) {
  for (;;) {
    const sym = decodeSymbol(br, lencode);
    if (sym < 256) {
      out.push(sym);
    } else if (sym === 256) {
      return;
    } else {
      const li = sym - 257;
      if (li >= LEN_BASE.length) throw new Error('inflate: bad length code');
      const len = LEN_BASE[li] + br.bits(LEN_EXTRA[li]);
      const dsym = decodeSymbol(br, distcode);
      if (dsym >= DIST_BASE.length) throw new Error('inflate: bad distance code');
      const dist = DIST_BASE[dsym] + br.bits(DIST_EXTRA[dsym]);
      let from = out.length - dist;
      if (from < 0) throw new Error('inflate: distance too far back');
      for (let i = 0; i < len; i++, from++) out.push(out[from]);
    }
  }
}

/** Inflate a raw (headerless) DEFLATE stream starting at `startByte`. */
export function inflateRaw(bytes, startByte = 0) {
  const br = new BitReader(bytes, startByte);
  const out = [];
  let final = 0;
  do {
    final = br.bits(1);
    const type = br.bits(2);
    if (type === 0) {
      storedBlock(br, out);
    } else if (type === 1) {
      const { lencode, distcode } = fixedTables();
      inflateBlockCodes(br, out, lencode, distcode);
    } else if (type === 2) {
      const { lencode, distcode } = dynamicTables(br);
      inflateBlockCodes(br, out, lencode, distcode);
    } else {
      throw new Error('inflate: invalid block type');
    }
  } while (!final);
  return Uint8Array.from(out);
}

/** Inflate gzip, zlib, or raw-deflate bytes, auto-detected by magic. */
export function inflateAuto(bytes) {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const flg = bytes[3];
    let pos = 10;
    if (flg & 0x04) { // FEXTRA
      const xlen = bytes[pos] | (bytes[pos + 1] << 8);
      pos += 2 + xlen;
    }
    if (flg & 0x08) { while (bytes[pos] !== 0) pos++; pos++; } // FNAME
    if (flg & 0x10) { while (bytes[pos] !== 0) pos++; pos++; } // FCOMMENT
    if (flg & 0x02) pos += 2; // FHCRC
    return inflateRaw(bytes, pos);
  }
  if ((bytes[0] & 0x0f) === 8 && ((bytes[0] << 8 | bytes[1]) % 31 === 0)) {
    let pos = 2;
    if (bytes[1] & 0x20) pos += 4; // FDICT
    return inflateRaw(bytes, pos);
  }
  return inflateRaw(bytes, 0); // assume raw deflate
}
