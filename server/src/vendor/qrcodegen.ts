/**
 * QR Code generator library (TypeScript)
 * 
 * Copyright (c) Project Nayuki. (MIT License)
 * https://www.nayuki.io/page/qr-code-generator-library
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 * - The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 * - The Software is provided "as is", without warranty of any kind, express or
 *   implied, including but not limited to the warranties of merchantability,
 *   fitness for a particular purpose and noninfringement. In no event shall the
 *   authors or copyright holders be liable for any claim, damages or other
 *   liability, whether in an action of contract, tort or otherwise, arising from,
 *   out of or in connection with the Software or the use or other dealings in the
 *   Software.
 */

export namespace qrcodegen {
  type bit = number;
  type byte = number;

  export class QrCode {
    public static encodeText(text: string, ecl: Ecc): QrCode {
      const segs: Array<QrSegment> = QrSegment.makeSegments(text);
      return QrCode.encodeSegments(segs, ecl);
    }

    public static encodeBinary(data: Readonly<Array<byte>>, ecl: Ecc): QrCode {
      const seg: QrSegment = QrSegment.makeBytes(data);
      return QrCode.encodeSegments([seg], ecl);
    }

    public static encodeSegments(
      segs: Readonly<Array<QrSegment>>,
      ecl: Ecc,
      minVersion: number = 1,
      maxVersion: number = 40,
      mask: number = -1,
      boostEcl: boolean = true
    ): QrCode {
      if (!(1 <= minVersion && minVersion <= maxVersion && maxVersion <= 40) || mask < -1 || mask > 7)
        throw new RangeError("Invalid value");

      let version: number;
      let dataUsedBits: number;
      for (version = minVersion; ; version++) {
        const dataCapacityBits: number = QrCode.getNumDataCodewords(version, ecl) * 8;
        const usedBits: number = QrSegment.getTotalBits(segs, version);
        if (usedBits <= dataCapacityBits) {
          dataUsedBits = usedBits;
          break;
        }
        if (version >= maxVersion)
          throw new RangeError("Data too long");
      }

      if (boostEcl) {
        for (const newEcl of [Ecc.MEDIUM, Ecc.QUARTILE, Ecc.HIGH]) {
          if (dataUsedBits <= QrCode.getNumDataCodewords(version, newEcl) * 8)
            ecl = newEcl;
        }
      }

      const bb: Array<bit> = [];
      for (const seg of segs) {
        appendBits(seg.mode.modeBits, 4, bb);
        appendBits(seg.numChars, seg.mode.numCharCountBits(version), bb);
        for (const b of seg.getData())
          bb.push(b);
      }

      const dataCapacityBits: number = QrCode.getNumDataCodewords(version, ecl) * 8;
      appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb);
      appendBits(0, (8 - bb.length % 8) % 8, bb);

      for (let padByte = 0xEC; bb.length < dataCapacityBits; padByte ^= 0xEC ^ 0x11)
        appendBits(padByte, 8, bb);

      const dataCodewords: Array<byte> = [];
      while (dataCodewords.length * 8 < bb.length)
        dataCodewords.push(0);
      bb.forEach((b: bit, i: number) =>
        dataCodewords[i >>> 3] |= b << (7 - (i & 7)));

      return new QrCode(version, ecl, dataCodewords, mask);
    }

    public readonly size: number;
    public readonly mask: number;
    private readonly modules: Array<Array<boolean>> = [];
    private readonly isFunction: Array<Array<boolean>> = [];

    public constructor(
      public readonly version: number,
      public readonly errorCorrectionLevel: Ecc,
      dataCodewords: Readonly<Array<byte>>,
      mask: number
    ) {
      if (version < 1 || version > 40)
        throw new RangeError("Version value out of range");
      if (mask < -1 || mask > 7)
        throw new RangeError("Mask value out of range");
      this.size = version * 4 + 17;

      const row: Array<boolean> = [];
      for (let i = 0; i < this.size; i++)
        row.push(false);
      for (let i = 0; i < this.size; i++) {
        this.modules.push(row.slice());
        this.isFunction.push(row.slice());
      }

      this.drawFunctionPatterns();
      const allCodewords: Array<byte> = this.addEccAndInterleave(dataCodewords);
      this.drawCodewords(allCodewords);

      if (mask === -1) {
        let minPenalty: number = 1000000000;
        for (let i = 0; i < 8; i++) {
          this.applyMask(i);
          this.drawFormatBits(i);
          const penalty: number = this.getPenaltyScore();
          if (penalty < minPenalty) {
            mask = i;
            minPenalty = penalty;
          }
          this.applyMask(i);
        }
      }
      this.mask = mask;
      this.applyMask(mask);
      this.drawFormatBits(mask);
      this.isFunction = [];
    }

