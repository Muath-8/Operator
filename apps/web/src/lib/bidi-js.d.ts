declare module 'bidi-js' {
  export default function bidiFactory(): {
    getEmbeddingLevels(
      text: string,
      direction?: 'ltr' | 'rtl',
    ): { levels: Uint8Array; paragraphs: { start: number; end: number; level: number }[] };
    getReorderSegments(
      text: string,
      levels: { levels: Uint8Array; paragraphs: { start: number; end: number; level: number }[] },
      start?: number,
      end?: number,
    ): [number, number][];
    getMirroredCharactersMap(
      text: string,
      levels: { levels: Uint8Array; paragraphs: { start: number; end: number; level: number }[] },
    ): Map<number, string>;
  };
}
