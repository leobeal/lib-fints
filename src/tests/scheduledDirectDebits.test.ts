import { describe, expect, it } from 'vitest';
import { decode, encode } from '../segment.js';
import { registerSegments } from '../segments/registry.js';
import type { HIDMBSegment, HKDMBSegment } from '../segments/scheduledDirectDebits.js';

registerSegments();

describe('scheduled collective direct debits', () => {
	it('asks for what the bank holds on an account, with a period', () => {
		const segment: HKDMBSegment = {
			header: { segId: 'HKDMB', segNr: 3, version: 1 },
			account: { iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' },
			from: new Date('2026-10-01'),
			to: new Date('2026-10-31'),
		};

		expect(encode(segment)).toBe("HKDMB:3:1+DE89370400440532013000:COBADEFFXXX+20261001+20261031'");
	});

	it('reads an order the bank holds', () => {
		const held = decode(
			"HIDMB:5:1:3+ORDER-17+DE89370400440532013000:COBADEFFXXX+20261007+20261009+3+922,09:EUR'",
		) as HIDMBSegment;

		expect(held.orderId).toBe('ORDER-17');
		expect(held.account.iban).toBe('DE89370400440532013000');
		expect(held.execution).toEqual(new Date('2026-10-09'));
		expect(held.count).toBe(3);
		expect(held.total).toEqual({ value: 922.09, currency: 'EUR' });
	});

	it('reads an order the bank gives no id or dates for', () => {
		const held = decode("HIDMB:5:1:3++DE89370400440532013000+++1+10,:EUR'") as HIDMBSegment;

		expect(held.orderId).toBeUndefined();
		expect(held.count).toBe(1);
		expect(held.total.value).toBe(10);
	});
});
