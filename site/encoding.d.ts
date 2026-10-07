// Типы для site/encoding.js (его импортируют тесты на TypeScript).
export declare const ENCODINGS: string[];
export declare const LEGACY_GUESS: string;
export declare function detectEncoding(bytes: Uint8Array | ArrayBuffer): string;
export declare function decodeBytes(bytes: Uint8Array | ArrayBuffer, encoding: string): string;
export declare function isUnicode(encoding: string): boolean;
export declare function looksBinary(bytes: Uint8Array | ArrayBuffer): boolean;