    public getModule(x: number, y: number): boolean {
      return 0 <= x && x < this.size && 0 <= y && y < this.size && this.modules[y][x];
    }

    public toSvgString(border: number, lightColor: string = "#FFFFFF", darkColor: string = "#000000"): string {
      if (border < 0)
        throw new RangeError("Border must be non-negative");
      const parts: Array<string> = [];
      for (let y = 0; y < this.size; y++) {
        for (let x = 0; x < this.size; x++) {
          if (this.getModule(x, y))
            parts.push(`M${x + border},${y + border}h1v1h-1z`);
        }
      }
      const fullSize = this.size + border * 2;
      return `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 ${fullSize} ${fullSize}" stroke="none" shape-rendering="crispEdges">
  <rect width="100%" height="100%" fill="${lightColor}"/>
  <path d="${parts.join(" ")}" fill="${darkColor}"/>
</svg>
`;
    }

    private drawFunctionPatterns(): void {
      for (let i = 0; i < this.size; i++) {
        this.setFunctionModule(6, i, i % 2 === 0);
        this.setFunctionModule(i, 6, i % 2 === 0);
      }

      this.drawFinderPattern(3, 3);
      this.drawFinderPattern(this.size - 4, 3);
      this.drawFinderPattern(3, this.size - 4);

      const alignPatPos: Array<number> = this.getAlignmentPatternPositions();
      const numAlign: number = alignPatPos.length;
      for (let i = 0; i < numAlign; i++) {
        for (let j = 0; j < numAlign; j++) {
          if (!(i === 0 && j === 0 || i === 0 && j === numAlign - 1 || i === numAlign - 1 && j === 0))
            this.drawAlignmentPattern(alignPatPos[i], alignPatPos[j]);
        }
      }

      this.drawFormatBits(0);
      this.drawVersion();
    }

    private drawFormatBits(mask: number): void {
      const data: number = this.errorCorrectionLevel.formatBits << 3 | mask;
      let rem: number = data;
      for (let i = 0; i < 10; i++)
        rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = (data << 10 | rem) ^ 0x5412;

      for (let i = 0; i <= 5; i++)
        this.setFunctionModule(8, i, getBit(bits, i));
      this.setFunctionModule(8, 7, getBit(bits, 6));
      this.setFunctionModule(8, 8, getBit(bits, 7));
      this.setFunctionModule(7, 8, getBit(bits, 8));
      for (let i = 9; i < 15; i++)
        this.setFunctionModule(14 - i, 8, getBit(bits, i));

      for (let i = 0; i < 8; i++)
        this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
      for (let i = 8; i < 15; i++)
        this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
      this.setFunctionModule(8, this.size - 8, true);
    }

    private drawVersion(): void {
      if (this.version < 7)
        return;
      let rem: number = this.version;
      for (let i = 0; i < 12; i++)
        rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const bits: number = this.version << 12 | rem;

      for (let i = 0; i < 18; i++) {
        const color: boolean = getBit(bits, i);
        const a: number = this.size - 11 + i % 3;
        const b: number = Math.floor(i / 3);
        this.setFunctionModule(a, b, color);
        this.setFunctionModule(b, a, color);
      }
    }

    private drawFinderPattern(x: number, y: number): void {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist: number = Math.max(Math.abs(dx), Math.abs(dy));
          const xx: number = x + dx;
          const yy: number = y + dy;
          if (0 <= xx && xx < this.size && 0 <= yy && yy < this.size)
            this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }

