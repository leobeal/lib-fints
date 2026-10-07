/**
 * Byte handling without Node's `Buffer`.
 *
 * FinTS is a byte protocol in ISO-8859-1, and the parser keeps a message as a
 * "binary string": one character per byte, char code 0–255. Everything that crosses
 * the wire, or that carries a document in another encoding (a pain or camt file in
 * UTF-8), goes through here, so the library runs wherever `fetch`, `btoa`/`atob` and
 * `TextEncoder`/`TextDecoder` exist — Node, browsers and React Native's Hermes, which
 * has no `Buffer` and no ISO-8859-1 `TextDecoder`.
 */

const CHUNK = 0x8000;

/** One byte per character. A character above 255 keeps its low byte, as `Buffer.from(text, 'latin1')` does. */
export function toBytes(binary: string): Uint8Array {
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i) & 0xff;
	}
	return bytes;
}

/** One character per byte. Built in chunks: spreading a large array into `fromCharCode` overflows the stack. */
export function fromBytes(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return binary;
}

/** The UTF-8 bytes of a text, as a binary string — what a binary data element has to carry for a UTF-8 document. */
export function utf8ToBinary(text: string): string {
	return fromBytes(new TextEncoder().encode(text));
}

/** Reads a binary string as the UTF-8 bytes it holds. */
export function binaryToUtf8(binary: string): string {
	return new TextDecoder('utf-8').decode(toBytes(binary));
}

export function binaryToBase64(binary: string): string {
	return btoa(fromBytes(toBytes(binary)));
}

/** Banks wrap their base64 in line breaks now and then; not every `atob` skips them. */
export function base64ToBinary(base64: string): string {
	return atob(base64.replace(/\s+/g, ''));
}
