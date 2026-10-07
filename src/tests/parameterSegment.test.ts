import { describe, expect, it } from 'vitest';
import { decode } from '../segment.js';
import { registerSegments } from '../segments/registry.js';
import type { UnknownSegment } from '../unknownSegment.js';

registerSegments();

describe('a parameter segment the library cannot read', () => {
	it('is kept unread instead of failing the message', () => {
		// "X" where the specification allows J or N.
		const segment = decode(
			"HICAZS:16:1:4+1+1+0+450:X:N:urn?:iso?:std?:iso?:20022?:tech?:xsd?:camt.052.001.08'",
		) as UnknownSegment;

		expect(segment.header.segId).toBe('UNKNOW');
		expect(segment.originalId).toBe('HICAZS');
		expect(segment.header.version).toBe(1);
	});

	it('still fails where it is not a parameter segment', () => {
		expect(() => decode("HKCAZ:3:1+DE89370400440532013000+urn?:x+X'")).toThrow();
	});
});