    private drawAlignmentPattern(x: number, y: number): void {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++)
          this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }

    private setFunctionModule(x: number, y: number, isDark: boolean): void {
      this.modules[y][x] = isDark;
      this.isFunction[y][x] = true;
    }

    private addEccAndInterleave(data: Readonly<Array<byte>>): Array<byte> {
      const ver: number = this.version;
      const ecl: Ecc = this.errorCorrectionLevel;
      if (data.length !== QrCode.getNumDataCodewords(ver, ecl))
        throw new RangeError("Invalid argument");

      const numBlocks: number = QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
      const blockEccLen: number = QrCode.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver];
      const rawCodewords: number = Math.floor(QrCode.getNumRawDataModules(ver) / 8);
      const numShortBlocks: number = numBlocks - rawCodewords % numBlocks;
      const shortBlockLen: number = Math.floor(rawCodewords / numBlocks);

      const blocks: Array<Array<byte>> = [];
      const rsDiv: Array<byte> = QrCode.reedSolomonComputeDivisor(blockEccLen);
      for (let i = 0, k = 0; i < numBlocks; i++) {
        const dat: Array<byte> = data.slice(k, k + shortBlockLen - blockEccLen + (i >= numShortBlocks ? 1 : 0));
        k += dat.length;
        const ecc: Array<byte> = QrCode.reedSolomonComputeRemainder(dat, rsDiv);
        if (i < numShortBlocks)
          dat.push(0);
        blocks.push(dat.concat(ecc));
      }

      const result: Array<byte> = [];
      for (let i = 0; i < blocks[0].length; i++) {
        blocks.forEach((block, j) => {
          if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks)
            result.push(block[i]);
        });
      }
      return result;
    }

    private drawCodewords(data: Readonly<Array<byte>>): void {
      if (data.length !== Math.floor(QrCode.getNumRawDataModules(this.version) / 8))
        throw new RangeError("Invalid argument");
      let i: number = 0;

      for (let right = this.size - 1; right >= 1; right -= 2) {
        if (right === 6)
          right = 5;
        for (let vert = 0; vert < this.size; vert++) {
          for (let j = 0; j < 2; j++) {
            const x: number = right - j;
            const upward: boolean = ((right + 1) & 2) === 0;
            const y: number = upward ? this.size - 1 - vert : vert;
            if (!this.isFunction[y][x] && i < data.length * 8) {
              this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
              i++;
            }
          }
        }
      }
    }

    private applyMask(mask: number): void {
      if (mask < 0 || mask > 7)
        throw new RangeError("Mask out of range");
      for (let y = 0; y < this.size; y++) {
        for (let x = 0; x < this.size; x++) {
          let invert: boolean;
          switch (mask) {
            case 0:  invert = (x + y) % 2 === 0;                    break;
            case 1:  invert = y % 2 === 0;                          break;
            case 2:  invert = x % 3 === 0;                          break;
            case 3:  invert = (x + y) % 3 === 0;                    break;
            case 4:  invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
            case 5:  invert = x * y % 2 + x * y % 3 === 0;          break;
            case 6:  invert = (x * y % 2 + x * y % 3) % 2 === 0;    break;
            case 7:  invert = ((x + y) % 2 + x * y % 3) % 2 === 0;  break;
            default:  throw new Error("Unreachable");
          }
          if (!this.isFunction[y][x] && invert)
            this.modules[y][x] = !this.modules[y][x];
        }
      }
    }

    private getPenaltyScore(): number {
      let result: number = 0;

      for (let y = 0; y < this.size; y++) {
        let runColor = false;
        let runX = 0;
        const runHistory = [0, 0, 0, 0, 0, 0, 0];
        for (let x = 0; x < this.size; x++) {
          if (this.modules[y][x] === runColor) {
            runX++;
            if (runX === 5)
              result += QrCode.PENALTY_N1;
            else if (runX > 5)
              result++;
          } else {
            this.finderPenaltyAddHistory(runX, runHistory);
            if (!runColor)
              result += this.finderPenaltyCountPatterns(runHistory) * QrCode.PENALTY_N3;
            runColor = this.modules[y][x];
            runX = 1;
          }
        }
        result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * QrCode.PENALTY_N3;
      }

      for (let x = 0; x < this.size; x++) {
        let runColor = false;
        let runY = 0;
        const runHistory = [0, 0, 0, 0, 0, 0, 0];
        for (let y = 0; y < this.size; y++) {
          if (this.modules[y][x] === runColor) {
            runY++;
            if (runY === 5)
              result += QrCode.PENALTY_N1;
            else if (runY > 5)
              result++;
          } else {
            this.finderPenaltyAddHistory(runY, runHistory);
            if (!runColor)
              result += this.finderPenaltyCountPatterns(runHistory) * QrCode.PENALTY_N3;
            runColor = this.modules[y][x];
            runY = 1;
          }
        }
        result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * QrCode.PENALTY_N3;
      }

      for (let y = 0; y < this.size - 1; y++) {
        for (let x = 0; x < this.size - 1; x++) {
          const color: boolean = this.modules[y][x];
          if (color === this.modules[y][x + 1] &&
              color === this.modules[y + 1][x] &&
              color === this.modules[y + 1][x + 1])
            result += QrCode.PENALTY_N2;
        }
      }

      let dark: number = 0;
      for (const row of this.modules)
        dark = row.reduce((sum, color) => sum + (color ? 1 : 0), dark);
      const total: number = this.size * this.size;
      const k: number = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
      result += k * QrCode.PENALTY_N4;
      return result;
    }

    private getAlignmentPatternPositions(): Array<number> {
      if (this.version === 1)
        return [];
      const numAlign: number = Math.floor(this.version / 7) + 2;
      const step: number = (this.version === 32) ? 26 :
        Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
      const result: Array<number> = [6];
      for (let pos = this.size - 7; result.length < numAlign; pos -= step)
        result.splice(1, 0, pos);
      return result;
    }

    private static getNumRawDataModules(ver: number): number {
      if (ver < 1 || ver > 40)
        throw new RangeError("Version out of range");
      let result: number = (16 * ver + 128) * ver + 64;
      if (ver >= 2) {
        const numAlign: number = Math.floor(ver / 7) + 2;
        result -= (25 * numAlign - 10) * numAlign - 55;
        if (ver >= 7)
          result -= 36;
      }
      return result;
    }

    private static getNumDataCodewords(ver: number, ecl: Ecc): number {
      return Math.floor(QrCode.getNumRawDataModules(ver) / 8) -
        QrCode.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver] *
        QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
    }

    private static reedSolomonComputeDivisor(degree: number): Array<byte> {
      if (degree < 1 || degree > 255)
        throw new RangeError("Segment too long");
      const result: Array<byte> = [];
      for (let i = 0; i < degree - 1; i++)
        result.push(0);
      result.push(1);

      let root = 1;
      for (let i = 0; i < degree; i++) {
        for (let j = 0; j < result.length; j++) {
          result[j] = QrCode.reedSolomonMultiply(result[j], root);
          if (j + 1 < result.length)
            result[j] ^= result[j + 1];
        }
        root = QrCode.reedSolomonMultiply(root, 0x02);
      }
      return result;
    }

    private static reedSolomonComputeRemainder(data: Readonly<Array<byte>>, divisor: Readonly<Array<byte>>): Array<byte> {
      const result: Array<byte> = divisor.map(_ => 0);
      for (const b of data) {
        const factor: byte = b ^ (result.shift() as byte);
        result.push(0);
        divisor.forEach((coef, i) =>
          result[i] ^= QrCode.reedSolomonMultiply(coef, factor));
      }
      return result;
    }

    private static reedSolomonMultiply(x: byte, y: byte): byte {
      const bx = x & 0xFF;
      const by = y & 0xFF;
      let z: number = 0;
      for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 8) * 0x11D);
        z ^= ((by >>> i) & 1) * bx;
      }
      return (z & 0xFF) as byte;
    }

    private finderPenaltyAddHistory(currentRunLength: number, runHistory: Array<number>): void {
      if (runHistory[0] === 0)
        currentRunLength += this.size;
      runHistory.pop();
      runHistory.unshift(currentRunLength);
    }

    private finderPenaltyCountPatterns(runHistory: Readonly<Array<number>>): number {
      const n: number = runHistory[1];
      const core: boolean = n > 0 && runHistory[2] === n && runHistory[3] === n * 3 && runHistory[4] === n && runHistory[5] === n;
      return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0)
           + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
    }

    private finderPenaltyTerminateAndCount(currentRunColor: boolean, currentRunLength: number, runHistory: Array<number>): number {
      if (currentRunColor) {
        this.finderPenaltyAddHistory(currentRunLength, runHistory);
        currentRunLength = 0;
      }
      currentRunLength += this.size;
      this.finderPenaltyAddHistory(currentRunLength, runHistory);
      return this.finderPenaltyCountPatterns(runHistory);
    }

    private static readonly PENALTY_N1: number =  3;
    private static readonly PENALTY_N2: number =  3;
    private static readonly PENALTY_N3: number = 40;
    private static readonly PENALTY_N4: number = 10;

    private static readonly ECC_CODEWORDS_PER_BLOCK: Array<Array<number>> = [
      [-1,  7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
      [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
      [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
      [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    ];

    private static readonly NUM_ERROR_CORRECTION_BLOCKS: Array<Array<number>> = [
      [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8,  9,  9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
      [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
      [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
      [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
    ];
  }

  export class QrSegment {
    public static makeBytes(data: Readonly<Array<byte>>): QrSegment {
      const bb: Array<bit> = [];
      for (const b of data)
        appendBits(b, 8, bb);
      return new QrSegment(Mode.BYTE, data.length, bb);
    }

    public static makeNumeric(digits: string): QrSegment {
      if (!QrSegment.isNumeric(digits))
        throw new RangeError("String contains non-numeric characters");
      const bb: Array<bit> = [];
      for (let i = 0; i < digits.length; ) {
        const n: number = Math.min(digits.length - i, 3);
        appendBits(parseInt(digits.substr(i, n), 10), n * 3 + 1, bb);
        i += n;
      }
      return new QrSegment(Mode.NUMERIC, digits.length, bb);
    }

    public static makeAlphanumeric(text: string): QrSegment {
      if (!QrSegment.isAlphanumeric(text))
        throw new RangeError("String contains unencodable characters in alphanumeric mode");
      const bb: Array<bit> = [];
      let i: number;
      for (i = 0; i + 2 <= text.length; i += 2) {
        const temp: number = QrSegment.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)) * 45
          + QrSegment.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i + 1));
        appendBits(temp, 11, bb);
      }
      if (i < text.length)
        appendBits(QrSegment.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)), 6, bb);
      return new QrSegment(Mode.ALPHANUMERIC, text.length, bb);
    }

    public static makeSegments(text: string): Array<QrSegment> {
      if (text === "")
        return [];
      if (QrSegment.isNumeric(text))
        return [QrSegment.makeNumeric(text)];
      if (QrSegment.isAlphanumeric(text))
        return [QrSegment.makeAlphanumeric(text)];
      return [QrSegment.makeBytes(QrSegment.toUtf8ByteArray(text))];
    }

    public static isNumeric(text: string): boolean {
      return /^[0-9]*$/.test(text);
    }

    public static isAlphanumeric(text: string): boolean {
      return /^[A-Z0-9 $%*+.\/:-]*$/.test(text);
    }

    public constructor(
      public readonly mode: Mode,
      public readonly numChars: number,
      private readonly bitData: Array<bit>
    ) {
      if (numChars < 0)
        throw new RangeError("Invalid argument");
      this.bitData = bitData.slice();
    }

    public getData(): Array<bit> {
      return this.bitData.slice();
    }

    public static getTotalBits(segs: Readonly<Array<QrSegment>>, version: number): number {
      let result: number = 0;
      for (const seg of segs) {
        const ccbits: number = seg.mode.numCharCountBits(version);
        if (seg.numChars >= (1 << ccbits))
          return Infinity;
        result += 4 + ccbits + seg.bitData.length;
      }
      return result;
    }

    private static toUtf8ByteArray(str: string): Array<byte> {
      str = encodeURI(str);
      const result: Array<byte> = [];
      for (let i = 0; i < str.length; i++) {
        if (str.charAt(i) !== "%")
          result.push(str.charCodeAt(i));
        else {
          result.push(parseInt(str.substr(i + 1, 2), 16));
          i += 2;
        }
      }
      return result;
    }

    private static readonly ALPHANUMERIC_CHARSET: string = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
  }

  export class Ecc {
    public static readonly LOW      = new Ecc(0, 1);
    public static readonly MEDIUM   = new Ecc(1, 0);
    public static readonly QUARTILE = new Ecc(2, 3);
    public static readonly HIGH     = new Ecc(3, 2);

    private constructor(
      public readonly ordinal: number,
      public readonly formatBits: number
    ) {}
  }

  export class Mode {
    public static readonly NUMERIC      = new Mode(0x1, [10, 12, 14]);
    public static readonly ALPHANUMERIC = new Mode(0x2, [ 9, 11, 13]);
    public static readonly BYTE         = new Mode(0x4, [ 8, 16, 16]);
    public static readonly KANJI        = new Mode(0x8, [ 8, 10, 12]);
    public static readonly ECI          = new Mode(0x7, [ 0,  0,  0]);

    private constructor(
      public readonly modeBits: number,
      private readonly numBitsCharCount: [number, number, number]
    ) {}

    public numCharCountBits(ver: number): number {
      return this.numBitsCharCount[Math.floor((ver + 7) / 17)];
    }
  }

  function appendBits(val: number, len: number, bb: Array<bit>): void {
    if (len < 0 || len > 31 || val >>> len !== 0)
      throw new RangeError("Value out of range");
    for (let i = len - 1; i >= 0; i--)
      bb.push((val >>> i) & 1);
  }

  function getBit(x: number, i: number): boolean {
    return ((x >>> i) & 1) !== 0;
  }
}
