import { describe, expect, it } from 'vitest';
import {
	base64ToBinary,
	binaryToBase64,
	binaryToUtf8,
	fromBytes,
	toBytes,
	utf8ToBinary,
} from '../bytes.js';

describe('bytes', () => {
	it('carries a latin1 message through base64 the way Buffer does', () => {
		const message = "HKIDN:3:2+280:12345678+Müller+0+1'";

		expect(binaryToBase64(message)).toBe(Buffer.from(message, 'latin1').toString('base64'));
		expect(base64ToBinary(binaryToBase64(message))).toBe(message);
	});

	it('reads base64 a bank broke into lines', () => {
		const base64 = Buffer.from('HNHBK:1:3+000000000042', 'latin1').toString('base64');
		const wrapped = `${base64.slice(0, 10)}\r\n${base64.slice(10)}\n`;

		expect(base64ToBinary(wrapped)).toBe('HNHBK:1:3+000000000042');
	});

	it('turns a UTF-8 document into one character per byte, and back', () => {
		const text = 'Jürgen Größe zahlt 5 €';
		const binary = utf8ToBinary(text);

		expect(binary.length).toBe(Buffer.byteLength(text, 'utf8'));
		expect([...binary].every((char) => char.charCodeAt(0) <= 0xff)).toBe(true);
		expect(binaryToUtf8(binary)).toBe(text);
	});

	it('survives a payload larger than one chunk', () => {
		const bytes = new Uint8Array(200_000).map((_, i) => i % 256);

		expect(toBytes(fromBytes(bytes))).toEqual(bytes);
	});
});
